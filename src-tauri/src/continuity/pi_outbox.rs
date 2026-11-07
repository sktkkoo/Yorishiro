//! Immutable first-send evidence for retrying Pi's durable admission only.
//! A missing receipt alone never authorizes another submission.
use super::executor::Request;
use super::pi_executor::Target;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_INTENT: u64 = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Admission {
    version: u32,
    epoch: String,
    root_id: u64,
}

pub(super) fn admission(ready: &Value) -> Result<Option<Admission>, String> {
    let Some(value) = ready.get("admission") else {
        return Ok(None);
    };
    let identity: Admission = serde_json::from_value(value.clone())
        .map_err(|_| "Pi durable admission identity is invalid.".to_owned())?;
    if identity.version != 1
        || uuid::Uuid::parse_str(&identity.epoch).is_err()
        || identity.root_id == 0
        || identity.root_id > (1_u64 << 53) - 1
    {
        return Err("Pi durable admission identity is unsupported.".into());
    }
    Ok(Some(identity))
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Intent {
    version: u32,
    target: Target,
    fixture: bool,
    admission: Admission,
    request_id: String,
    message: String,
    output_schema: Value,
}

fn directory(target: &Target, create: bool) -> Result<Option<PathBuf>, String> {
    let root = std::fs::canonicalize(&target.session_dir)
        .map_err(|_| "Could not resolve Pi submission storage.".to_owned())?;
    let path = root.join("native-outbox");
    if create {
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(_) => return Err("Could not create Pi submission storage.".into()),
        }
    }
    match std::fs::symlink_metadata(&path) {
        Ok(metadata) => {
            if !metadata.file_type().is_dir()
                || std::fs::canonicalize(&path).ok().as_ref() != Some(&path)
            {
                return Err("Pi submission storage identity is invalid.".into());
            }
            Ok(Some(path))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err("Could not inspect Pi submission storage.".into()),
    }
}

fn load(path: &Path) -> Result<Option<Intent>, String> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {}
        Ok(_) => return Err("Pi submission evidence is invalid.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Could not inspect Pi submission evidence.".into()),
    }
    let file = std::fs::File::open(path)
        .map_err(|_| "Could not read Pi submission evidence.".to_owned())?;
    let mut bytes = Vec::new();
    file.take(MAX_INTENT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "Could not read Pi submission evidence.".to_owned())?;
    if bytes.len() as u64 > MAX_INTENT {
        return Err("Pi submission evidence exceeds the storage limit.".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| "Pi submission evidence is invalid.".into())
}

fn sync_directory(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    std::fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| "Could not commit Pi submission evidence.".to_owned())?;
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

/// Prepare the exact first payload before the host marks dispatch attempted.
/// Recovery requires both that saved payload and the same DB epoch/root/target.
pub(super) fn prepare(
    target: &Target,
    fixture: bool,
    request: &Request,
    admission: &Admission,
) -> Result<Value, String> {
    let directory = directory(target, request.allow_dispatch)?
        .ok_or("Pi has no saved submission evidence; it was not submitted again.")?;
    let path = directory.join(format!("{:x}.json", Sha256::digest(request.id.as_bytes())));
    let saved = match load(&path)? {
        Some(saved) => saved,
        None if !request.allow_dispatch => {
            return Err("Pi has no saved submission evidence; it was not submitted again.".into());
        }
        None => {
            let intended = Intent {
                version: 1,
                target: target.clone(),
                fixture,
                admission: admission.clone(),
                request_id: request.id.clone(),
                message: request.prompt.clone(),
                output_schema: request.schema.clone(),
            };
            let bytes = serde_json::to_vec(&intended)
                .map_err(|_| "Could not encode Pi submission evidence.".to_owned())?;
            if bytes.len() as u64 > MAX_INTENT {
                return Err("Pi submission exceeds the durable storage limit.".into());
            }
            let mut temporary = tempfile::NamedTempFile::new_in(&directory)
                .map_err(|_| "Could not prepare Pi submission evidence.".to_owned())?;
            temporary
                .write_all(&bytes)
                .and_then(|()| temporary.as_file().sync_all())
                .map_err(|_| "Could not commit Pi submission evidence.".to_owned())?;
            match temporary.persist_noclobber(&path) {
                Ok(_) => intended,
                Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                    load(&path)?.ok_or("Pi submission evidence changed during preparation.")?
                }
                Err(_) => return Err("Could not commit Pi submission evidence.".into()),
            }
        }
    };
    if saved.version != 1
        || saved.target != *target
        || saved.fixture != fixture
        || saved.admission != *admission
        || saved.request_id != request.id
        || saved.message != request.prompt
        || !saved.output_schema.is_object()
    {
        return Err("Pi submission evidence does not match the original request and storage; it was not submitted again.".into());
    }
    sync_directory(&directory)?;
    sync_directory(directory.parent().ok_or("Invalid Pi submission storage.")?)?;
    Ok(json!({
        "requestId": saved.request_id,
        "message": saved.message,
        "outputSchema": saved.output_schema,
        "admission": saved.admission,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(storage: &Path) -> Target {
        Target {
            managed: None,
            cwd: storage.to_str().unwrap().into(),
            session_dir: storage.to_str().unwrap().into(),
            node_path: "/runtime/node".into(),
            worker_entry: "/runtime/main.mjs".into(),
            provider: "configured-provider".into(),
            model: "configured-model".into(),
            auth_mode: super::super::pi_executor::AuthMode::ApiKey,
            auth_path: None,
            permissions: None,
        }
    }

    fn identity() -> Admission {
        Admission {
            version: 1,
            epoch: uuid::Uuid::new_v4().to_string(),
            root_id: 1,
        }
    }

    fn request(allow_dispatch: bool) -> Request {
        Request {
            id: "same-request".into(),
            prompt: "Original private work".into(),
            schema: json!({"type":"object","title":"original schema"}),
            persisted_payload: None,
            allow_dispatch,
        }
    }

    #[test]
    fn retry_reuses_the_immutable_first_payload_even_after_schema_generation_changes() {
        let storage = tempfile::tempdir().unwrap();
        let target = target(storage.path());
        let admission = identity();
        let original = prepare(&target, true, &request(true), &admission).unwrap();
        let mut recovery = request(false);
        recovery.schema = json!({"type":"object","title":"updated schema"});
        assert_eq!(
            prepare(&target, true, &recovery, &admission).unwrap(),
            original
        );
        recovery.prompt = "Changed private work".into();
        assert!(prepare(&target, true, &recovery, &admission).is_err());
        assert_eq!(
            prepare(&target, true, &request(false), &admission).unwrap(),
            original
        );
        assert_eq!(
            std::fs::read_dir(storage.path().join("native-outbox"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn legacy_missing_evidence_and_changed_storage_or_runtime_never_authorize_replay() {
        let storage = tempfile::tempdir().unwrap();
        let target = target(storage.path());
        let admission = identity();
        assert!(prepare(&target, false, &request(false), &admission).is_err());
        assert!(!storage.path().join("native-outbox").exists());
        prepare(&target, false, &request(true), &admission).unwrap();
        assert!(prepare(&target, false, &request(false), &identity()).is_err());
        let mut root_changed = admission.clone();
        root_changed.root_id = 2;
        assert!(prepare(&target, false, &request(false), &root_changed).is_err());
        let mut runtime_changed = target.clone();
        runtime_changed.worker_entry = "/different/main.mjs".into();
        assert!(prepare(&runtime_changed, false, &request(false), &admission).is_err());
        assert!(prepare(&target, true, &request(false), &admission).is_err());
    }

    #[test]
    fn malformed_or_partial_evidence_is_retained_and_never_overwritten() {
        let storage = tempfile::tempdir().unwrap();
        let target = target(storage.path());
        let admission = identity();
        prepare(&target, false, &request(true), &admission).unwrap();
        let path = std::fs::read_dir(storage.path().join("native-outbox"))
            .unwrap()
            .next()
            .unwrap()
            .unwrap()
            .path();
        std::fs::write(&path, b"partial PRIVATE_SENTINEL").unwrap();
        let error = prepare(&target, false, &request(true), &admission).unwrap_err();
        assert!(!error.contains("PRIVATE_SENTINEL"));
        assert_eq!(std::fs::read(&path).unwrap(), b"partial PRIVATE_SENTINEL");
        assert!(super::admission(
            &json!({"admission":{"version":2,"epoch":admission.epoch,"rootId":1}})
        )
        .is_err());
        assert!(super::admission(&json!({"protocol":2})).unwrap().is_none());
    }
}
