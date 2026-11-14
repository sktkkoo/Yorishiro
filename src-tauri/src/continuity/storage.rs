use super::types::{Certainty, Message, Saved, Snapshot, Understanding};
use serde_json::Value;
use std::collections::HashMap;
use std::io::{BufWriter, Read, Write};
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
        let stored: Value = serde_json::from_str(&text)
            .map_err(|e| format!("Could not read saved understanding: {e}"))?;
        let stored = decode_saved(stored)?;
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
        retired_message_ids: Default::default(),
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
    write_saved(temp.as_file_mut(), saved)?;
    temp.as_file().sync_all().map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

fn write_saved(writer: impl Write, saved: &Saved) -> Result<(), String> {
    // pretty serializer は句読点や escape ごとに write するため、File に直接渡すと
    // 長い会話で数十万回の syscall が発生する。明示的に flush してから呼び出し元で
    // fsync / atomic rename を行い、buffer の書き込み失敗も保存失敗として扱う。
    let mut writer = BufWriter::new(writer);
    serde_json::to_writer_pretty(&mut writer, &encode_saved(saved)?).map_err(|e| e.to_string())?;
    writer.flush().map_err(|e| e.to_string())
}

const FORMAT_ERROR: &str = "Unsupported or invalid continuity storage format";

/// disk v2 だけで終了済み receipt の同一 target を共有する。実行中の target や
/// request payload は触らず、実行層には従来どおり完全な Saved を渡す。
fn encode_saved(saved: &Saved) -> Result<Value, String> {
    if saved.version != 1 {
        return Err(FORMAT_ERROR.into());
    }
    let mut value = serde_json::to_value(saved).map_err(|e| e.to_string())?;
    let object = value.as_object_mut().ok_or(FORMAT_ERROR)?;
    let mut targets = HashMap::new();
    if let Some(receipts) = object.get_mut("terminalReceipts") {
        for receipt in receipts.as_array_mut().ok_or(FORMAT_ERROR)? {
            let receipt = receipt.as_object_mut().ok_or(FORMAT_ERROR)?;
            let target = receipt.remove("target").ok_or(FORMAT_ERROR)?;
            let next = targets.len();
            let index = *targets.entry(target).or_insert(next);
            receipt.insert("targetIndex".into(), index.into());
        }
    }
    let mut dictionary = vec![Value::Null; targets.len()];
    for (target, index) in targets {
        dictionary[index] = target;
    }
    object.insert("terminalReceiptTargets".into(), dictionary.into());
    // 旧 binary は version 検査で拒否し、圧縮された receipt を誤って保存し直さない。
    object.insert("version".into(), 2.into());
    Ok(value)
}

fn decode_saved(mut value: Value) -> Result<Value, String> {
    let object = value.as_object_mut().ok_or(FORMAT_ERROR)?;
    match object.get("version").and_then(Value::as_u64) {
        Some(1) if !object.contains_key("terminalReceiptTargets") => return Ok(value),
        Some(2) => (),
        _ => return Err(FORMAT_ERROR.into()),
    }
    let dictionary = object
        .remove("terminalReceiptTargets")
        .ok_or(FORMAT_ERROR)?;
    let targets = dictionary.as_array().ok_or(FORMAT_ERROR)?;
    let mut used = vec![false; targets.len()];
    if let Some(receipts) = object.get_mut("terminalReceipts") {
        for receipt in receipts.as_array_mut().ok_or(FORMAT_ERROR)? {
            let receipt = receipt.as_object_mut().ok_or(FORMAT_ERROR)?;
            if receipt.contains_key("target") {
                return Err(FORMAT_ERROR.into());
            }
            let index = receipt
                .remove("targetIndex")
                .and_then(|value| value.as_u64())
                .and_then(|value| usize::try_from(value).ok())
                .ok_or(FORMAT_ERROR)?;
            let target = targets.get(index).ok_or(FORMAT_ERROR)?;
            if !target.is_object() {
                return Err(FORMAT_ERROR.into());
            }
            used[index] = true;
            receipt.insert("target".into(), target.clone());
        }
    }
    // 未参照の table entry を認めず、全 target が Saved の deserialize で検証される。
    if used.iter().any(|used| !used) {
        return Err(FORMAT_ERROR.into());
    }
    object.insert("version".into(), 1.into());
    Ok(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[derive(Default)]
    struct CountingWriter {
        bytes: Vec<u8>,
        writes: usize,
    }

    impl Write for CountingWriter {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            self.writes += 1;
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn long_conversation_is_written_in_batches_without_changing_saved_bytes() {
        let home = tempfile::tempdir().unwrap();
        let mut saved = load(home.path(), "yori-ja").unwrap();
        for index in 0..1500 {
            saved.snapshot.messages.push(Message {
                id: format!("message-{index}"),
                role: "user".into(),
                content: "会話の記録\n\"quoted\"\\path\t".repeat(32),
                created_at: index,
                source: "voice".into(),
                reply_kind: None,
            });
        }
        let expected = serde_json::to_vec_pretty(&encode_saved(&saved).unwrap()).unwrap();
        assert!(expected.len() > 1_000_000);
        let mut writer = CountingWriter::default();
        write_saved(&mut writer, &saved).unwrap();
        assert_eq!(writer.bytes, expected);
        assert_eq!(
            decode_saved(serde_json::from_slice(&writer.bytes).unwrap()).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
        assert!(
            writer.writes < expected.len() / 4096,
            "conversation serialization issued {} writes for {} bytes",
            writer.writes,
            expected.len()
        );
    }

    #[test]
    fn buffered_write_and_flush_errors_are_reported() {
        struct FailingWriter {
            fail_write: bool,
        }
        impl Write for FailingWriter {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                if self.fail_write {
                    Err(io::Error::other("write failed"))
                } else {
                    Ok(bytes.len())
                }
            }
            fn flush(&mut self) -> io::Result<()> {
                Err(io::Error::other("flush failed"))
            }
        }
        let home = tempfile::tempdir().unwrap();
        let saved = load(home.path(), "yori-ja").unwrap();
        assert_eq!(
            write_saved(FailingWriter { fail_write: true }, &saved),
            Err("write failed".into())
        );
        assert_eq!(
            write_saved(FailingWriter { fail_write: false }, &saved),
            Err("flush failed".into())
        );
    }

    fn receipt(target: Value, index: usize) -> super::super::types::ExecutionReceipt {
        serde_json::from_value(serde_json::json!({
            "requestId":format!("request-{index}"),"target":target,
            "turnId":format!("turn-{index}"),"status":"interrupted",
            "observedAt":index,"previousStep":"Inspect existing result",
            "evidence":[{"type":"progress","text":"Recorded evidence"}],
        }))
        .unwrap()
    }

    fn codex_target() -> Value {
        serde_json::json!({"backend":"codex","target":{
            "sessionId":"main","threadId":"thread","cwd":"/workspace","launchId":"launch"
        }})
    }

    fn pi_target() -> Value {
        serde_json::json!({"backend":"pi","target":{
            "cwd":"/workspace","sessionDir":"/private/session",
            "nodePath":"/runtime/node","workerEntry":"/runtime/worker.mjs",
            "provider":"provider","model":"model","authMode":"apiKey",
            "permissions":{"read":true,"write":false,"commands":[{
                "id":"inspect","program":"/usr/bin/tool","args":["argument".repeat(1024)]
            }]}
        }})
    }

    #[test]
    fn receipt_targets_are_shared_losslessly_without_changing_active_work() {
        let home = tempfile::tempdir().unwrap();
        let mut saved = load(home.path(), "yori-ja").unwrap();
        for index in 0..100 {
            saved.terminal_receipts.push(receipt(
                if index % 2 == 0 {
                    pi_target()
                } else {
                    codex_target()
                },
                index,
            ));
        }
        saved.pending_execution = Some(
            serde_json::from_value(serde_json::json!({
                "requestId":"pending","createdAt":123,"target":pi_target(),
                "context":{"personaId":"yori-ja","personaName":"Yori","personaPrompt":"Persona",
                    "language":"ja","cwd":"/workspace","executionBackend":"pi"},
                "prompt":"Accepted prompt\n","requestPayload":"{\"message\":\"Exact envelope\\n\"}",
                "trigger":"message","correctionIds":[],"messageCount":7,"dispatchAttempted":true
            }))
            .unwrap(),
        );
        let original = serde_json::to_value(&saved).unwrap();
        let encoded = encode_saved(&saved).unwrap();
        assert_eq!(encoded["version"], 2);
        assert_eq!(
            encoded["terminalReceiptTargets"].as_array().unwrap().len(),
            2
        );
        assert_eq!(encoded["pendingExecution"], original["pendingExecution"]);
        assert_eq!(encoded["workRuns"], original["workRuns"]);
        assert!(encoded["terminalReceipts"][0].get("target").is_none());
        assert_eq!(encoded["terminalReceipts"][0]["targetIndex"], 0);
        assert_eq!(encoded["terminalReceipts"][2]["targetIndex"], 0);
        assert!(
            serde_json::to_vec(&encoded).unwrap().len()
                < serde_json::to_vec(&original).unwrap().len() / 3
        );
        assert_eq!(decode_saved(encoded).unwrap(), original);
        assert_eq!(serde_json::to_value(&saved).unwrap(), original);
        save(home.path(), &saved).unwrap();
        assert_eq!(
            serde_json::to_value(load(home.path(), "yori-en").unwrap()).unwrap(),
            original
        );
    }

    #[test]
    fn legacy_state_is_read_without_rewriting_and_next_save_uses_version_two() {
        let home = tempfile::tempdir().unwrap();
        let mut saved = load(home.path(), "yori-ja").unwrap();
        saved.terminal_receipts.push(receipt(codex_target(), 0));
        let legacy = serde_json::to_vec_pretty(&saved).unwrap();
        let path = state_path(home.path(), "yori-ja");
        std::fs::write(&path, &legacy).unwrap();
        let reopened = load(home.path(), "yori-ja").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), legacy);
        assert_eq!(
            serde_json::to_value(&reopened).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
        save(home.path(), &reopened).unwrap();
        let disk: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!(disk["version"], 2);
        assert_eq!(
            serde_json::to_value(load(home.path(), "yori-ja").unwrap()).unwrap(),
            serde_json::to_value(&saved).unwrap()
        );
        // 旧 loader は target 不在または version != 1 として拒否する。
        assert!(!serde_json::from_value::<Saved>(disk).is_ok_and(|old| old.version == 1));
    }

    #[test]
    fn invalid_compact_receipts_fail_closed_without_overwriting_the_file() {
        let home = tempfile::tempdir().unwrap();
        let mut saved = load(home.path(), "yori-ja").unwrap();
        saved.terminal_receipts.push(receipt(codex_target(), 0));
        let encoded = encode_saved(&saved).unwrap();
        let mut invalid = vec![];
        for index in [
            Value::Null,
            (-1).into(),
            0.5.into(),
            "0".into(),
            1.into(),
            u64::MAX.into(),
        ] {
            let mut value = encoded.clone();
            value["terminalReceipts"][0]["targetIndex"] = index;
            invalid.push(value);
        }
        let mut ambiguous = encoded.clone();
        ambiguous["terminalReceipts"][0]["target"] = codex_target();
        invalid.push(ambiguous);
        let mut unused = encoded.clone();
        unused["terminalReceiptTargets"]
            .as_array_mut()
            .unwrap()
            .push(codex_target());
        invalid.push(unused);
        let mut missing = encoded.clone();
        missing
            .as_object_mut()
            .unwrap()
            .remove("terminalReceiptTargets");
        invalid.push(missing);
        let mut malformed_target = encoded.clone();
        malformed_target["terminalReceiptTargets"][0] = serde_json::json!({"backend":"unknown"});
        invalid.push(malformed_target);
        let mut wrong_version = encoded;
        wrong_version["version"] = 1.into();
        invalid.push(wrong_version);
        let path = state_path(home.path(), "yori-ja");
        for value in invalid {
            let bytes = serde_json::to_vec(&value).unwrap();
            std::fs::write(&path, &bytes).unwrap();
            assert!(load(home.path(), "yori-ja").is_err());
            assert_eq!(std::fs::read(&path).unwrap(), bytes);
        }
    }

    #[test]
    fn failed_encoding_keeps_the_previous_atomic_state() {
        let home = tempfile::tempdir().unwrap();
        let mut saved = load(home.path(), "yori-ja").unwrap();
        let path = state_path(home.path(), "yori-ja");
        let previous = std::fs::read(&path).unwrap();
        saved.version = 99;
        assert!(save(home.path(), &saved).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), previous);
    }
}
