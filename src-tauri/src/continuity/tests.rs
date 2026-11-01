use super::*;
use serde_json::json;

fn user(snapshot: &mut Snapshot, id: &str, content: &str) {
    snapshot.messages.push(Message {
        id: id.into(),
        role: "user".into(),
        content: content.into(),
        created_at: 1,
        source: "conversation".into(),
    });
}
fn response(value: serde_json::Value) -> ModelResult {
    serde_json::from_value(value).unwrap()
}
fn update(id: &str, value: &str, source: &str) -> serde_json::Value {
    json!({"id":id,"title":"Preference","value":value,"certainty":"confirmed","sourceIds":[source],"reason":"The user corrected this"})
}
fn context() -> Context {
    Context {
        persona_id: "yori-ja".into(),
        persona_name: "Yori".into(),
        persona_prompt: "Curious".into(),
        language: "ja".into(),
        cwd: None,
    }
}
fn session() -> Session {
    let saved = Saved {
        version: 1,
        snapshot: Snapshot::new("yori-ja"),
        observed_keys: std::collections::BTreeMap::new(),
        pending_correction_ids: vec![],
        pending_trigger: None,
    };
    Session {
        _storage_lock: tempfile::tempfile().unwrap(),
        committed: saved.clone(),
        saved,
        context: Some(context()),
        running: false,
        queued: false,
        epoch: 0,
        cancel: None,
    }
}

#[test]
fn concurrent_persona_owners_cannot_overwrite_history_and_release_loads_latest_state() {
    let home = tempfile::tempdir().unwrap();
    let first = storage::acquire(home.path(), "yori-ja").unwrap();
    let mut saved = storage::load(home.path(), "yori-ja").unwrap();
    user(&mut saved.snapshot, "first", "Keep this conversation");
    saved.snapshot.revision += 1;
    storage::save(home.path(), &saved).unwrap();
    // Language variants share one owner, but custom personas remain independent.
    assert!(storage::acquire(home.path(), "yori-en")
        .unwrap_err()
        .contains("another Yorishiro instance"));
    let custom = storage::acquire(home.path(), "yori").unwrap();
    drop(custom);
    drop(first);
    // A crashed or closed process releases the OS lock; no stale lock-file
    // deletion or history reset is needed to recover ownership.
    let _second = storage::acquire(home.path(), "yori-en").unwrap();
    let latest = storage::load(home.path(), "yori-en").unwrap();
    assert_eq!(latest.snapshot.revision, saved.snapshot.revision);
    assert_eq!(
        latest.snapshot.messages[0].content,
        "Keep this conversation"
    );
}

#[test]
fn response_schema_uses_cli_supported_draft_with_resolvable_nested_references() {
    fn check_references(root: &serde_json::Value, value: &serde_json::Value) {
        match value {
            serde_json::Value::Object(fields) => {
                if let Some(reference) = fields.get("$ref").and_then(serde_json::Value::as_str) {
                    assert!(reference.starts_with("#/definitions/"), "{reference}");
                    assert!(root.pointer(&reference[1..]).is_some(), "{reference}");
                }
                for child in fields.values() {
                    check_references(root, child);
                }
            }
            serde_json::Value::Array(items) => {
                for child in items {
                    check_references(root, child);
                }
            }
            _ => {}
        }
    }
    let schema = response_schema();
    assert_eq!(schema["$schema"], "http://json-schema.org/draft-07/schema#");
    assert!(schema["definitions"]["UnderstandingUpdate"].is_object());
    assert!(schema["definitions"]["DraftUpdate"].is_object());
    check_references(&schema, &schema);
}

#[cfg(target_os = "macos")]
#[tokio::test]
#[ignore = "requires an authenticated Claude CLI and makes one model request"]
async fn live_initial_conversation_accepts_the_real_response_schema() {
    // Exercise the production prompt, nested schema, transport and response
    // parser together. A flat {ok: true} schema missed the draft incompatibility.
    let result = reason(
        &Snapshot::new("yori-ja"),
        &context(),
        "return",
        &[],
        CancellationToken::new(),
    )
    .await
    .expect("initial conversation returns a verified structured result");
    assert!(!result.reply.trim().is_empty());
    let mut snapshot = Snapshot::new("yori-ja");
    apply(&mut snapshot, result, "return", &[]).expect("valid initial response");
    assert!(snapshot
        .messages
        .iter()
        .any(|message| message.role == "assistant"));
}

#[test]
fn correction_keeps_provenance_and_rejects_invalid_evidence_transactionally() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(&mut snapshot, "u1", "Prefer fewer changes");
    apply(&mut snapshot,response(json!({"reply":"Understood","understandings":[update("preference","Fewer changes","u1")],"drafts":[],"reflection":"Learned preference"})),"message",&[]).unwrap();
    user(&mut snapshot, "u2", "Consider the whole experience first");
    apply(&mut snapshot,response(json!({"reply":"Reconsidering","understandings":[update("preference","Whole experience first","u2")],"drafts":[],"reflection":"Changed my earlier interpretation"})),"message",&["preference".into()]).unwrap();
    let memory = &snapshot.understandings[0];
    assert_eq!(memory.value, "Whole experience first");
    assert_eq!(memory.source_ids, vec!["u2"]);
    assert_eq!(memory.revisions[0].source_ids, vec!["u1"]);
    let before = serde_json::to_value(&snapshot).unwrap();
    assert!(apply(&mut snapshot,response(json!({"reply":"Invalid","understandings":[update("preference","Wrong","fake")],"drafts":[],"reflection":""})),"message",&[]).is_err());
    assert_eq!(serde_json::to_value(&snapshot).unwrap(), before);
}
#[test]
fn unverified_legacy_is_not_user_confirmation_and_external_turn_does_not_duplicate_reply() {
    let mut snapshot = Snapshot::new("yori-ja");
    snapshot.messages.push(Message {
        id: "old".into(),
        role: "assistant".into(),
        content: "Old journal".into(),
        created_at: 0,
        source: "legacy".into(),
    });
    apply(&mut snapshot,response(json!({"reply":"Do not repeat this voice reply","understandings":[update("preference","Something","old")],"drafts":[],"reflection":"Legacy only"})),"external",&[]).unwrap();
    assert_eq!(snapshot.messages.len(), 1);
    assert_eq!(snapshot.understandings[0].certainty, Certainty::Unverified);
}
#[test]
fn dismissed_draft_is_not_resurrected_and_repeated_drafts_do_not_multiply() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(&mut snapshot, "u1", "Make a draft");
    let make = || {
        response(
            json!({"reply":"","understandings":[],"drafts":[{"id":null,"title":"Draft","content":"Actual draft text","reason":"Requested","sourceIds":["u1"]}],"reflection":""}),
        )
    };
    apply(&mut snapshot, make(), "message", &[]).unwrap();
    apply(&mut snapshot, make(), "return", &[]).unwrap();
    assert_eq!(snapshot.drafts.len(), 1);
    snapshot.drafts[0].status = "dismissed".into();
    apply(&mut snapshot, make(), "return", &[]).unwrap();
    assert_eq!(snapshot.drafts.len(), 1);
    assert_eq!(snapshot.drafts[0].status, "dismissed");
    let id = snapshot.drafts[0].id.clone();
    assert!(apply(&mut snapshot,response(json!({"reply":"","understandings":[],"drafts":[{"id":id,"title":"New","content":"New content","reason":"","sourceIds":["u1"]}],"reflection":""})),"return",&[]).is_err());
}
#[test]
fn external_evidence_preserves_pending_foreground_and_multiple_corrections() {
    let mut value = session();
    queue(&mut value, context(), "message");
    value.saved.pending_correction_ids.push("preference".into());
    value.running = true;
    value.queued = false;
    let token = CancellationToken::new();
    value.cancel = Some(token.clone());
    let old_epoch = value.epoch;
    queue(&mut value, context(), "external");
    assert!(token.is_cancelled());
    assert!(value.epoch > old_epoch);
    assert_eq!(value.saved.pending_trigger.as_deref(), Some("message"));
    assert_eq!(value.saved.pending_correction_ids, vec!["preference"]);
    queue(&mut value, context(), "message");
    value.saved.pending_correction_ids.push("background".into());
    queue(&mut value, context(), "retry");
    assert_eq!(value.saved.pending_correction_ids.len(), 2);
    assert_eq!(value.saved.pending_trigger.as_deref(), Some("message"));
}
#[test]
fn missing_correction_is_not_reported_as_success() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(&mut snapshot, "u", "correct preference");
    assert!(apply(
        &mut snapshot,
        response(json!({"reply":"Done","understandings":[],"drafts":[],"reflection":""})),
        "message",
        &["preference".into()]
    )
    .is_err());
    assert_eq!(snapshot.messages.len(), 1);
}
#[test]
fn storage_separates_custom_yori_and_builtin_but_shares_builtin_languages() {
    let home = tempfile::tempdir().unwrap();
    let mut ja = storage::load(home.path(), "yori-ja").unwrap();
    ja.snapshot.revision = 7;
    storage::save(home.path(), &ja).unwrap();
    assert_eq!(
        storage::load(home.path(), "yori-en")
            .unwrap()
            .snapshot
            .revision,
        7
    );
    assert_eq!(
        storage::load(home.path(), "yori")
            .unwrap()
            .snapshot
            .revision,
        0
    );
    assert_eq!(
        storage::load(home.path(), "builtin:yori")
            .unwrap()
            .snapshot
            .revision,
        0
    );
    assert_ne!(storage::identity("yori-ja"), storage::identity("yori"));
}
#[test]
fn legacy_import_preserves_originals_and_restart_retains_pending_correction() {
    let home = tempfile::tempdir().unwrap();
    for persona in ["yori-ja", "yori-en"] {
        let root = home.path().join("journal/personas").join(persona);
        std::fs::create_dir_all(root.join("daily")).unwrap();
        std::fs::write(root.join("memories.md"), format!("Memory from {persona}")).unwrap();
        std::fs::write(root.join("daily/2026-11-01.md"), "Actual past journal").unwrap();
    }
    let mut saved = storage::load(home.path(), "yori-ja").unwrap();
    assert_eq!(saved.snapshot.understandings.len(), 2);
    assert_eq!(saved.snapshot.messages.len(), 4);
    assert!(saved
        .snapshot
        .messages
        .iter()
        .all(|message| message.source == "legacy"));
    saved.snapshot.phase = "thinking".into();
    saved.pending_correction_ids = vec!["preference".into()];
    saved.pending_trigger = Some("message".into());
    storage::save(home.path(), &saved).unwrap();
    let resumed = storage::load(home.path(), "yori-en").unwrap();
    assert_eq!(resumed.snapshot.phase, "error");
    assert_eq!(resumed.pending_correction_ids, vec!["preference"]);
    assert_eq!(resumed.pending_trigger.as_deref(), Some("message"));
    assert_eq!(
        std::fs::read_to_string(home.path().join("journal/personas/yori-ja/memories.md")).unwrap(),
        "Memory from yori-ja"
    );
}
#[test]
fn corrupted_store_is_reported_without_overwriting_it() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("continuity/builtin/yori/state.json");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, "broken").unwrap();
    assert!(storage::load(home.path(), "yori-ja").is_err());
    assert_eq!(std::fs::read_to_string(path).unwrap(), "broken");
}
