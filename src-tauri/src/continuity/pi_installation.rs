//! Managed Pi installation. User preferences contain choices, never executable paths.
use super::pi_executor::{AllowedCommand, Permissions};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tauri::Manager;
use tokio::io::AsyncReadExt;

const MAX_SETTINGS: u64 = 64 * 1024;
const MAX_MANIFEST: u64 = 4 * 1024 * 1024;
const NODE_VERSION: &str = "22.23.4";
const PI_VERSION: &str = "1.5.0";
const CONFIG_ERROR: &str = "configuration_invalid";
const RUNTIME_ERROR: &str = "runtime_invalid";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CommandPreset {
    WorkspaceInfo,
    ValidateJson,
}

impl CommandPreset {
    pub(super) fn id(&self) -> &'static str {
        match self {
            Self::WorkspaceInfo => "workspace-info",
            Self::ValidateJson => "validate-json",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PortablePermissions {
    pub read: bool,
    pub write: bool,
    pub commands: Vec<CommandPreset>,
}

impl Default for PortablePermissions {
    fn default() -> Self {
        Self {
            read: true,
            write: false,
            commands: vec![],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub version: u32,
    pub enabled: bool,
    pub provider: String,
    pub model: String,
    pub auth_mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_key: Option<String>,
    pub permissions: PortablePermissions,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 2,
            enabled: false,
            provider: "openai".into(),
            model: "gpt-6.1-sol".into(),
            auth_mode: "oauth".into(),
            workspace_key: None,
            permissions: PortablePermissions::default(),
        }
    }
}

impl Settings {
    pub(super) fn validate(&self) -> Result<(), String> {
        let model_valid = !self.model.is_empty()
            && self.model.len() <= 128
            && self.model.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            });
        let mut commands = BTreeSet::new();
        if self.version != 2
            || self.provider != "openai"
            || self.auth_mode != "oauth"
            || !model_valid
            || self.workspace_key.as_ref().is_some_and(|key| {
                key.len() != 64
                    || !key
                        .bytes()
                        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            })
            || self.permissions.commands.len() > 2
            || self
                .permissions
                .commands
                .iter()
                .any(|command| !commands.insert(command.id()))
        {
            return Err(CONFIG_ERROR.into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum ConfigState {
    Missing,
    Managed(Settings),
    Legacy,
}

fn private_regular(path: &Path, code: &str) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| code.to_owned())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() {
        return Err(code.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return Err(code.into());
        }
    }
    Ok(())
}

fn read_limited(path: &Path, maximum: u64, code: &str) -> Result<Vec<u8>, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| code.to_owned())?;
    if !file.metadata().map_err(|_| code.to_owned())?.is_file() {
        return Err(code.into());
    }
    let mut bytes = Vec::new();
    file.take(maximum + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| code.to_owned())?;
    if bytes.len() as u64 > maximum {
        return Err(code.into());
    }
    Ok(bytes)
}

pub(super) fn auth_path(home: &Path) -> PathBuf {
    home.join("continuity/pi/auth.json")
}

pub(super) fn load(home: &Path) -> Result<ConfigState, String> {
    let path = home.join("continuity/pi-worker.json");
    match std::fs::symlink_metadata(&path) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ConfigState::Missing)
        }
        Err(_) => return Err(CONFIG_ERROR.into()),
        Ok(_) => private_regular(&path, CONFIG_ERROR)?,
    }
    let bytes = read_limited(&path, MAX_SETTINGS, CONFIG_ERROR)?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| CONFIG_ERROR.to_owned())?;
    if value.get("version").is_none()
        && value
            .get("nodePath")
            .and_then(serde_json::Value::as_str)
            .is_some()
        && value
            .get("workerEntry")
            .and_then(serde_json::Value::as_str)
            .is_some()
        && value
            .get("provider")
            .and_then(serde_json::Value::as_str)
            .is_some()
        && value
            .get("model")
            .and_then(serde_json::Value::as_str)
            .is_some()
        && value
            .get("permissions")
            .is_some_and(serde_json::Value::is_object)
    {
        // Existing accepted targets retain their original identity separately.
        // Merely reading an old configuration never grants new permissions.
        return Ok(ConfigState::Legacy);
    }
    let settings: Settings = serde_json::from_value(value).map_err(|_| CONFIG_ERROR.to_owned())?;
    settings.validate()?;
    Ok(ConfigState::Managed(settings))
}

/// Suggest prior capabilities for an explicit review. Never retain executable
/// paths, API credentials, arbitrary argv, automatic activation or custom auth paths.
pub(super) fn legacy_suggestion(home: &Path) -> Result<Settings, String> {
    if load(home)? != ConfigState::Legacy {
        return Err(CONFIG_ERROR.into());
    }
    let bytes = read_limited(
        &home.join("continuity/pi-worker.json"),
        MAX_SETTINGS,
        CONFIG_ERROR,
    )?;
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| CONFIG_ERROR.to_owned())?;
    let mut settings = Settings {
        permissions: PortablePermissions {
            read: value["permissions"]["read"].as_bool().unwrap_or(false),
            write: value["permissions"]["write"].as_bool().unwrap_or(false),
            commands: vec![],
        },
        ..Settings::default()
    };
    if value["provider"] == "openai" {
        if let Some(model) = value["model"].as_str() {
            let mut suggested = settings.clone();
            suggested.model = model.into();
            if suggested.validate().is_ok() {
                settings.model = suggested.model;
            }
        }
    }
    Ok(settings)
}

pub(super) fn save(home: &Path, settings: &Settings) -> Result<(), String> {
    settings.validate()?;
    let directory = home.join("continuity");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(&directory)
        .map_err(|_| CONFIG_ERROR.to_owned())?;
    let directory = directory
        .canonicalize()
        .map_err(|_| CONFIG_ERROR.to_owned())?;
    let path = directory.join("pi-worker.json");
    match std::fs::symlink_metadata(&path) {
        Ok(_) => private_regular(&path, CONFIG_ERROR)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return Err(CONFIG_ERROR.into()),
    }
    let bytes = serde_json::to_vec_pretty(settings).map_err(|_| CONFIG_ERROR.to_owned())?;
    let mut temporary =
        tempfile::NamedTempFile::new_in(&directory).map_err(|_| CONFIG_ERROR.to_owned())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temporary
            .as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| CONFIG_ERROR.to_owned())?;
    }
    temporary
        .write_all(&bytes)
        .and_then(|()| temporary.as_file().sync_all())
        .map_err(|_| CONFIG_ERROR.to_owned())?;
    temporary
        .persist(&path)
        .map_err(|_| CONFIG_ERROR.to_owned())?;
    #[cfg(unix)]
    std::fs::File::open(&directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| CONFIG_ERROR.to_owned())?;
    Ok(())
}

#[derive(Clone, Debug)]
pub(super) struct RuntimePaths {
    pub node: PathBuf,
    pub worker: PathBuf,
    pub diagnostic: PathBuf,
    pub auth_entry: PathBuf,
    pub manifest_fingerprint: String,
    pub version: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeManifest {
    version: u32,
    node_version: String,
    pi_version: String,
    target: String,
    node_archive_sha256: String,
    worker_lock_sha256: String,
    #[serde(default)]
    node_binary_sha256: Option<String>,
    files: BTreeMap<String, String>,
}

fn checksum(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn expected_target() -> Result<String, String> {
    let arch = std::env::consts::ARCH;
    match (std::env::consts::OS, arch) {
        ("macos", "aarch64" | "x86_64") => Ok(format!("{arch}-apple-darwin")),
        ("linux", "aarch64" | "x86_64") => Ok(format!("{arch}-unknown-linux-gnu")),
        _ => Err("runtime_unsupported".into()),
    }
}

fn resource_file(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.contains('\\')
        || relative
            .split('/')
            .any(|component| component.is_empty() || matches!(component, "." | ".."))
    {
        return Err(RUNTIME_ERROR.into());
    }
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(RUNTIME_ERROR.into());
    }
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        let metadata = std::fs::symlink_metadata(&path).map_err(|_| RUNTIME_ERROR.to_owned())?;
        if metadata.file_type().is_symlink() {
            return Err(RUNTIME_ERROR.into());
        }
    }
    if !path.is_file() {
        return Err(RUNTIME_ERROR.into());
    }
    Ok(path)
}

fn verify_runtime(worker_root: &Path, node: &Path, target: &str) -> Result<RuntimePaths, String> {
    let root = worker_root
        .canonicalize()
        .map_err(|_| "runtime_missing".to_owned())?;
    let node_metadata =
        std::fs::symlink_metadata(node).map_err(|_| "runtime_missing".to_owned())?;
    if !node_metadata.is_file() || node_metadata.file_type().is_symlink() {
        return Err(RUNTIME_ERROR.into());
    }
    let manifest_path = resource_file(&root, "manifest.json")?;
    let bytes = read_limited(&manifest_path, MAX_MANIFEST, RUNTIME_ERROR)?;
    let manifest: RuntimeManifest =
        serde_json::from_slice(&bytes).map_err(|_| RUNTIME_ERROR.to_owned())?;
    if manifest.version != 1
        || manifest.node_version != NODE_VERSION
        || manifest.pi_version != PI_VERSION
        || manifest.target != target
        || !checksum(&manifest.node_archive_sha256)
        || !checksum(&manifest.worker_lock_sha256)
        || manifest
            .node_binary_sha256
            .as_deref()
            .is_some_and(|value| !checksum(value))
        || manifest.files.is_empty()
        || manifest.files.len() > 20_000
    {
        return Err(RUNTIME_ERROR.into());
    }
    let mut total_bytes = 0_u64;
    for (name, expected) in &manifest.files {
        if name == "manifest.json" || !checksum(expected) {
            return Err(RUNTIME_ERROR.into());
        }
        let file = resource_file(&root, name)?;
        let length = std::fs::metadata(&file)
            .map_err(|_| RUNTIME_ERROR.to_owned())?
            .len();
        total_bytes = total_bytes.saturating_add(length);
        if length > 64 * 1024 * 1024 || total_bytes > 512 * 1024 * 1024 {
            return Err(RUNTIME_ERROR.into());
        }
        let mut reader = std::fs::File::open(file).map_err(|_| RUNTIME_ERROR.to_owned())?;
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 32 * 1024];
        loop {
            let count = reader
                .read(&mut buffer)
                .map_err(|_| RUNTIME_ERROR.to_owned())?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        if format!("{:x}", hash.finalize()) != *expected {
            return Err(RUNTIME_ERROR.into());
        }
    }
    for required in [
        "main.mjs",
        "diagnose.mjs",
        "auth-main.mjs",
        "workspace-check.mjs",
    ] {
        if !manifest.files.contains_key(required) {
            return Err(RUNTIME_ERROR.into());
        }
    }
    Ok(RuntimePaths {
        node: node.canonicalize().map_err(|_| RUNTIME_ERROR.to_owned())?,
        worker: resource_file(&root, "main.mjs")?,
        diagnostic: resource_file(&root, "diagnose.mjs")?,
        auth_entry: resource_file(&root, "auth-main.mjs")?,
        manifest_fingerprint: format!("{:x}", Sha256::digest(&bytes)),
        version: format!("pi-{PI_VERSION}/node-{NODE_VERSION}"),
    })
}

pub(super) fn runtime_paths(app: &tauri::AppHandle) -> Result<RuntimePaths, String> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(|_| "runtime_missing".to_owned())?;
    let executable = std::env::current_exe().map_err(|_| "runtime_missing".to_owned())?;
    runtime_paths_at(
        &resource,
        &executable,
        cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR"))),
    )
}

fn runtime_paths_at(
    resource: &Path,
    executable: &Path,
    development: Option<&Path>,
) -> Result<RuntimePaths, String> {
    let target = expected_target()?;
    let installed_node = executable
        .parent()
        .ok_or("runtime_missing")?
        .join("yorishiro-pi-node");
    let installed_root = resource.join("resources/pi-worker");
    if installed_root.exists() || (installed_node.exists() && development.is_none()) {
        // An invalid installed payload cannot silently become a source runtime.
        return verify_runtime(&installed_root, &installed_node, &target);
    }
    if let Some(development) = development {
        return verify_runtime(
            &development.join("resources/pi-worker"),
            &development
                .join("binaries")
                .join(format!("yorishiro-pi-node-{target}")),
            &target,
        );
    }
    Err("runtime_missing".into())
}

pub(super) async fn verify_node(runtime: &RuntimePaths) -> Result<(), String> {
    let mut child = tokio::process::Command::new(&runtime.node)
        .args(["--input-type=module", "--eval", "import {DatabaseSync} from 'node:sqlite'; console.log(JSON.stringify({version:process.versions.node,arch:process.arch,sqlite:typeof DatabaseSync==='function'}))"])
        .env_remove("NODE_OPTIONS").env_remove("NODE_PATH")
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true)
        .spawn().map_err(|_| "node_unavailable".to_owned())?;
    let stdout = child.stdout.take().ok_or("node_invalid")?;
    let mut output = vec![];
    let mut limited = stdout.take(1025);
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let (read, status) = tokio::join!(limited.read_to_end(&mut output), child.wait());
        read.map_err(|_| "node_invalid")?;
        if !status.map_err(|_| "node_invalid")?.success() || output.len() > 1024 {
            return Err("node_invalid");
        }
        let value: serde_json::Value =
            serde_json::from_slice(&output).map_err(|_| "node_invalid")?;
        let arch = match std::env::consts::ARCH {
            "aarch64" => "arm64",
            other => other,
        };
        let arch = if arch == "x86_64" { "x64" } else { arch };
        if value["version"] != NODE_VERSION || value["arch"] != arch || value["sqlite"] != true {
            return Err("node_invalid");
        }
        Ok(())
    })
    .await;
    match result {
        Ok(value) => value.map_err(str::to_owned),
        Err(_) => Err("node_unavailable".into()),
    }
}

pub(super) fn resolved_permissions(
    settings: &Settings,
    runtime: &RuntimePaths,
) -> Result<Permissions, String> {
    settings.validate()?;
    let script = runtime.worker.with_file_name("workspace-check.mjs");
    if !script.is_file() {
        return Err(RUNTIME_ERROR.into());
    }
    Ok(Permissions {
        read: settings.permissions.read,
        write: settings.permissions.write,
        commands: settings
            .permissions
            .commands
            .iter()
            .map(|preset| AllowedCommand {
                id: preset.id().into(),
                program: runtime.node.to_string_lossy().into_owned(),
                args: vec![script.to_string_lossy().into_owned(), preset.id().into()],
                timeout_ms: None,
            })
            .collect(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn private_json(path: &Path, value: &serde_json::Value) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, serde_json::to_vec(value).unwrap()).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    fn fixture_bundle(base: &Path) -> (PathBuf, PathBuf, RuntimeManifest) {
        let resource = base.join("Relocated App.app/Contents/Resources");
        let executable = base.join("Relocated App.app/Contents/MacOS/yorishiro");
        let worker = resource.join("resources/pi-worker");
        std::fs::create_dir_all(&worker).unwrap();
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, "native fixture").unwrap();
        std::fs::write(
            executable.with_file_name("yorishiro-pi-node"),
            "sidecar fixture",
        )
        .unwrap();
        let mut files = BTreeMap::new();
        for name in [
            "main.mjs",
            "diagnose.mjs",
            "auth-main.mjs",
            "workspace-check.mjs",
        ] {
            let bytes = format!("// fixture {name}\n");
            std::fs::write(worker.join(name), &bytes).unwrap();
            files.insert(
                name.into(),
                format!("{:x}", Sha256::digest(bytes.as_bytes())),
            );
        }
        let manifest = RuntimeManifest {
            version: 1,
            node_version: NODE_VERSION.into(),
            pi_version: PI_VERSION.into(),
            target: expected_target().unwrap(),
            node_archive_sha256: "a".repeat(64),
            worker_lock_sha256: "b".repeat(64),
            node_binary_sha256: Some("c".repeat(64)),
            files,
        };
        write_manifest(&worker, &manifest);
        (resource, executable, manifest)
    }

    fn write_manifest(worker: &Path, manifest: &RuntimeManifest) {
        let value = json!({"version":manifest.version,"nodeVersion":manifest.node_version,
            "piVersion":manifest.pi_version,"target":manifest.target,
            "nodeArchiveSha256":manifest.node_archive_sha256,"workerLockSha256":manifest.worker_lock_sha256,
            "nodeBinarySha256":manifest.node_binary_sha256,"files":manifest.files});
        std::fs::write(
            worker.join("manifest.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn fresh_home_status_is_read_only_and_has_no_granted_write_or_command_capabilities() {
        let parent = tempfile::tempdir().unwrap();
        let home = parent.path().join("New User Home/.yorishiro");
        assert_eq!(load(&home).unwrap(), ConfigState::Missing);
        assert!(!home.exists());
        let defaults = Settings::default();
        assert!(!defaults.enabled);
        assert!(defaults.permissions.read);
        assert!(!defaults.permissions.write);
        assert!(defaults.permissions.commands.is_empty());
    }

    #[test]
    fn settings_roundtrip_is_path_free_private_and_portable_to_a_new_home() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let settings = Settings {
            enabled: true,
            permissions: PortablePermissions {
                commands: vec![CommandPreset::WorkspaceInfo, CommandPreset::ValidateJson],
                ..PortablePermissions::default()
            },
            ..Settings::default()
        };
        save(first.path(), &settings).unwrap();
        let path = first.path().join("continuity/pi-worker.json");
        let bytes = std::fs::read(&path).unwrap();
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(!text.contains(first.path().to_str().unwrap()));
        for forbidden in ["nodePath", "workerEntry", "authPath", "program", "args"] {
            assert!(!text.contains(forbidden));
        }
        assert_eq!(
            load(first.path()).unwrap(),
            ConfigState::Managed(settings.clone())
        );
        private_json(
            &second.path().join("continuity/pi-worker.json"),
            &serde_json::from_slice(&bytes).unwrap(),
        );
        assert_eq!(load(second.path()).unwrap(), ConfigState::Managed(settings));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_ne!(auth_path(first.path()), auth_path(second.path()));
    }

    #[test]
    fn legacy_configuration_requires_explicit_review_and_drops_machine_paths() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("continuity/pi-worker.json");
        let legacy = json!({"nodePath":"old-machine-node","workerEntry":"old-machine-worker",
            "authPath":"old-private-auth","provider":"openai","model":"gpt-6.1-sol",
            "permissions":{"read":true,"write":true,"commands":[{"program":"old-command","args":["old-path"]}]}});
        private_json(&path, &legacy);
        let original = std::fs::read(&path).unwrap();
        assert_eq!(load(home.path()).unwrap(), ConfigState::Legacy);
        let suggested = legacy_suggestion(home.path()).unwrap();
        assert!(!suggested.enabled);
        assert!(suggested.permissions.write);
        assert!(suggested.permissions.commands.is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        save(home.path(), &suggested).unwrap();
        assert!(matches!(
            load(home.path()).unwrap(),
            ConfigState::Managed(_)
        ));
        assert!(!std::fs::read_to_string(&path).unwrap().contains("old-"));
    }

    #[test]
    fn present_invalid_settings_and_arbitrary_paths_never_become_defaults() {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("continuity/pi-worker.json");
        for field in ["nodePath", "workerEntry", "authPath", "program", "args"] {
            let mut value = serde_json::to_value(Settings::default()).unwrap();
            value[field] = json!("arbitrary-path");
            private_json(&path, &value);
            assert!(load(home.path()).is_err());
        }
        for model in [
            "",
            "../escape",
            "workspace/model",
            "model\0bad",
            "provider key value",
        ] {
            let settings = Settings {
                model: model.into(),
                ..Settings::default()
            };
            assert!(save(home.path(), &settings).is_err());
        }
        let settings = Settings {
            permissions: PortablePermissions {
                commands: vec![CommandPreset::ValidateJson, CommandPreset::ValidateJson],
                ..PortablePermissions::default()
            },
            ..Settings::default()
        };
        assert!(save(home.path(), &settings).is_err());
        let settings = Settings {
            auth_mode: "apiKey".into(),
            ..Settings::default()
        };
        assert!(save(home.path(), &settings).is_err());
        let settings = Settings {
            provider: "anthropic".into(),
            ..Settings::default()
        };
        assert!(save(home.path(), &settings).is_err());
        let mut value = serde_json::to_value(Settings::default()).unwrap();
        value["permissions"]["commands"] = json!(["arbitrary-script"]);
        private_json(&path, &value);
        assert!(load(home.path()).is_err());
    }

    #[test]
    fn bundled_runtime_resolves_from_relocated_app_with_spaces_and_without_source_checkout() {
        let root = tempfile::tempdir().unwrap();
        let (resources, executable, _) = fixture_bundle(root.path());
        let resolved = runtime_paths_at(&resources, &executable, None).unwrap();
        assert_eq!(
            resolved.node,
            executable
                .with_file_name("yorishiro-pi-node")
                .canonicalize()
                .unwrap()
        );
        assert_eq!(
            resolved.worker,
            resources
                .canonicalize()
                .unwrap()
                .join("resources/pi-worker/main.mjs")
        );
        assert_eq!(resolved.version, "pi-1.5.0/node-22.23.4");
        assert_eq!(resolved.manifest_fingerprint.len(), 64);
        let moved = tempfile::tempdir().unwrap();
        let (new_resources, new_executable, _) = fixture_bundle(moved.path());
        let relocated = runtime_paths_at(&new_resources, &new_executable, None).unwrap();
        assert_ne!(relocated.node, resolved.node);
        assert_eq!(
            relocated.manifest_fingerprint,
            resolved.manifest_fingerprint
        );
    }

    #[test]
    fn bundled_command_presets_resolve_only_fixed_scripts_in_the_current_bundle() {
        let root = tempfile::tempdir().unwrap();
        let (resources, executable, _) = fixture_bundle(root.path());
        let runtime = runtime_paths_at(&resources, &executable, None).unwrap();
        let settings = Settings {
            permissions: PortablePermissions {
                commands: vec![CommandPreset::WorkspaceInfo, CommandPreset::ValidateJson],
                ..PortablePermissions::default()
            },
            ..Settings::default()
        };
        let permissions = resolved_permissions(&settings, &runtime).unwrap();
        assert_eq!(permissions.commands.len(), 2);
        for command in permissions.commands {
            assert_eq!(Path::new(&command.program), runtime.node);
            assert_eq!(
                command.args[0],
                runtime
                    .worker
                    .with_file_name("workspace-check.mjs")
                    .to_str()
                    .unwrap()
            );
            assert_eq!(command.args[1], command.id);
        }
    }

    #[test]
    fn corrupt_installed_runtime_cannot_fall_back_to_a_development_checkout() {
        let root = tempfile::tempdir().unwrap();
        let (resources, executable, _) = fixture_bundle(root.path());
        let staged = tempfile::tempdir().unwrap();
        std::fs::write(resources.join("resources/pi-worker/main.mjs"), "modified").unwrap();
        assert_eq!(
            runtime_paths_at(&resources, &executable, Some(staged.path())).unwrap_err(),
            RUNTIME_ERROR
        );
    }

    #[test]
    fn standalone_debug_executable_can_use_staged_resources_even_if_sidecar_was_copied() {
        let root = tempfile::tempdir().unwrap();
        let (resources, executable, _) = fixture_bundle(root.path());
        let development = &resources;
        let binaries = development.join("binaries");
        std::fs::create_dir_all(&binaries).unwrap();
        std::fs::copy(
            executable.with_file_name("yorishiro-pi-node"),
            binaries.join(format!("yorishiro-pi-node-{}", expected_target().unwrap())),
        )
        .unwrap();
        let absent = root.path().join("target/debug");
        let resolved = runtime_paths_at(&absent, &executable, Some(development)).unwrap();
        assert_eq!(
            resolved.worker,
            resources
                .canonicalize()
                .unwrap()
                .join("resources/pi-worker/main.mjs")
        );
        assert!(runtime_paths_at(&absent, &executable, None).is_err());
    }

    #[test]
    fn manifest_cannot_reference_an_absolute_or_parent_path_or_wrong_target() {
        let root = tempfile::tempdir().unwrap();
        let (resources, executable, mut manifest) = fixture_bundle(root.path());
        let worker = resources.join("resources/pi-worker");
        for name in [
            "../private",
            "/outside",
            "folder/../private",
            "folder//./private",
        ] {
            manifest.files.insert(name.into(), "a".repeat(64));
            write_manifest(&worker, &manifest);
            assert!(runtime_paths_at(&resources, &executable, None).is_err());
            manifest.files.remove(name);
        }
        manifest.target = "another-platform".into();
        write_manifest(&worker, &manifest);
        assert!(runtime_paths_at(&resources, &executable, None).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn public_settings_and_symlink_runtime_entries_are_rejected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let root = tempfile::tempdir().unwrap();
        let (resources, executable, _) = fixture_bundle(root.path());
        let worker = resources.join("resources/pi-worker");
        let main = worker.join("main.mjs");
        std::fs::rename(&main, worker.join("original.mjs")).unwrap();
        symlink("original.mjs", &main).unwrap();
        assert!(runtime_paths_at(&resources, &executable, None).is_err());
        let path = root.path().join("settings/continuity/pi-worker.json");
        private_json(&path, &serde_json::to_value(Settings::default()).unwrap());
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(&root.path().join("settings")).is_err());
        let target = root.path().join("private.json");
        private_json(&target, &serde_json::to_value(Settings::default()).unwrap());
        std::fs::remove_file(&path).unwrap();
        symlink(&target, &path).unwrap();
        assert!(load(&root.path().join("settings")).is_err());
        assert!(save(&root.path().join("settings"), &Settings::default()).is_err());
    }
}
