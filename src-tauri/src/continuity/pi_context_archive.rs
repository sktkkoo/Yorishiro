//! Private native evidence for bounded model context; never rewrite accepted work.
use super::pi_executor::Target;
use super::types::{ExecutionReceipt, PendingExecution, Snapshot};
use serde_json::json;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

const MAX_ARCHIVE: usize = 16 * 1024 * 1024;
const MAX_UNSENT: usize = 2 * 1024 * 1024;
const STORAGE_ERROR: &str = "Could not preserve private Pi context evidence.";

fn valid_id(id: &str) -> Result<(), String> {
    let uuid = uuid::Uuid::parse_str(id).map_err(|_| STORAGE_ERROR.to_owned())?;
    if uuid.hyphenated().to_string() != id {
        return Err(STORAGE_ERROR.into());
    }
    Ok(())
}

fn check_private(path: &Path, directory: bool) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| STORAGE_ERROR.to_owned())?;
    if metadata.file_type().is_symlink()
        || (directory && !metadata.is_dir())
        || (!directory && !metadata.is_file())
    {
        return Err(STORAGE_ERROR.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(STORAGE_ERROR.into());
        }
    }
    if std::fs::canonicalize(path).map_err(|_| STORAGE_ERROR.to_owned())? != path {
        return Err(STORAGE_ERROR.into());
    }
    Ok(())
}

fn directory(target: &Target) -> Result<PathBuf, String> {
    let root = Path::new(&target.session_dir);
    if !root.is_absolute() {
        return Err(STORAGE_ERROR.into());
    }
    // Resolve the existing prefix before mkdir so an ancestor alias cannot
    // cause even directory creation outside the selected canonical storage.
    let mut existing = root;
    loop {
        match std::fs::symlink_metadata(existing) {
            Ok(metadata) => {
                if !metadata.is_dir()
                    || metadata.file_type().is_symlink()
                    || std::fs::canonicalize(existing).map_err(|_| STORAGE_ERROR.to_owned())?
                        != existing
                {
                    return Err(STORAGE_ERROR.into());
                }
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                existing = existing.parent().ok_or(STORAGE_ERROR)?;
            }
            Err(_) => return Err(STORAGE_ERROR.into()),
        }
    }
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(root).map_err(|_| STORAGE_ERROR.to_owned())?;
    check_private(root, true)?;
    let directory = root.join("native-context");
    builder
        .create(&directory)
        .map_err(|_| STORAGE_ERROR.to_owned())?;
    check_private(&directory, true)?;
    Ok(directory)
}

fn sync_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    std::fs::File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| STORAGE_ERROR.to_owned())?;
    Ok(())
}

fn optional_existing(path: &Path, maximum: usize) -> Result<Option<Vec<u8>>, String> {
    match std::fs::symlink_metadata(path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(STORAGE_ERROR.into()),
        Ok(_) => check_private(path, false)?,
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| STORAGE_ERROR.to_owned())?;
    let mut bytes = vec![];
    file.take(maximum as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| STORAGE_ERROR.to_owned())?;
    if bytes.len() > maximum {
        return Err(STORAGE_ERROR.into());
    }
    Ok(Some(bytes))
}

fn temporary(directory: &Path, bytes: &[u8]) -> Result<tempfile::NamedTempFile, String> {
    let mut file =
        tempfile::NamedTempFile::new_in(directory).map_err(|_| STORAGE_ERROR.to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| STORAGE_ERROR.to_owned())?;
    }
    file.write_all(bytes)
        .and_then(|()| file.as_file().sync_all())
        .map_err(|_| STORAGE_ERROR.to_owned())?;
    Ok(file)
}

/// Called only while creating a fresh native request, after prior work settled.
pub(super) fn prepare(
    target: &Target,
    request_id: &str,
    snapshot: &Snapshot,
    receipts: &[ExecutionReceipt],
) -> Result<(), String> {
    valid_id(request_id)?;
    let bytes = serde_json::to_vec(&json!({
        "version":1,"requestId":request_id,"snapshot":snapshot,"terminalReceipts":receipts,
    }))
    .map_err(|_| STORAGE_ERROR.to_owned())?;
    if bytes.len() > MAX_ARCHIVE {
        return Err("Pi context archive exceeds its bounded storage limit.".into());
    }
    let directory = directory(target)?;
    let path = directory.join("current.json");
    if let Some(existing) = optional_existing(&path, MAX_ARCHIVE)? {
        let previous: serde_json::Value =
            serde_json::from_slice(&existing).map_err(|_| STORAGE_ERROR.to_owned())?;
        if previous
            .get("requestId")
            .and_then(serde_json::Value::as_str)
            == Some(request_id)
        {
            // A request UUID identifies one exact context, including on retry.
            return if existing == bytes {
                Ok(())
            } else {
                Err("A Pi request's original context archive cannot be rewritten.".into())
            };
        }
    }
    temporary(&directory, &bytes)?
        .persist(&path)
        .map_err(|_| STORAGE_ERROR.to_owned())?;
    sync_directory(&directory)
}

/// Preserve the original unsent envelope before assigning a replacement ID.
pub(super) fn retire_unsent(target: &Target, work: &PendingExecution) -> Result<(), String> {
    valid_id(&work.request_id)?;
    if work.dispatch_attempted {
        return Err("Accepted Pi work cannot be replaced by a context handoff.".into());
    }
    if !matches!(&work.target, super::execution_target::ExecutionTarget::Pi(saved) if saved == target)
    {
        return Err("Unsent Pi context evidence must retain its original target.".into());
    }
    let bytes = serde_json::to_vec(work).map_err(|_| STORAGE_ERROR.to_owned())?;
    if bytes.len() > MAX_UNSENT {
        return Err("Unsent Pi request exceeds its bounded archive limit.".into());
    }
    let directory = directory(target)?;
    let path = directory.join(format!("unsent-{}.json", work.request_id));
    if let Some(existing) = optional_existing(&path, MAX_UNSENT)? {
        return if existing == bytes {
            Ok(())
        } else {
            Err(STORAGE_ERROR.into())
        };
    }
    match temporary(&directory, &bytes)?.persist_noclobber(&path) {
        Ok(_) => sync_directory(&directory),
        Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
            if optional_existing(&path, MAX_UNSENT)?.as_deref() == Some(bytes.as_slice()) {
                Ok(())
            } else {
                Err(STORAGE_ERROR.into())
            }
        }
        Err(_) => Err(STORAGE_ERROR.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    const NEXT: &str = "22222222-2222-4222-8222-222222222222";

    fn target(root: &Path) -> Target {
        serde_json::from_value(json!({
            "cwd":root.to_str().unwrap(),"sessionDir":root.join("session").to_str().unwrap(),
            "nodePath":"/usr/bin/node","workerEntry":"/runtime/main.mjs",
            "provider":"openai","model":"test-model",
        }))
        .unwrap()
    }
    fn work(target: &Target) -> PendingExecution {
        serde_json::from_value(json!({
            "requestId":ID,"createdAt":1,"target":{"backend":"pi","target":target},
            "context":{"personaId":"yori-en","personaName":"Yori","personaPrompt":"","language":"en","cwd":null},
            "prompt":"Original unsent payload 😀","requestPayload":"saved bytes", "trigger":"return",
            "correctionIds":[],"previousStep":null,"messageCount":1,"dispatchAttempted":false,
        }))
        .unwrap()
    }

    #[test]
    fn archive_is_exact_private_and_bounded_to_one_current_file() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let target = target(&root);
        let snapshot = Snapshot::new("yori-en");
        prepare(&target, ID, &snapshot, &[]).unwrap();
        let directory = Path::new(&target.session_dir).join("native-context");
        let path = directory.join("current.json");
        let first: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(first["snapshot"], serde_json::to_value(&snapshot).unwrap());
        assert_eq!(first["requestId"], ID);
        prepare(&target, ID, &snapshot, &[]).unwrap();
        let mut different = snapshot.clone();
        different.revision += 1;
        assert!(prepare(&target, ID, &different, &[]).is_err());
        check_private(Path::new(&target.session_dir), true).unwrap();
        check_private(&directory, true).unwrap();
        check_private(&path, false).unwrap();
        prepare(&target, NEXT, &snapshot, &[]).unwrap();
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 1);
        let second: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(second["requestId"], NEXT);
        let before = std::fs::read(&path).unwrap();
        let mut large = snapshot;
        large.next_step = Some("x".repeat(MAX_ARCHIVE));
        assert!(prepare(&target, ID, &large, &[]).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
    }

    #[test]
    fn retirement_preserves_original_unsent_identity_and_refuses_accepted_work() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let target = target(&root);
        let original = work(&target);
        retire_unsent(&target, &original).unwrap();
        retire_unsent(&target, &original).unwrap();
        let path = Path::new(&target.session_dir).join(format!("native-context/unsent-{ID}.json"));
        let before = std::fs::read(&path).unwrap();
        assert_eq!(before, serde_json::to_vec(&original).unwrap());
        let mut changed = original.clone();
        changed.prompt = "Changed".into();
        assert!(retire_unsent(&target, &changed).is_err());
        changed = original;
        changed.dispatch_attempted = true;
        assert!(retire_unsent(&target, &changed).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), before);
        changed.request_id = "../../elsewhere".into();
        assert!(retire_unsent(&target, &changed).is_err());
        let mut different_target = target.clone();
        different_target.model = "changed-model".into();
        assert!(retire_unsent(&different_target, &work(&target)).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn archive_refuses_public_paths_symlinks_and_aliased_ancestors() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let target = target(&root);
        let snapshot = Snapshot::new("yori-en");
        prepare(&target, ID, &snapshot, &[]).unwrap();
        let directory = Path::new(&target.session_dir).join("native-context");
        let path = directory.join("current.json");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(prepare(&target, NEXT, &snapshot, &[]).is_err());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        let original = directory.join("original.json");
        std::fs::rename(&path, &original).unwrap();
        symlink(&original, &path).unwrap();
        assert!(prepare(&target, NEXT, &snapshot, &[]).is_err());
        let alias = root.join("alias");
        symlink(&root, &alias).unwrap();
        let mut other = target.clone();
        other.session_dir = alias.join("must-not-create").to_str().unwrap().into();
        assert!(prepare(&other, NEXT, &snapshot, &[]).is_err());
        assert!(!root.join("must-not-create").exists());
    }
}
