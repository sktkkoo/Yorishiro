use super::*;
use serde_json::json;

fn user(snapshot: &mut Snapshot, id: &str, content: &str) {
    snapshot.messages.push(Message {
        id: id.into(),
        role: "user".into(),
        content: content.into(),
        created_at: 1,
        source: "conversation".into(),
        reply_kind: None,
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
        execution_session_id: None,
    }
}
fn session() -> Session {
    let saved = Saved {
        version: 1,
        snapshot: Snapshot::new("yori-ja"),
        observed_keys: std::collections::BTreeMap::new(),
        pending_correction_ids: vec![],
        pending_trigger: None,
        pending_execution: None,
        terminal_receipts: vec![],
        execution_blocked: false,
        resume_after_recovery: false,
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
        last_periodic_at: None,
        followup_steps: BTreeSet::new(),
    }
}

#[test]
fn passive_context_sync_keeps_persona_and_project_without_starting_or_cancelling_work() {
    let mut value = session();
    value.context = None;
    let mut selected = context();
    selected.persona_prompt = "The selected character's perspective".into();
    selected.cwd = Some("/workspace/project".into());
    let snapshot = sync_context(&mut value, selected.clone());
    assert!(!value.running);
    assert!(!value.queued);
    assert!(snapshot.last_observed_at.is_none());
    assert_eq!(value.epoch, 0);
    let remembered = value.context.as_ref().unwrap();
    assert_eq!(remembered.persona_prompt, selected.persona_prompt);
    assert_eq!(remembered.cwd, selected.cwd);

    let token = CancellationToken::new();
    value.cancel = Some(token.clone());
    value.running = true;
    sync_context(&mut value, selected);
    assert!(value.running);
    assert!(!token.is_cancelled());
    assert_eq!(value.epoch, 0);
}

#[test]
fn periodic_ticks_enforce_the_exact_interval_after_a_completed_turn() {
    assert_eq!(PERIODIC_INTERVAL_MS, 300_000);
    let mut value = session();
    assert!(queue_periodic(&mut value, context(), 10_000));
    assert_eq!(value.saved.pending_trigger.as_deref(), Some("return"));
    let first_epoch = value.epoch;
    // Simulate completion before duplicate callbacks arrive.
    value.queued = false;
    value.saved.snapshot.phase = "idle".into();
    value.saved.pending_trigger = None;
    assert!(!queue_periodic(&mut value, context(), 10_000));
    assert!(!queue_periodic(
        &mut value,
        context(),
        10_000 + PERIODIC_INTERVAL_MS - 1
    ));
    assert_eq!(value.epoch, first_epoch);
    assert!(queue_periodic(
        &mut value,
        context(),
        10_000 + PERIODIC_INTERVAL_MS
    ));
    assert_eq!(value.epoch, first_epoch + 1);
}

#[test]
fn periodic_ticks_leave_running_and_queued_user_work_intact() {
    for (running, queued) in [(true, false), (false, true)] {
        let mut value = session();
        queue(&mut value, context(), "message");
        value.saved.pending_correction_ids.push("preference".into());
        value.running = running;
        value.queued = queued;
        let token = CancellationToken::new();
        value.cancel = Some(token.clone());
        let epoch = value.epoch;
        assert!(!queue_periodic(&mut value, context(), PERIODIC_INTERVAL_MS));
        assert!(!token.is_cancelled());
        assert_eq!(value.epoch, epoch);
        assert_eq!(value.last_periodic_at, None);
        assert_eq!(value.saved.pending_trigger.as_deref(), Some("message"));
        assert_eq!(value.saved.pending_correction_ids, vec!["preference"]);
    }
}

#[test]
fn periodic_retry_preserves_the_failed_foreground_trigger_and_corrections() {
    let mut value = session();
    value.saved.snapshot.phase = "error".into();
    value.saved.snapshot.error = Some("Temporary transport failure".into());
    value.saved.pending_trigger = Some("continue".into());
    value.saved.pending_correction_ids = vec!["preference".into(), "background".into()];
    assert!(queue_periodic(&mut value, context(), PERIODIC_INTERVAL_MS));
    assert_eq!(value.saved.pending_trigger.as_deref(), Some("continue"));
    assert_eq!(
        value.saved.pending_correction_ids,
        vec!["preference", "background"]
    );
    assert_eq!(value.saved.snapshot.phase, "drafting");
    assert_eq!(value.saved.snapshot.error, None);
    assert!(value.queued);
}

#[test]
fn a_new_reply_can_start_work_but_rephrased_proposals_cannot_sustain_a_followup_chain() {
    let mut snapshot = Snapshot::new("yori-ja");
    for (trigger, reply, next) in [
        (
            "return",
            "I can prepare the opening flow",
            "Draft the opening flow",
        ),
        (
            "followup",
            "I could also consider the navigation",
            "Consider navigation",
        ),
    ] {
        apply(
            &mut snapshot,
            response(json!({"reply":reply,"understandings":[],"drafts":[],"reflection":"","nextStep":next})),
            trigger,
            &[],
        )
        .unwrap();
        assert_eq!(
            snapshot.next_step.as_deref(),
            (trigger == "return").then_some(next)
        );
        assert_eq!(snapshot.messages.len(), 1);
    }
}

#[test]
fn silent_grounded_draft_progress_continues_but_title_and_timestamp_churn_do_not() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(
        &mut snapshot,
        "u1",
        "Draft the opening experience and then review the navigation",
    );
    let make = |id: Option<&str>, title: &str, content: &str, next: &str| {
        response(json!({"reply":"","understandings":[],"drafts":[{
            "id":id,"title":title,"content":content,"reason":"From the request","sourceIds":["u1"]
        }],"reflection":"","nextStep":next}))
    };
    apply(
        &mut snapshot,
        make(None, "Opening", "Opening experience", "Review navigation"),
        "message",
        &[],
    )
    .unwrap();
    assert_eq!(snapshot.next_step.as_deref(), Some("Review navigation"));
    let id = snapshot.drafts[0].id.clone();
    apply(
        &mut snapshot,
        make(
            Some(&id),
            "Opening",
            "Opening experience with navigation",
            "Review accessibility",
        ),
        "followup",
        &[],
    )
    .unwrap();
    assert_eq!(snapshot.next_step.as_deref(), Some("Review accessibility"));
    assert_eq!(
        snapshot.messages.len(),
        1,
        "silent work need not announce progress"
    );
    apply(
        &mut snapshot,
        make(
            Some(&id),
            "Revised opening",
            "Opening experience with navigation",
            "Polish the opening",
        ),
        "followup",
        &[],
    )
    .unwrap();
    assert!(snapshot.next_step.is_none());
    assert_eq!(snapshot.drafts.len(), 1);
}

#[test]
fn noop_understanding_and_reflection_updates_do_not_count_as_progress() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(&mut snapshot, "u1", "Consider the whole experience");
    apply(&mut snapshot, response(json!({"reply":"","understandings":[update("preference","Whole experience","u1")],"drafts":[],"reflection":"Learned","nextStep":"Review the experience"})), "message", &[]).unwrap();
    assert!(snapshot.next_step.is_some());
    let mut unchanged = update("preference", "Whole experience", "u1");
    unchanged["title"] = json!("Renamed preference");
    apply(&mut snapshot, response(json!({"reply":"","understandings":[unchanged],"drafts":[],"reflection":"I reflected on it again","nextStep":"Keep reflecting"})), "followup", &[]).unwrap();
    assert!(snapshot.next_step.is_none());
    assert_eq!(snapshot.reflections.len(), 2);
    assert!(snapshot.understandings[0].revisions.is_empty());
    apply(&mut snapshot, response(json!({"reply":"","understandings":[],"drafts":[],"reflection":"","nextStep":"Invent another task"})), "return", &[]).unwrap();
    assert!(snapshot.next_step.is_none());
}

#[test]
fn self_authored_and_legacy_evidence_cannot_sustain_automatic_work() {
    for (role, source) in [("assistant", "conversation"), ("user", "legacy")] {
        let mut snapshot = Snapshot::new("yori-ja");
        snapshot.messages.push(Message {
            id: "unverified".into(),
            role: role.into(),
            content: "A possible preference".into(),
            created_at: 1,
            source: source.into(),
            reply_kind: None,
        });
        apply(&mut snapshot, response(json!({"reply":"","understandings":[update("preference","New inference","unverified")],"drafts":[{
            "id":null,"title":"Draft","content":"New text","reason":"Inferred","sourceIds":["unverified"]
        }],"reflection":"","nextStep":"Continue inventing tasks"})), "followup", &[]).unwrap();
        assert!(snapshot.next_step.is_none());
        assert_eq!(snapshot.understandings[0].certainty, Certainty::Unverified);
    }
}

#[test]
fn automatic_duplicate_replies_are_silent_but_direct_replies_are_preserved() {
    let mut snapshot = Snapshot::new("yori-ja");
    let reply = |text: &str| {
        response(
            json!({"reply":text,"understandings":[],"drafts":[],"reflection":"","nextStep":"Another suggestion"}),
        )
    };
    apply(&mut snapshot, reply("Draft ready"), "message", &[]).unwrap();
    for trigger in ["return", "followup"] {
        apply(&mut snapshot, reply("  DRAFT   ready  "), trigger, &[]).unwrap();
        assert_eq!(snapshot.messages.len(), 1);
        assert!(snapshot.next_step.is_none());
    }
    apply(&mut snapshot, reply("Draft ready"), "message", &[]).unwrap();
    assert_eq!(snapshot.messages.len(), 2);
}

#[test]
fn unanswered_proposals_cannot_restart_conversation_or_work_with_new_wording() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(&mut snapshot, "u1", "Improve the opening experience");
    let reply = |text: &str| {
        response(json!({
            "reply":text,"understandings":[],"drafts":[],"reflection":"",
            "nextStep":"Decide where to start"
        }))
    };
    apply(
        &mut snapshot,
        reply("どこから手をつけるか決めようか。コードはまだ触らない"),
        "message",
        &[],
    )
    .unwrap();
    // The guard is derived from persisted conversation, so reopening the app
    // does not grant another turn to the same unanswered proposal.
    snapshot = serde_json::from_value(serde_json::to_value(snapshot).unwrap()).unwrap();
    for (trigger, text) in [
        ("followup", "まず取り組む場所を一緒に決めようか。"),
        ("return", "どこから始めたい？"),
        ("return", "準備はできているから、方針を聞かせて。"),
    ] {
        apply(&mut snapshot, reply(text), trigger, &[]).unwrap();
        assert_eq!(snapshot.messages.len(), 2);
        assert!(snapshot.next_step.is_none());
    }
    user(&mut snapshot, "u2", "Start with the opening screen");
    apply(
        &mut snapshot,
        reply("I will draft the opening screen"),
        "return",
        &[],
    )
    .unwrap();
    assert_eq!(snapshot.messages.len(), 4);
    assert!(snapshot.next_step.is_some());
}

#[test]
fn unanswered_messages_do_not_block_concrete_autonomous_results() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(
        &mut snapshot,
        "u1",
        "Prepare the opening and navigation drafts",
    );
    apply(
        &mut snapshot,
        response(
            json!({"reply":"I will prepare the opening", "understandings":[],
            "drafts":[],"reflection":"","nextStep":"Draft the opening"}),
        ),
        "message",
        &[],
    )
    .unwrap();
    for (trigger, content, next) in [
        ("followup", "Opening flow", "Review navigation"),
        ("return", "Navigation flow", "Review accessibility"),
    ] {
        apply(
            &mut snapshot,
            response(
                json!({"reply":format!("Prepared {content}"),"understandings":[],
                "drafts":[{"id":null,"title":content,"content":content,
                    "reason":"Requested work","sourceIds":["u1"]}],
                "reflection":"","nextStep":next}),
            ),
            trigger,
            &[],
        )
        .unwrap();
        assert_eq!(snapshot.next_step.as_deref(), Some(next));
    }
    assert_eq!(snapshot.drafts.len(), 2);
    assert_eq!(snapshot.messages.len(), 4);
    assert_eq!(snapshot.messages[3].content, "Prepared Navigation flow");

    let id = snapshot.drafts[1].id.clone();
    apply(
        &mut snapshot,
        response(
            json!({"reply":"What would you like me to do next?","understandings":[],
            "drafts":[{"id":id,"title":"Renamed navigation","content":"Navigation flow",
                "reason":"Updated title only","sourceIds":["u1"]}],
            "reflection":"","nextStep":"Ask about the next step"}),
        ),
        "return",
        &[],
    )
    .unwrap();
    assert_eq!(snapshot.messages.len(), 4);
    assert!(snapshot.next_step.is_none());
}

#[test]
fn memory_reinterpretation_does_not_repeat_an_unanswered_question() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(&mut snapshot, "u1", "I care about the whole experience");
    apply(
        &mut snapshot,
        response(
            json!({"reply":"What part matters most?","understandings":[],
            "drafts":[],"reflection":"","nextStep":null}),
        ),
        "message",
        &[],
    )
    .unwrap();
    apply(
        &mut snapshot,
        response(json!({"reply":"Which part shall we discuss first?",
            "understandings":[update("preference","Whole experience first","u1")],
            "drafts":[],"reflection":"Remembered the preference","nextStep":null})),
        "return",
        &[],
    )
    .unwrap();
    assert_eq!(snapshot.understandings.len(), 1);
    assert_eq!(snapshot.messages.len(), 2);
}

#[test]
fn a_repeated_next_step_is_rejected_even_when_the_draft_advanced() {
    let mut snapshot = Snapshot::new("yori-ja");
    snapshot.next_step = Some("Review   the draft".into());
    user(&mut snapshot, "u1", "Prepare a draft");
    apply(&mut snapshot, response(json!({"reply":"","understandings":[],"drafts":[{
        "id":null,"title":"Draft","content":"Actual new work","reason":"Requested","sourceIds":["u1"]
    }],"reflection":"","nextStep":"  REVIEW the DRAFT  "})), "followup", &[]).unwrap();
    assert_eq!(snapshot.drafts.len(), 1);
    assert!(snapshot.next_step.is_none());
}

#[test]
fn followup_queue_checks_revision_context_and_phase_before_replacing_work() {
    for case in ["revision", "context", "phase", "queued", "no-step"] {
        let mut value = session();
        value.saved.snapshot.revision = 4;
        value.saved.snapshot.next_step = Some("Review the draft".into());
        let mut request = context();
        let mut revision = 4;
        match case {
            "revision" => revision = 3,
            "context" => request.cwd = Some("/other/project".into()),
            "phase" => value.saved.snapshot.phase = "thinking".into(),
            "queued" => value.queued = true,
            "no-step" => value.saved.snapshot.next_step = None,
            _ => unreachable!(),
        }
        let before = serde_json::to_value(&value.saved).unwrap();
        assert_eq!(
            queue_followup(&mut value, request, revision),
            Advance::Unchanged,
            "{case}"
        );
        assert_eq!(
            serde_json::to_value(&value.saved).unwrap(),
            before,
            "{case}"
        );
        assert_eq!(value.epoch, 0);
    }
    // Completion publishes idle just before the native worker leaves its loop.
    let mut value = session();
    value.running = true;
    value.saved.snapshot.next_step = Some("Review the draft".into());
    assert_eq!(queue_followup(&mut value, context(), 0), Advance::Queued);
    assert!(value.queued);
    assert_eq!(value.saved.pending_trigger.as_deref(), Some("followup"));
    assert_eq!(queue_followup(&mut value, context(), 0), Advance::Unchanged);
    assert_eq!(value.epoch, 1);
}

#[test]
fn followup_chain_cannot_cycle_back_to_a_previously_executed_step() {
    let mut value = session();
    for (revision, step, expected) in [
        (1, "Review opening", Advance::Queued),
        (2, "Review navigation", Advance::Queued),
        (3, "  REVIEW   opening ", Advance::Waiting),
    ] {
        // Simulate successful completion publishing a new pending step.
        value.queued = false;
        value.saved.snapshot.phase = "idle".into();
        value.saved.snapshot.revision = revision;
        value.saved.snapshot.next_step = Some(step.into());
        assert_eq!(queue_followup(&mut value, context(), revision), expected);
    }
    assert!(!value.queued);
    assert!(value.saved.snapshot.next_step.is_none());
    assert_eq!(value.epoch, 2);
}

#[test]
fn context_changes_discard_pending_plans_and_old_completions_cannot_restart_them() {
    let mut value = session();
    value.saved.snapshot.next_step = Some("Draft the opening".into());
    value.saved.pending_trigger = Some("followup".into());
    sync_context(&mut value, context());
    assert!(
        value.saved.snapshot.next_step.is_some(),
        "same context keeps pending work"
    );
    let mut selected = context();
    selected.cwd = Some("/new/project".into());
    sync_context(&mut value, selected);
    assert!(value.saved.snapshot.next_step.is_none());
    assert_eq!(value.saved.pending_trigger.as_deref(), Some("return"));
    assert!(!value.queued);
    user(&mut value.saved.snapshot, "u1", "Draft an opening");
    apply_completed(&mut value, response(json!({"reply":"","understandings":[update("preference","A new grounded understanding","u1")],"drafts":[],"reflection":"","nextStep":"Continue old project"})), &context(), "followup", &[]).unwrap();
    assert_eq!(
        value.saved.snapshot.understandings.len(),
        1,
        "accepted work may finish"
    );
    assert!(value.saved.snapshot.next_step.is_none());
}

#[test]
fn reopening_reconsiders_quiet_work_without_overlapping_busy_or_pending_work() {
    let mut quiet = session();
    assert!(queue_on_open(&mut quiet, context()));
    assert_eq!(quiet.saved.pending_trigger.as_deref(), Some("return"));
    assert!(!queue_on_open(&mut quiet, context()));
    let mut pending = session();
    pending.saved.snapshot.next_step = Some("Review draft".into());
    assert!(!queue_on_open(&mut pending, context()));
    assert_eq!(
        pending.saved.snapshot.next_step.as_deref(),
        Some("Review draft")
    );
    pending.saved.snapshot.phase = "error".into();
    let mut other = context();
    other.cwd = Some("/new/project".into());
    assert!(!queue_on_open(&mut pending, other));
    assert!(pending.saved.snapshot.next_step.is_none());
}

#[test]
fn old_saved_snapshots_load_without_a_next_step_and_new_plans_round_trip() {
    let home = tempfile::tempdir().unwrap();
    let mut saved = storage::load(home.path(), "yori-ja").unwrap();
    saved.snapshot.next_step = Some("Review the saved draft".into());
    storage::save(home.path(), &saved).unwrap();
    assert_eq!(
        storage::load(home.path(), "yori-en")
            .unwrap()
            .snapshot
            .next_step,
        saved.snapshot.next_step
    );
    let path = home.path().join("continuity/builtin/yori/state.json");
    let mut legacy = serde_json::to_value(&saved).unwrap();
    legacy["snapshot"]
        .as_object_mut()
        .unwrap()
        .remove("nextStep");
    std::fs::write(path, serde_json::to_vec(&legacy).unwrap()).unwrap();
    assert!(storage::load(home.path(), "yori-ja")
        .unwrap()
        .snapshot
        .next_step
        .is_none());
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
        reply_kind: None,
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

fn pending_work(value: &Session) -> PendingExecution {
    PendingExecution {
        request_id: "work-1".into(),
        target: executor::Target {
            session_id: "main".into(),
            thread_id: "thread".into(),
            cwd: "/workspace".into(),
            launch_id: "launch".into(),
        },
        context: value.context.clone().unwrap(),
        prompt: "Complete the entrusted work".into(),
        trigger: "followup".into(),
        correction_ids: vec![],
        previous_step: Some("Implement the fix".into()),
        message_count: value.saved.snapshot.messages.len(),
        dispatch_attempted: false,
    }
}

#[test]
fn execution_schema_requires_nullable_fields_without_changing_claude_schema() {
    let schema = execution_schema();
    assert!(schema.get("$schema").is_none());
    assert!(schema["required"]
        .as_array()
        .unwrap()
        .contains(&json!("nextStep")));
    assert!(schema["definitions"]["DraftUpdate"]["required"]
        .as_array()
        .unwrap()
        .contains(&json!("id")));
    assert_eq!(
        schema["properties"]["nextStep"]["type"],
        json!(["string", "null"])
    );
    assert!(response_schema().get("$schema").is_some());
}

#[test]
fn durable_dispatch_claim_prevents_resend_and_new_input_does_not_cancel_accepted_work() {
    let mut value = session();
    let work = pending_work(&value);
    value.saved.pending_execution = Some(work.clone());
    mark_execution_dispatched(&mut value, &work.request_id).unwrap();
    let reloaded: Saved =
        serde_json::from_value(serde_json::to_value(&value.saved).unwrap()).unwrap();
    assert!(
        reloaded
            .pending_execution
            .as_ref()
            .unwrap()
            .dispatch_attempted
    );
    assert!(mark_execution_dispatched(&mut value, &work.request_id).is_err());
    let token = CancellationToken::new();
    value.cancel = Some(token.clone());
    queue(&mut value, context(), "message");
    assert!(!token.is_cancelled());
    assert_eq!(value.saved.pending_trigger.as_deref(), Some("message"));
    assert!(value.queued);
    assert_eq!(value.saved.snapshot.phase, "working");
    assert_eq!(
        value.saved.pending_execution.unwrap().request_id,
        work.request_id
    );
}

fn terminal_turn(status: TerminalStatus) -> executor::TerminalTurn {
    executor::TerminalTurn {
        id: "stopped-main-turn".into(),
        status,
        evidence: vec![
            json!({"id":"partial-command","type":"commandExecution","status":"completed","exitCode":0}),
        ],
    }
}

#[test]
fn confirmed_terminal_receipts_survive_reload_without_retaining_an_active_request() {
    for status in [TerminalStatus::Interrupted, TerminalStatus::Failed] {
        let directory = tempfile::tempdir().unwrap();
        let mut value = session();
        let mut work = pending_work(&value);
        work.dispatch_attempted = true;
        value.saved.pending_execution = Some(work.clone());
        value.saved.snapshot.next_step = Some("Repeat the old operation".into());
        retire_terminal_execution(&mut value, &work, terminal_turn(status.clone())).unwrap();
        storage::save(directory.path(), &value.saved).unwrap();
        let saved = storage::load(directory.path(), "yori-ja").unwrap();
        assert!(saved.pending_execution.is_none());
        assert!(saved.execution_blocked);
        assert!(saved.snapshot.next_step.is_none());
        assert_eq!(saved.snapshot.phase, "error");
        assert_eq!(saved.terminal_receipts.len(), 1);
        let receipt = &saved.terminal_receipts[0];
        assert_eq!(receipt.request_id, work.request_id);
        assert_eq!(receipt.target, work.target);
        assert_eq!(receipt.turn_id, "stopped-main-turn");
        assert_eq!(receipt.status, status);
        assert_eq!(receipt.evidence[0]["id"], "partial-command");
        assert!(!value.queued);
        // Processing a stale copy again cannot append another receipt or lose
        // the archived evidence after the active request has been consumed.
        assert!(retire_terminal_execution(&mut value, &work, terminal_turn(status)).is_err());
        assert_eq!(value.saved.terminal_receipts.len(), 1);
    }
}

#[test]
fn explicit_input_after_a_terminal_receipt_claims_a_fresh_request_with_prior_evidence() {
    for trigger in ["message", "continue", "retry"] {
        let mut value = session();
        user(
            &mut value.saved.snapshot,
            "original-request",
            "Fix the issue and verify it",
        );
        let work = pending_work(&value);
        value.saved.pending_execution = Some(work.clone());
        retire_terminal_execution(
            &mut value,
            &work,
            terminal_turn(TerminalStatus::Interrupted),
        )
        .unwrap();
        if trigger == "message" {
            user(
                &mut value.saved.snapshot,
                "new-request",
                "Inspect the existing changes first",
            );
        }
        if trigger == "retry" {
            queue_explicit_retry(&mut value, context());
        } else {
            queue(&mut value, context(), trigger);
        }
        assert!(!value.saved.execution_blocked);
        assert!(value.queued);
        let fresh = new_execution(&mut value, &context(), work.target.clone()).unwrap();
        assert_ne!(fresh.request_id, work.request_id);
        assert!(!fresh.dispatch_attempted);
        assert!(uuid::Uuid::parse_str(&fresh.request_id).is_ok());
        assert!(fresh.prompt.contains(&work.request_id));
        assert!(fresh.prompt.contains("stopped-main-turn"));
        assert!(fresh
            .prompt
            .contains("Inspect the referenced Main Agent turns and current workspace state"));
        assert!(fresh.prompt.contains("Do not blindly repeat"));
        if trigger == "message" {
            assert!(fresh.prompt.contains("Inspect the existing changes first"));
        }
        assert_eq!(value.saved.terminal_receipts.len(), 1);
    }
}

#[test]
fn automatic_triggers_cannot_restart_work_after_a_confirmed_terminal_receipt() {
    let mut value = session();
    let work = pending_work(&value);
    value.saved.pending_execution = Some(work.clone());
    retire_terminal_execution(&mut value, &work, terminal_turn(TerminalStatus::Failed)).unwrap();
    assert!(!queue_periodic(&mut value, context(), now()));
    assert!(!queue_on_open(&mut value, context()));
    // A stale UI or saved followup must not bypass the durable guard merely
    // because its phase/revision appears suitable for another background step.
    value.saved.snapshot.phase = "idle".into();
    value.saved.snapshot.next_step = Some("Retry the failed operation".into());
    let revision = value.saved.snapshot.revision;
    assert_eq!(
        queue_followup(&mut value, context(), revision),
        Advance::Unchanged
    );
    assert!(!queue_periodic(
        &mut value,
        context(),
        now() + PERIODIC_INTERVAL_MS
    ));
    assert!(!queue_on_open(&mut value, context()));
    queue(&mut value, context(), "external");
    assert!(!value.queued);
    assert!(value.saved.execution_blocked);
    assert!(new_execution(&mut value, &context(), work.target).is_err());
    assert!(value.saved.pending_execution.is_none());
}

#[test]
fn transport_failure_preserves_the_dispatched_request_for_read_only_recovery() {
    let mut value = session();
    let mut work = pending_work(&value);
    work.dispatch_attempted = true;
    value.saved.pending_execution = Some(work.clone());
    let original = serde_json::to_value(&value.saved.pending_execution).unwrap();
    record_execution_error(&mut value, "Main Agent connection unavailable".into());
    assert_eq!(
        serde_json::to_value(&value.saved.pending_execution).unwrap(),
        original
    );
    assert!(value.saved.terminal_receipts.is_empty());
    assert!(!value.saved.execution_blocked);
    queue(&mut value, context(), "retry");
    assert_eq!(
        serde_json::to_value(&value.saved.pending_execution).unwrap(),
        original
    );
    assert!(new_execution(&mut value, &context(), work.target).is_err());
    assert!(
        value
            .saved
            .pending_execution
            .as_ref()
            .unwrap()
            .dispatch_attempted
    );
}

#[test]
fn a_new_message_received_during_terminal_recovery_is_not_discarded() {
    let mut value = session();
    let work = pending_work(&value);
    value.saved.pending_execution = Some(work.clone());
    user(
        &mut value.saved.snapshot,
        "new-input",
        "Inspect the partial result and explain it",
    );
    queue(&mut value, context(), "message");
    // The worker consumes the queued job before it reads the saved terminal
    // receipt. The newer user message must remain the authority for fresh work.
    value.queued = false;
    retire_terminal_execution(
        &mut value,
        &work,
        terminal_turn(TerminalStatus::Interrupted),
    )
    .unwrap();
    assert!(value.queued);
    assert!(!value.saved.execution_blocked);
    assert_eq!(value.saved.pending_trigger.as_deref(), Some("message"));
    let fresh = new_execution(&mut value, &context(), work.target).unwrap();
    assert_ne!(fresh.request_id, work.request_id);
    assert!(fresh
        .prompt
        .contains("Inspect the partial result and explain it"));
    assert!(fresh.prompt.contains("stopped-main-turn"));
    assert!(fresh.previous_step.is_none());
}

#[test]
fn one_explicit_retry_recovers_the_old_receipt_then_resumes_with_a_fresh_id() {
    let directory = tempfile::tempdir().unwrap();
    let mut value = session();
    let mut work = pending_work(&value);
    let interrupted_step = work.previous_step.clone().unwrap();
    work.dispatch_attempted = true;
    value.saved.pending_execution = Some(work.clone());
    record_execution_error(&mut value, "Interrupted in Main Agent".into());
    queue_explicit_retry(&mut value, context());
    assert!(value.saved.resume_after_recovery);
    // Preserve the explicit click across interruption/reload while confirmation
    // is pending; it must never authorize replay of the original request ID.
    storage::save(directory.path(), &value.saved).unwrap();
    value.saved = storage::load(directory.path(), "yori-ja").unwrap();
    assert!(value.saved.resume_after_recovery);
    assert_eq!(
        value.saved.pending_execution.as_ref().unwrap().request_id,
        work.request_id
    );
    value.queued = false;
    retire_terminal_execution(
        &mut value,
        &work,
        terminal_turn(TerminalStatus::Interrupted),
    )
    .unwrap();
    assert!(value.queued);
    assert!(!value.saved.execution_blocked);
    assert!(!value.saved.resume_after_recovery);
    let fresh = new_execution(&mut value, &context(), work.target).unwrap();
    assert_ne!(fresh.request_id, work.request_id);
    assert!(fresh.prompt.contains("stopped-main-turn"));
    assert!(fresh.previous_step.is_none());
    assert!(fresh.prompt.contains(&interrupted_step));
    assert_eq!(
        value.saved.terminal_receipts[0].previous_step.as_deref(),
        Some(interrupted_step.as_str())
    );
}

#[test]
fn timer_recovery_of_an_old_interruption_does_not_authorize_a_fresh_request() {
    let mut value = session();
    let mut work = pending_work(&value);
    work.dispatch_attempted = true;
    value.saved.pending_execution = Some(work.clone());
    record_execution_error(&mut value, "Interrupted in Main Agent".into());
    assert!(queue_periodic(&mut value, context(), now()));
    assert!(!value.saved.resume_after_recovery);
    value.queued = false;
    retire_terminal_execution(
        &mut value,
        &work,
        terminal_turn(TerminalStatus::Interrupted),
    )
    .unwrap();
    assert!(!value.queued);
    assert!(value.saved.execution_blocked);
    assert!(value.saved.pending_execution.is_none());
    assert!(!queue_periodic(
        &mut value,
        context(),
        now() + PERIODIC_INTERVAL_MS
    ));
    assert!(new_execution(&mut value, &context(), work.target).is_err());
}

#[test]
fn real_work_can_continue_without_a_user_reply_but_new_input_prevents_a_stale_followup() {
    let mut value = session();
    user(
        &mut value.saved.snapshot,
        "request",
        "Fix the issue and verify it",
    );
    value.saved.snapshot.messages.push(Message {
        id: "question".into(),
        role: "assistant".into(),
        content: "Where should I start?".into(),
        created_at: 2,
        source: "conversation".into(),
        reply_kind: None,
    });
    let work = pending_work(&value);
    let result = || {
        response(
            json!({"reply":"Fixed the issue and verified the behavior.","understandings":[],"drafts":[],"reflection":"","nextStep":"Review the remaining regression case"}),
        )
    };
    apply_execution(&mut value, result(), &work, true).unwrap();
    assert_eq!(
        value.saved.snapshot.messages.last().unwrap().content,
        "Fixed the issue and verified the behavior."
    );
    assert_eq!(
        value.saved.snapshot.next_step.as_deref(),
        Some("Review the remaining regression case")
    );

    user(
        &mut value.saved.snapshot,
        "new",
        "Focus on a different issue now",
    );
    apply_execution(&mut value, result(), &work, true).unwrap();
    assert!(value.saved.snapshot.next_step.is_none());
}

#[test]
fn completed_reports_allow_one_new_proposal_after_reload() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(
        &mut snapshot,
        "u1",
        "Suggest useful next work after completing tasks",
    );
    let result = |text: &str, kind: &str| {
        response(json!({
            "reply":text,"replyKind":kind,"understandings":[],"drafts":[],
            "reflection":"","nextStep":"Do not execute an unapproved proposal"
        }))
    };
    apply(
        &mut snapshot,
        result("The requested fix is complete", "report"),
        "message",
        &[],
    )
    .unwrap();
    snapshot = serde_json::from_value(serde_json::to_value(snapshot).unwrap()).unwrap();
    apply(
        &mut snapshot,
        result(
            "Next, improve recovery because receipts are ambiguous",
            "awaitingReply",
        ),
        "return",
        &[],
    )
    .unwrap();
    assert_eq!(snapshot.messages.len(), 3);
    assert!(snapshot.next_step.is_none());
    // Rewording must not trigger another proposal, including after reopening.
    snapshot = serde_json::from_value(serde_json::to_value(snapshot).unwrap()).unwrap();
    apply(
        &mut snapshot,
        result("Another way to improve recovery", "awaitingReply"),
        "return",
        &[],
    )
    .unwrap();
    assert_eq!(snapshot.messages.len(), 3);
}

#[test]
fn a_later_report_does_not_hide_an_unanswered_proposal() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(&mut snapshot, "u1", "Improve the app");
    for (text, kind) in [
        ("Review the navigation?", "awaitingReply"),
        ("The previous fix is complete", "report"),
    ] {
        apply(&mut snapshot, response(json!({"reply":text,"replyKind":kind,"understandings":[],"drafts":[],"reflection":"","nextStep":null})), "message", &[]).unwrap();
    }
    apply(&mut snapshot, response(json!({"reply":"Try reviewing navigation next?","replyKind":"awaitingReply","understandings":[],"drafts":[],"reflection":"","nextStep":null})), "return", &[]).unwrap();
    assert_eq!(snapshot.messages.len(), 3);
}

#[test]
fn observed_voice_reports_can_allow_suggestions_but_questions_keep_waiting() {
    for (kind, expected_messages) in [("report", 3), ("awaitingReply", 2)] {
        let mut snapshot = Snapshot::new("yori-ja");
        user(&mut snapshot, "u1", "Suggest the next useful task");
        snapshot.messages.push(Message {
            id: "voice-reply".into(),
            role: "assistant".into(),
            content: "Observed voice reply".into(),
            created_at: 2,
            source: "voice".into(),
            reply_kind: None,
        });
        apply(&mut snapshot, response(json!({
            "reply":"Review recovery because receipts can be ambiguous", "replyKind":"awaitingReply",
            "observedReply":{"messageId":"voice-reply","kind":kind},
            "understandings":[],"drafts":[],"reflection":"","nextStep":null
        })), "return", &[]).unwrap();
        assert_eq!(snapshot.messages.len(), expected_messages);
    }
}

#[test]
fn observed_reply_classification_rejects_old_ids_without_partial_updates() {
    let mut snapshot = Snapshot::new("yori-ja");
    user(&mut snapshot, "u1", "An actual request");
    let before = serde_json::to_value(&snapshot).unwrap();
    assert!(apply(
        &mut snapshot,
        response(json!({
            "reply":"", "observedReply":{"messageId":"u1","kind":"report"},
            "understandings":[],"drafts":[],"reflection":"","nextStep":null
        })),
        "external",
        &[]
    )
    .is_err());
    assert_eq!(serde_json::to_value(&snapshot).unwrap(), before);
}

#[test]
fn new_input_during_work_does_not_reject_a_completed_report_with_old_voice_classification() {
    let mut value = session();
    user(&mut value.saved.snapshot, "u1", "Fix the problem");
    value.saved.snapshot.messages.push(Message {
        id: "voice".into(),
        role: "assistant".into(),
        content: "Earlier report".into(),
        source: "voice".into(),
        created_at: 2,
        reply_kind: None,
    });
    let work = pending_work(&value);
    user(
        &mut value.saved.snapshot,
        "u2",
        "Also consider this correction",
    );
    apply_execution(
        &mut value,
        response(json!({
            "reply":"The fix is complete", "replyKind":"report",
            "observedReply":{"messageId":"voice","kind":"report"},
            "understandings":[],"drafts":[],"reflection":"","nextStep":"Continue"
        })),
        &work,
        true,
    )
    .unwrap();
    assert_eq!(
        value.saved.snapshot.messages.last().unwrap().content,
        "The fix is complete"
    );
    assert!(value.saved.snapshot.messages[1].reply_kind.is_none());
    assert!(value.saved.snapshot.next_step.is_none());
}
