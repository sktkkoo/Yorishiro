use super::types::{Certainty, Message, Saved, Snapshot, Understanding};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

pub fn identity(id: &str) -> String {
    match id {
        "yori-ja" | "yori-en" => "builtin:yori".into(),
        _ => format!("custom:{id}"),
    }
}
pub fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 || id.chars().any(char::is_control) {
        return Err("Invalid persona identifier".into());
    }
    Ok(())
}
fn encoded(id: &str) -> String {
    id.bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
                char::from(b).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect()
}
fn state_path(home: &Path, id: &str) -> PathBuf {
    if matches!(id, "yori-ja" | "yori-en") {
        home.join("continuity/builtin/yori/state.json")
    } else {
        home.join("continuity/custom")
            .join(encoded(id))
            .join("state.json")
    }
}

/// Keep this handle alive while a process caches the persona's mutable state.
/// The lock file is never renamed or removed; state.json uses atomic replacement.
pub fn acquire(home: &Path, id: &str) -> Result<std::fs::File, String> {
    validate_id(id)?;
    let path = state_path(home, id).with_file_name("owner.lock");
    std::fs::create_dir_all(path.parent().ok_or("Missing continuity directory")?)
        .map_err(|e| e.to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|e| e.to_string())?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Continuity ownership must be a regular file".into());
    }
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => "このキャラクターの会話は別のYorishiroで開かれています。そちらを終了して再試行してください。 / This persona's conversation is open in another Yorishiro instance. Close it and retry.".into(),
        std::fs::TryLockError::Error(error) => format!("Could not lock conversation storage: {error}"),
    })?;
    Ok(file)
}

fn read_regular(path: &Path) -> Result<Option<String>, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("Continuity data must be a regular file".into());
    }
    let mut text = String::new();
    file.read_to_string(&mut text).map_err(|e| e.to_string())?;
    Ok(Some(text))
}
pub fn load(home: &Path, id: &str) -> Result<Saved, String> {
    validate_id(id)?;
    let key = identity(id);
    if let Some(text) = read_regular(&state_path(home, id))? {
        let stored: serde_json::Value = serde_json::from_str(&text)
            .map_err(|e| format!("Could not read saved understanding: {e}"))?;
        let migrate_auto = stored.get("autoEnabled").is_none();
        let mut saved: Saved = serde_json::from_value(stored)
            .map_err(|e| format!("Could not read saved understanding: {e}"))?;
        if saved.version != 1 || identity(&saved.snapshot.persona_id) != key {
            return Err("Unsupported continuity data".into());
        }
        // Test rollout defaults to On. A persisted user choice always wins,
        // including false; opening the workspace must never re-enable it.
        if migrate_auto {
            saved.auto_enabled = true;
            saved.snapshot.auto_enabled = true;
            save(home, &saved)?;
        }
        saved.snapshot.auto_enabled = saved.auto_enabled;
        if ["thinking", "drafting", "working"].contains(&saved.snapshot.phase.as_str()) {
            saved.snapshot.phase = "error".into();
            saved.snapshot.error = Some("前回の返答は中断しました。再試行できます。 / The previous reply was interrupted. You can retry.".into());
            saved.snapshot.revision += 1;
        }
        return Ok(saved);
    }
    let mut saved = Saved {
        version: 1,
        snapshot: Snapshot::new(id),
        auto_enabled: true,
        auto_context: None,
        work_runs: vec![],
        failure_streak: 0,
        stagnation_streak: 0,
        stagnation_pause: None,
        retry_not_before: None,
        context_handoffs: vec![],
        observed_keys: std::collections::BTreeMap::new(),
        pending_correction_ids: vec![],
        pending_trigger: None,
        pending_execution: None,
        terminal_receipts: vec![],
        execution_blocked: false,
        resume_after_recovery: false,
    };
    let personas = if key == "builtin:yori" {
        vec!["yori-ja", "yori-en"]
    } else {
        vec![id]
    };
    for persona in personas {
        let root = home.join("journal").join("personas").join(encoded(persona));
        if let Some(memories) = read_regular(&root.join("memories.md"))? {
            for line in memories
                .lines()
                .map(str::trim)
                .filter(|line| !line.is_empty())
            {
                let source_id = format!("legacy-{}", uuid::Uuid::new_v4());
                saved.snapshot.messages.push(Message {
                    id: source_id.clone(),
                    role: "assistant".into(),
                    content: format!("[{persona}/memories.md] {line}"),
                    created_at: 0,
                    source: "legacy".into(),
                    reply_kind: None,
                });
                saved.snapshot.understandings.push(Understanding {
                    id: format!("understanding-{}", uuid::Uuid::new_v4()),
                    title: "以前の記録 / Earlier note".into(),
                    value: line.into(),
                    certainty: Certainty::Unverified,
                    source_ids: vec![source_id],
                    updated_at: 0,
                    revisions: vec![],
                });
            }
        }
        let daily = root.join("daily");
        match std::fs::read_dir(&daily) {
            Ok(entries) => {
                let mut paths = entries
                    .map(|entry| entry.map(|entry| entry.path()).map_err(|e| e.to_string()))
                    .collect::<Result<Vec<_>, _>>()?;
                paths.sort();
                for path in paths {
                    let name = path
                        .file_name()
                        .and_then(|v| v.to_str())
                        .unwrap_or_default();
                    if name.len() != 13 || !name.ends_with(".md") {
                        continue;
                    }
                    if let Some(content) = read_regular(&path)? {
                        if !content.trim().is_empty() {
                            saved.snapshot.messages.push(Message {
                                id: format!("legacy-{}", uuid::Uuid::new_v4()),
                                role: "assistant".into(),
                                content: format!("[{persona}/daily/{name}]\n{content}"),
                                created_at: 0,
                                source: "legacy".into(),
                                reply_kind: None,
                            });
                        }
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(e.to_string()),
        }
    }
    save(home, &saved)?;
    Ok(saved)
}
pub fn save(home: &Path, saved: &Saved) -> Result<(), String> {
    let path = state_path(home, &saved.snapshot.persona_id);
    let directory = path.parent().ok_or("Missing continuity directory")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    let mut temp = tempfile::NamedTempFile::new_in(directory).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    serde_json::to_writer_pretty(temp.as_file_mut(), saved).map_err(|e| e.to_string())?;
    temp.flush().map_err(|e| e.to_string())?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}
