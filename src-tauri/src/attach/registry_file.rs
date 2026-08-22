use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const REGISTRY_VERSION: u32 = 1;
const REGISTRY_FILE_NAME: &str = "instances.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstanceEntry {
    pub pid: u32,
    pub socket_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct InstanceRegistry {
    version: u32,
    instances: Vec<InstanceEntry>,
}

impl Default for InstanceRegistry {
    fn default() -> Self {
        Self {
            version: REGISTRY_VERSION,
            instances: Vec::new(),
        }
    }
}

pub(crate) fn registry_path_under(yorishiro_home: &Path) -> PathBuf {
    yorishiro_home
        .join(super::protocol::RUN_DIR_RELATIVE_PATH)
        .join(REGISTRY_FILE_NAME)
}

fn read_registry(path: &Path) -> Result<InstanceRegistry, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("invalid attach instance registry: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(InstanceRegistry::default())
        }
        Err(error) => Err(format!("failed to read attach instance registry: {error}")),
    }
}

fn process_is_live(pid: u32) -> bool {
    #[cfg(unix)]
    {
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if result == 0 {
            return true;
        }
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(not(unix))]
    {
        pid == std::process::id()
    }
}

fn retain_live_entries_with(
    entries: &mut Vec<InstanceEntry>,
    mut is_live: impl FnMut(u32) -> bool,
    mut path_exists: impl FnMut(&Path) -> bool,
) {
    entries
        .retain(|entry| is_live(entry.pid) && path_exists(Path::new(entry.socket_path.as_str())));
}

fn write_registry(path: &Path, registry: &InstanceRegistry) -> Result<(), String> {
    if registry.instances.is_empty() {
        match std::fs::remove_file(path) {
            Ok(()) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(format!(
                    "failed to remove empty attach instance registry: {error}"
                ))
            }
        }
    }

    let parent = path
        .parent()
        .ok_or_else(|| "attach instance registry has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create attach run directory: {error}"))?;
    let temp_path = parent.join(format!(".{REGISTRY_FILE_NAME}.{}.tmp", std::process::id()));
    let bytes = serde_json::to_vec_pretty(registry)
        .map_err(|error| format!("failed to encode attach instance registry: {error}"))?;
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&temp_path)
            .map_err(|error| format!("failed to create attach instance registry: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.write_all(b"\n"))
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("failed to write attach instance registry: {error}"))?;
    }
    std::fs::rename(&temp_path, path)
        .map_err(|error| format!("failed to install attach instance registry: {error}"))
}

pub(crate) fn register_instance(yorishiro_home: &Path, socket_path: &Path) -> Result<(), String> {
    let path = registry_path_under(yorishiro_home);
    let mut registry = read_registry(&path)?;
    retain_live_entries_with(&mut registry.instances, process_is_live, |candidate| {
        candidate.exists()
    });
    let pid = std::process::id();
    registry.instances.retain(|entry| entry.pid != pid);
    registry.instances.push(InstanceEntry {
        pid,
        socket_path: socket_path.to_string_lossy().into_owned(),
    });
    registry.version = REGISTRY_VERSION;
    write_registry(&path, &registry)
}

pub(crate) fn unregister_instance(yorishiro_home: &Path) -> Result<(), String> {
    let path = registry_path_under(yorishiro_home);
    let mut registry = read_registry(&path)?;
    let pid = std::process::id();
    registry.instances.retain(|entry| entry.pid != pid);
    retain_live_entries_with(&mut registry.instances, process_is_live, |candidate| {
        candidate.exists()
    });
    write_registry(&path, &registry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_path_is_under_run_directory() {
        assert_eq!(
            registry_path_under(Path::new("/home/test/.yorishiro")),
            Path::new("/home/test/.yorishiro/run/instances.json")
        );
    }

    #[test]
    fn stale_entries_require_both_a_live_pid_and_existing_socket() {
        let mut entries = vec![
            InstanceEntry {
                pid: 10,
                socket_path: "/live".into(),
            },
            InstanceEntry {
                pid: 11,
                socket_path: "/missing".into(),
            },
            InstanceEntry {
                pid: 12,
                socket_path: "/dead".into(),
            },
        ];
        retain_live_entries_with(
            &mut entries,
            |pid| pid != 12,
            |path| path == Path::new("/live") || path == Path::new("/dead"),
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].pid, 10);
    }

    #[test]
    fn schema_is_versioned_and_uses_camel_case_socket_path() {
        let registry = InstanceRegistry {
            version: 1,
            instances: vec![InstanceEntry {
                pid: 42,
                socket_path: "/tmp/attach.sock".into(),
            }],
        };
        assert_eq!(
            serde_json::to_value(registry).expect("serialize"),
            serde_json::json!({
                "version": 1,
                "instances": [{"pid": 42, "socketPath": "/tmp/attach.sock"}],
            })
        );
    }
}
