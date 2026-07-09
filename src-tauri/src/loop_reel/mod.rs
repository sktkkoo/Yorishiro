use serde_json::Value;
use std::cmp::Reverse;
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

const LOOP_REELS_DIR: &str = "loop-reels";
const META_FILE: &str = "meta.json";
const ENTRIES_FILE: &str = "entries.jsonl";

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RedactionSources {
    username: Option<String>,
    home_basename: Option<String>,
    hostname: Option<String>,
    git_user_name: Option<String>,
    git_user_email: Option<String>,
}

fn loop_reels_root() -> Result<PathBuf, String> {
    Ok(crate::home_dir_or_err()?
        .join(".yorishiro")
        .join(LOOP_REELS_DIR))
}

fn validate_recording_id(id: &str) -> Result<(), String> {
    if id.is_empty() {
        return Err("loop reel id is empty".to_string());
    }
    if id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        Ok(())
    } else {
        Err("loop reel id contains invalid characters".to_string())
    }
}

fn recording_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    validate_recording_id(id)?;
    Ok(root.join(id))
}

fn id_from_meta(meta: &Value) -> Result<&str, String> {
    meta.get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "loop reel meta.id is required".to_string())
        .and_then(|id| {
            validate_recording_id(id)?;
            Ok(id)
        })
}

fn write_meta_at(root: &Path, id: &str, meta: &Value) -> Result<(), String> {
    let dir = recording_dir(root, id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("loop reel dir create failed: {}", e))?;
    let text = serde_json::to_string_pretty(meta)
        .map_err(|e| format!("loop reel meta serialize failed: {}", e))?;
    fs::write(dir.join(META_FILE), text).map_err(|e| format!("loop reel meta write failed: {}", e))
}

fn create_at(root: &Path, meta: Value) -> Result<(), String> {
    let id = id_from_meta(&meta)?;
    write_meta_at(root, id, &meta)
}

fn update_meta_at(root: &Path, id: &str, meta: Value) -> Result<(), String> {
    validate_recording_id(id)?;
    if let Some(meta_id) = meta.get("id").and_then(Value::as_str) {
        if meta_id != id {
            return Err("loop reel meta.id does not match id".to_string());
        }
    }
    write_meta_at(root, id, &meta)
}

fn append_entries_at(root: &Path, id: &str, jsonl: &str) -> Result<(), String> {
    let dir = recording_dir(root, id)?;
    fs::create_dir_all(&dir).map_err(|e| format!("loop reel dir create failed: {}", e))?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join(ENTRIES_FILE))
        .map_err(|e| format!("loop reel entries open failed: {}", e))?;
    let buffer = if jsonl.is_empty() || jsonl.ends_with('\n') {
        jsonl.as_bytes().to_vec()
    } else {
        let mut bytes = Vec::with_capacity(jsonl.len() + 1);
        bytes.extend_from_slice(jsonl.as_bytes());
        bytes.push(b'\n');
        bytes
    };
    file.write_all(&buffer)
        .map_err(|e| format!("loop reel entries append failed: {}", e))?;
    Ok(())
}

fn list_at(root: &Path) -> Result<Vec<Value>, String> {
    let Ok(entries) = fs::read_dir(root) else {
        return Ok(Vec::new());
    };
    let mut metas = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta_path = path.join(META_FILE);
        let Ok(text) = fs::read_to_string(&meta_path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        metas.push(value);
    }
    metas.sort_by_key(|meta| Reverse(numeric_field(meta, "startedAt")));
    Ok(metas)
}

fn load_entries_at(root: &Path, id: &str) -> Result<String, String> {
    let dir = recording_dir(root, id)?;
    match fs::read_to_string(dir.join(ENTRIES_FILE)) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("loop reel entries read failed: {}", e)),
    }
}

fn delete_at(root: &Path, id: &str) -> Result<(), String> {
    let dir = recording_dir(root, id)?;
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("loop reel delete failed: {}", e)),
    }
}

fn numeric_field(value: &Value, field: &str) -> i64 {
    value.get(field).and_then(Value::as_i64).unwrap_or(0)
}

fn clean_source(value: String) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn command_stdout(program: &str, args: &[&str]) -> Option<String> {
    let output = Command::new(program).args(args).output().ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout).ok().and_then(clean_source)
}

fn current_username() -> Option<String> {
    env::var("USER")
        .ok()
        .and_then(clean_source)
        .or_else(|| env::var("USERNAME").ok().and_then(clean_source))
}

fn current_home_basename() -> Option<String> {
    home_dir_or_none()?
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .and_then(clean_source)
}

fn home_dir_or_none() -> Option<PathBuf> {
    crate::home_dir_or_err().ok()
}

fn current_hostname() -> Option<String> {
    env::var("HOSTNAME")
        .ok()
        .and_then(clean_source)
        .or_else(|| env::var("COMPUTERNAME").ok().and_then(clean_source))
        .or_else(|| command_stdout("hostname", &[]))
}

fn git_global_config(key: &str) -> Option<String> {
    command_stdout("git", &["config", "--global", key])
}

fn collect_redaction_sources() -> RedactionSources {
    RedactionSources {
        username: current_username(),
        home_basename: current_home_basename(),
        hostname: current_hostname(),
        git_user_name: git_global_config("user.name"),
        git_user_email: git_global_config("user.email"),
    }
}

#[tauri::command]
pub fn loop_reel_create(meta: Value) -> Result<(), String> {
    create_at(&loop_reels_root()?, meta)
}

#[tauri::command]
pub fn loop_reel_update_meta(id: String, meta: Value) -> Result<(), String> {
    update_meta_at(&loop_reels_root()?, &id, meta)
}

#[tauri::command]
pub fn loop_reel_append_entries(id: String, jsonl: String) -> Result<(), String> {
    append_entries_at(&loop_reels_root()?, &id, &jsonl)
}

#[tauri::command]
pub fn loop_reel_list() -> Result<Vec<Value>, String> {
    list_at(&loop_reels_root()?)
}

#[tauri::command]
pub fn loop_reel_load_entries(id: String) -> Result<String, String> {
    load_entries_at(&loop_reels_root()?, &id)
}

#[tauri::command]
pub fn loop_reel_delete(id: String) -> Result<(), String> {
    delete_at(&loop_reels_root()?, &id)
}

#[tauri::command]
pub fn loop_reel_redaction_sources() -> RedactionSources {
    collect_redaction_sources()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn rejects_path_traversal_ids() {
        assert!(validate_recording_id("session-default-100-1").is_ok());
        assert!(validate_recording_id("../secret").is_err());
        assert!(validate_recording_id("session_default").is_err());
        assert!(validate_recording_id("").is_err());
    }

    #[test]
    fn writes_meta_and_appends_jsonl_entries() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        let meta = json!({
            "id": "session-default-100-1",
            "sessionId": "default-session",
            "startedAt": 100,
            "status": "recording"
        });

        create_at(root, meta).expect("create");
        append_entries_at(
            root,
            "session-default-100-1",
            "{\"kind\":\"pty\",\"text\":\"one\",\"timestamp\":110}",
        )
        .expect("append");

        let meta_text =
            fs::read_to_string(root.join("session-default-100-1").join(META_FILE)).expect("meta");
        assert!(meta_text.contains("\"sessionId\": \"default-session\""));
        assert_eq!(
            load_entries_at(root, "session-default-100-1").expect("entries"),
            "{\"kind\":\"pty\",\"text\":\"one\",\"timestamp\":110}\n"
        );
    }

    #[test]
    fn list_reads_meta_without_loading_entries() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        create_at(
            root,
            json!({
                "id": "older",
                "sessionId": "default-session",
                "startedAt": 100,
                "status": "ended"
            }),
        )
        .expect("older");
        create_at(
            root,
            json!({
                "id": "newer",
                "sessionId": "default-session",
                "startedAt": 200,
                "status": "ended"
            }),
        )
        .expect("newer");
        append_entries_at(root, "newer", "{\"kind\":\"pty\",\"timestamp\":210}").expect("append");

        let list = list_at(root).expect("list");
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["id"], "newer");
        assert!(list[0].get("entries").is_none());
    }

    #[test]
    fn update_meta_rejects_mismatched_id() {
        let tmp = tempdir().expect("tempdir");
        let err = update_meta_at(
            tmp.path(),
            "session-a",
            json!({ "id": "session-b", "status": "ended" }),
        )
        .expect_err("mismatch");

        assert!(err.contains("does not match"));
    }

    #[test]
    fn delete_removes_recording_directory() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        create_at(
            root,
            json!({
                "id": "session-default-100-1",
                "sessionId": "default-session",
                "startedAt": 100,
                "status": "ended"
            }),
        )
        .expect("create");

        delete_at(root, "session-default-100-1").expect("delete");

        assert!(!root.join("session-default-100-1").exists());
    }

    #[test]
    fn clean_source_trims_and_omits_empty_values() {
        assert_eq!(
            clean_source("  alice  ".to_string()),
            Some("alice".to_string())
        );
        assert_eq!(clean_source("\n\t".to_string()), None);
    }
}
