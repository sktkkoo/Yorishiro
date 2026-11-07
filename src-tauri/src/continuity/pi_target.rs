//! Portable identities for managed Pi work. OS paths are materialized at execution.
use super::pi_executor::{AuthMode, Permissions, Target};
use super::pi_installation::{PortablePermissions, RuntimePaths, Settings};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

const INVALID: &str = "The saved Pi installation identity is invalid.";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ManagedTarget {
    pub version: u32,
    pub runtime: String,
    pub runtime_version: String,
    pub workspace_key: String,
    pub family_key: String,
    pub state_key: String,
    pub generation: u64,
    pub provider: String,
    pub model: String,
    pub auth_mode: String,
    pub permissions: PortablePermissions,
}

fn hexadecimal(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(super) fn workspace_key(cwd: &Path) -> Result<String, String> {
    let cwd = cwd
        .canonicalize()
        .map_err(|_| "The original Pi workspace is unavailable.")?;
    let path = cwd.to_str().ok_or(INVALID)?;
    Ok(format!("{:x}", Sha256::digest(path.as_bytes())))
}

impl ManagedTarget {
    pub(super) fn audit_storage_ref(&self, generation: u64) -> String {
        format!("pi-state:{}:{generation}", self.state_key)
    }
    pub(super) fn matches_settings(&self, settings: &Settings) -> bool {
        settings.enabled
            && settings.provider == self.provider
            && settings.model == self.model
            && settings.auth_mode == self.auth_mode
            && settings.permissions == self.permissions
            && settings.workspace_key.as_deref() == Some(self.workspace_key.as_str())
    }
    fn settings(&self) -> Settings {
        Settings {
            version: 2,
            enabled: true,
            workspace_key: Some(self.workspace_key.clone()),
            provider: self.provider.clone(),
            model: self.model.clone(),
            auth_mode: self.auth_mode.clone(),
            permissions: self.permissions.clone(),
        }
    }
    fn validate(&self) -> Result<(), String> {
        if self.version != 2
            || self.runtime != "bundled"
            || self.runtime_version != "pi-1.5.0/node-22.23.4"
            || !hexadecimal(&self.family_key)
            || !hexadecimal(&self.workspace_key)
            || !hexadecimal(&self.state_key)
            || self.generation > 9_007_199_254_740_991
        {
            return Err(INVALID.into());
        }
        self.settings().validate().map_err(|_| INVALID.into())
    }
    pub(super) fn session_path(&self, home: &Path) -> PathBuf {
        let root = home.join("continuity/pi").join(&self.state_key);
        if self.generation == 0 {
            root
        } else {
            root.join("generations").join(self.generation.to_string())
        }
    }
    pub(super) fn hydrate(
        &self,
        runtime: &RuntimePaths,
        home: &Path,
        cwd: &Path,
    ) -> Result<Target, String> {
        self.validate()?;
        if self.runtime_version != runtime.version || workspace_key(cwd)? != self.workspace_key {
            return Err(
                "The original Pi workspace or runtime identity changed; no work was sent.".into(),
            );
        }
        let cwd = cwd.canonicalize().map_err(|_| INVALID)?;
        let target = Target {
            cwd: cwd.to_str().ok_or(INVALID)?.into(),
            session_dir: self.session_path(home).to_str().ok_or(INVALID)?.into(),
            node_path: runtime.node.to_str().ok_or(INVALID)?.into(),
            worker_entry: runtime.worker.to_str().ok_or(INVALID)?.into(),
            provider: self.provider.clone(),
            model: self.model.clone(),
            auth_mode: AuthMode::Oauth,
            auth_path: Some(
                super::pi_installation::auth_path(home)
                    .to_str()
                    .ok_or(INVALID)?
                    .into(),
            ),
            permissions: Some(super::pi_installation::resolved_permissions(
                &self.settings(),
                runtime,
            )?),
            managed: Some(Box::new(self.clone())),
        };
        target.validate()?;
        Ok(target)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacyTarget {
    cwd: String,
    session_dir: String,
    node_path: String,
    worker_entry: String,
    provider: String,
    model: String,
    #[serde(default, skip_serializing_if = "api_key")]
    auth_mode: AuthMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    auth_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    permissions: Option<Permissions>,
}
fn api_key(mode: &AuthMode) -> bool {
    *mode == AuthMode::ApiKey
}
impl From<&Target> for LegacyTarget {
    fn from(t: &Target) -> Self {
        Self {
            cwd: t.cwd.clone(),
            session_dir: t.session_dir.clone(),
            node_path: t.node_path.clone(),
            worker_entry: t.worker_entry.clone(),
            provider: t.provider.clone(),
            model: t.model.clone(),
            auth_mode: t.auth_mode,
            auth_path: t.auth_path.clone(),
            permissions: t.permissions.clone(),
        }
    }
}
impl Serialize for Target {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match &self.managed {
            Some(identity) => identity.serialize(serializer),
            None => LegacyTarget::from(self).serialize(serializer),
        }
    }
}
impl<'de> Deserialize<'de> for Target {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = serde_json::Value::deserialize(deserializer)?;
        if value.get("version").is_some() || value.get("runtime").is_some() {
            let identity: ManagedTarget =
                serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            identity.validate().map_err(serde::de::Error::custom)?;
            let home = crate::yorishiro_home_path().map_err(serde::de::Error::custom)?;
            Ok(Self {
                cwd: format!("workspace:{}", identity.workspace_key),
                session_dir: identity.session_path(&home).to_string_lossy().into_owned(),
                node_path: String::new(),
                worker_entry: String::new(),
                provider: identity.provider.clone(),
                model: identity.model.clone(),
                auth_mode: AuthMode::Oauth,
                auth_path: None,
                permissions: None,
                managed: Some(Box::new(identity)),
            })
        } else {
            let v: LegacyTarget =
                serde_json::from_value(value).map_err(serde::de::Error::custom)?;
            Ok(Self {
                cwd: v.cwd,
                session_dir: v.session_dir,
                node_path: v.node_path,
                worker_entry: v.worker_entry,
                provider: v.provider,
                model: v.model,
                auth_mode: v.auth_mode,
                auth_path: v.auth_path,
                permissions: v.permissions,
                managed: None,
            })
        }
    }
}
impl PartialEq for Target {
    fn eq(&self, other: &Self) -> bool {
        match (&self.managed, &other.managed) {
            (Some(a), Some(b)) => a == b,
            (None, None) => LegacyTarget::from(self) == LegacyTarget::from(other),
            _ => false,
        }
    }
}
impl Eq for Target {}

impl Target {
    pub(super) fn audit_storage_ref(&self) -> String {
        match &self.managed {
            Some(identity) => identity.audit_storage_ref(identity.generation),
            None => self.session_dir.clone(),
        }
    }
    pub(super) fn from_managed(
        settings: &Settings,
        runtime: &RuntimePaths,
        home: &Path,
        cwd: &Path,
        family_key: String,
        state_key: String,
        generation: usize,
    ) -> Result<Self, String> {
        settings.validate()?;
        let identity = ManagedTarget {
            version: 2,
            runtime: "bundled".into(),
            runtime_version: runtime.version.clone(),
            workspace_key: workspace_key(cwd)?,
            family_key,
            state_key,
            generation: generation as u64,
            provider: settings.provider.clone(),
            model: settings.model.clone(),
            auth_mode: settings.auth_mode.clone(),
            permissions: settings.permissions.clone(),
        };
        identity.hydrate(runtime, home, cwd)
    }
    pub(super) fn hydrate_runtime(
        &self,
        runtime: &RuntimePaths,
        home: &Path,
        cwd: &Path,
    ) -> Result<Self, String> {
        match &self.managed {
            Some(identity) => identity.hydrate(runtime, home, cwd),
            None => Ok(self.clone()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::pi_installation::{CommandPreset, PortablePermissions};
    use super::*;
    fn runtime(root: &Path) -> RuntimePaths {
        let binaries = root.join("App With Spaces.app/Contents/MacOS");
        let worker = root.join("App With Spaces.app/Contents/Resources/resources/pi-worker");
        std::fs::create_dir_all(&binaries).unwrap();
        std::fs::create_dir_all(&worker).unwrap();
        let node = binaries.join("yorishiro-pi-node");
        std::fs::write(&node, b"fixture").unwrap();
        for file in [
            "main.mjs",
            "workspace-check.mjs",
            "diagnose.mjs",
            "auth-main.mjs",
        ] {
            std::fs::write(worker.join(file), b"fixture").unwrap();
        }
        RuntimePaths {
            node,
            worker: worker.join("main.mjs"),
            diagnostic: worker.join("diagnose.mjs"),
            auth_entry: worker.join("auth-main.mjs"),
            manifest_fingerprint: "a".repeat(64),
            version: "pi-1.5.0/node-22.23.4".into(),
        }
    }
    #[test]
    fn managed_targets_and_outboxes_survive_app_relocation_without_saving_paths() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let workspace = base.join("User Project");
        std::fs::create_dir(&workspace).unwrap();
        let home = base.join("User Data");
        std::fs::create_dir(&home).unwrap();
        let a = runtime(&base.join("Original install"));
        let b = runtime(&base.join("Moved install"));
        let settings = Settings {
            enabled: true,
            permissions: PortablePermissions {
                read: true,
                write: false,
                commands: vec![CommandPreset::ValidateJson],
            },
            ..Settings::default()
        };
        let original = Target::from_managed(
            &settings,
            &a,
            &home,
            &workspace,
            "c".repeat(64),
            "b".repeat(64),
            2,
        )
        .unwrap();
        let encoded = serde_json::to_string(&original).unwrap();
        assert!(!encoded.contains(base.to_str().unwrap()));
        for key in [
            "nodePath",
            "workerEntry",
            "authPath",
            "sessionDir",
            "cwd",
            "program",
        ] {
            assert!(!encoded.contains(&format!("\"{key}\"")));
        }
        let decoded: Target = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded, original);
        let moved = decoded.hydrate_runtime(&b, &home, &workspace).unwrap();
        assert_eq!(serde_json::to_string(&moved).unwrap(), encoded);
        assert_ne!(original.node_path, moved.node_path);
        let handoff = super::super::ContextHandoff {
            from_request_id: None,
            to_request_id: "relocated-request".into(),
            at: 1,
            reason: "settled_context_rotation".into(),
            from_session_dir: Some(original.managed.as_ref().unwrap().audit_storage_ref(0)),
            to_session_dir: moved.audit_storage_ref(),
        };
        assert_eq!(original.audit_storage_ref(), handoff.to_session_dir);
        assert_eq!(
            handoff.to_session_dir,
            format!("pi-state:{}:2", "b".repeat(64))
        );
        let handoff_json = serde_json::to_string(&handoff).unwrap();
        assert!(!handoff_json.contains(base.to_str().unwrap()));
        assert!(!handoff_json.contains("User Data"));
        assert_eq!(
            moved.permissions.as_ref().unwrap().commands[0].program,
            moved.node_path
        );
        std::fs::create_dir_all(&original.session_dir).unwrap();
        let identity=super::super::pi_outbox::admission(&serde_json::json!({"admission":{"version":1,"epoch":uuid::Uuid::new_v4().to_string(),"rootId":9}})).unwrap().unwrap();
        let mut request = super::super::executor::Request {
            id: uuid::Uuid::new_v4().to_string(),
            prompt: "Original authorized work".into(),
            schema: serde_json::json!({"type":"object"}),
            persisted_payload: None,
            allow_dispatch: true,
        };
        super::super::pi_outbox::prepare(&original, false, &request, &identity).unwrap();
        request.allow_dispatch = false;
        let recovered =
            super::super::pi_outbox::prepare(&moved, false, &request, &identity).unwrap();
        assert_eq!(recovered["message"], request.prompt);
        request.prompt = "Different work".into();
        assert!(super::super::pi_outbox::prepare(&moved, false, &request, &identity).is_err());
    }
    #[test]
    fn managed_identity_rejects_traversal_unknown_versions_and_workspace_changes() {
        let dir = tempfile::tempdir().unwrap();
        let base = dir.path().canonicalize().unwrap();
        let app = runtime(&base);
        let settings = Settings {
            enabled: true,
            ..Settings::default()
        };
        let target = Target::from_managed(
            &settings,
            &app,
            &base,
            &base,
            "c".repeat(64),
            "b".repeat(64),
            0,
        )
        .unwrap();
        let value = serde_json::to_value(&target).unwrap();
        for (key, bad) in [
            ("stateKey", serde_json::json!("../../outside")),
            ("runtime", serde_json::json!("system-node")),
            ("version", serde_json::json!(3)),
            ("nodePath", serde_json::json!("/untrusted/program")),
        ] {
            let mut altered = value.clone();
            altered[key] = bad;
            assert!(serde_json::from_value::<Target>(altered).is_err());
        }
        let other = base.join("Another project");
        std::fs::create_dir(&other).unwrap();
        assert!(target.hydrate_runtime(&app, &base, &other).is_err());
    }
}

#[cfg(test)]
mod policy_tests {
    use super::*;
    #[test]
    fn dispatch_authorization_rejects_permission_downgrades_and_workspace_switches() {
        let identity = ManagedTarget {
            version: 2,
            runtime: "bundled".into(),
            runtime_version: "pi-1.5.0/node-22.23.4".into(),
            workspace_key: "a".repeat(64),
            family_key: "b".repeat(64),
            state_key: "c".repeat(64),
            generation: 0,
            provider: "openai".into(),
            model: "gpt-6.1-sol".into(),
            auth_mode: "oauth".into(),
            permissions: PortablePermissions {
                read: true,
                write: true,
                commands: vec![],
            },
        };
        let original = identity.settings();
        assert!(identity.matches_settings(&original));
        let mut narrowed = original.clone();
        narrowed.permissions.write = false;
        assert!(!identity.matches_settings(&narrowed));
        let mut switched = original.clone();
        switched.workspace_key = Some("d".repeat(64));
        assert!(!identity.matches_settings(&switched));
        let mut model = original.clone();
        model.model = "another-model".into();
        assert!(!identity.matches_settings(&model));
        let mut disabled = original;
        disabled.enabled = false;
        assert!(!identity.matches_settings(&disabled));
    }
}
