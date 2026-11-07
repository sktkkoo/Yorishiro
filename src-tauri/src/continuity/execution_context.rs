//! Budgeted, reversible projection of native evidence for a new execution.
//!
//! Canonical Saved data and accepted payloads are never modified here. Omitted
//! records remain addressable through the host's request-scoped archive tool.
use super::execution_target::ExecutionTarget;
use super::types::{Context, ExecutionReceipt, ReplyKind, Saved, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Reverse;
use std::collections::BTreeSet;

pub(super) const MAX_PROMPT_UTF8_BYTES: usize = 96 * 1024;
pub(super) const MAX_SUBMIT_UTF8_BYTES: usize = 256 * 1024;
pub(super) const ESSENTIAL_CONTEXT_TOO_LARGE: &str =
    "The original user requests and required corrections exceed the execution context budget; they were preserved without truncation.";
const ENCODING_ERROR: &str = "Could not encode the bounded execution context.";
const MISSING_CORRECTION: &str =
    "A required correction or its original source is missing; no execution was started.";
const MAX_RECEIPT_EVENTS_BYTES: usize = 2048;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct BudgetReport {
    pub prompt_utf8_bytes: usize,
    pub request_payload_utf8_bytes: usize,
    pub managed_submit_utf8_bytes: usize,
    pub legacy_submit_utf8_bytes: usize,
    pub omitted_message_count: usize,
    pub archived_receipt_count: usize,
}

#[derive(Clone, Debug)]
pub(super) struct Projection {
    pub prompt: String,
    pub request_payload: String,
    pub budget: BudgetReport,
}

#[derive(Clone, Default)]
struct Selection {
    messages: BTreeSet<usize>,
    understandings: BTreeSet<usize>,
    drafts: BTreeSet<usize>,
    reflections: BTreeSet<usize>,
}

fn digest(value: &impl Serialize) -> Result<String, String> {
    let bytes = serde_json::to_vec(value).map_err(|_| ENCODING_ERROR.to_owned())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn source_messages(snapshot: &Snapshot, selection: &mut Selection, sources: &[String]) -> bool {
    for source in sources {
        let Some(index) = snapshot
            .messages
            .iter()
            .position(|message| &message.id == source)
        else {
            return false;
        };
        selection.messages.insert(index);
    }
    true
}

fn include_understanding(snapshot: &Snapshot, selection: &mut Selection, index: usize) -> bool {
    let understanding = &snapshot.understandings[index];
    if !source_messages(snapshot, selection, &understanding.source_ids) {
        return false;
    }
    for revision in &understanding.revisions {
        if !source_messages(snapshot, selection, &revision.source_ids) {
            return false;
        }
    }
    selection.understandings.insert(index);
    true
}

fn projected(snapshot: &Snapshot, selected: &Selection) -> Snapshot {
    let mut projection = Snapshot {
        persona_id: snapshot.persona_id.clone(),
        revision: snapshot.revision,
        auto_enabled: snapshot.auto_enabled,
        phase: snapshot.phase.clone(),
        messages: vec![],
        understandings: vec![],
        drafts: vec![],
        reflections: vec![],
        error: snapshot.error.clone(),
        last_observed_at: snapshot.last_observed_at,
        next_step: snapshot.next_step.clone(),
    };
    projection.messages = selected
        .messages
        .iter()
        .map(|index| snapshot.messages[*index].clone())
        .collect();
    projection.understandings = selected
        .understandings
        .iter()
        .map(|index| snapshot.understandings[*index].clone())
        .collect();
    projection.drafts = selected
        .drafts
        .iter()
        .map(|index| snapshot.drafts[*index].clone())
        .collect();
    projection.reflections = selected
        .reflections
        .iter()
        .map(|index| snapshot.reflections[*index].clone())
        .collect();
    projection
}

fn receipt_summary(receipt: &ExecutionReceipt, index: usize) -> Result<Value, String> {
    let target = match &receipt.target {
        ExecutionTarget::Codex(target) => {
            json!({"backend":"codex", "threadId":target.thread_id,"cwd":target.cwd})
        }
        ExecutionTarget::Pi(target) => {
            if let Some(identity) = &target.managed {
                json!({"backend":"pi","identity":identity})
            } else {
                json!({"backend":"pi", "sessionDir":target.session_dir,"cwd":target.cwd})
            }
        }
    };
    let mut events = Vec::new();
    let mut bytes = 0;
    for event in &receipt.evidence {
        let length = serde_json::to_vec(event)
            .map_err(|_| ENCODING_ERROR.to_owned())?
            .len();
        if bytes + length + 1 > MAX_RECEIPT_EVENTS_BYTES {
            continue;
        }
        bytes += length + 1;
        events.push(event);
    }
    let previous_step = match &receipt.previous_step {
        Some(step) if step.len() <= MAX_RECEIPT_EVENTS_BYTES => Some(step),
        _ => None,
    };
    Ok(json!({
        "archiveItemIndex":index, "requestId":receipt.request_id,"turnId":receipt.turn_id,
        "status":receipt.status,"observedAt":receipt.observed_at,"target":target,
        "previousStep":previous_step,"previousStepSha256":digest(&receipt.previous_step)?,
        "evidenceCount":receipt.evidence.len(),"evidenceSha256":digest(&receipt.evidence)?,
        "evidence":events,"evidenceComplete":events.len()==receipt.evidence.len(),
    }))
}

fn archive_manifest(saved: &Saved, request_id: &str) -> Result<Value, String> {
    let snapshot = &saved.snapshot;
    let recent = saved
        .terminal_receipts
        .iter()
        .enumerate()
        .rev()
        .take(3)
        .map(|(index, receipt)| receipt_summary(receipt, index))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(json!({
        "version":1,"requestId":request_id,
        "originalLatestMessageId":snapshot.messages.last().map(|message| &message.id),
        "collections":{
            "messages":{"totalCount":snapshot.messages.len(),"nativeCollectionEncodingSha256":digest(&snapshot.messages)?},
            "understandings":{"totalCount":snapshot.understandings.len(),"nativeCollectionEncodingSha256":digest(&snapshot.understandings)?},
            "drafts":{"totalCount":snapshot.drafts.len(),"nativeCollectionEncodingSha256":digest(&snapshot.drafts)?},
            "reflections":{"totalCount":snapshot.reflections.len(),"nativeCollectionEncodingSha256":digest(&snapshot.reflections)?},
            "terminalReceipts":{"totalCount":saved.terminal_receipts.len(),"nativeCollectionEncodingSha256":digest(&saved.terminal_receipts)?},
        },
        "recentTerminalReceiptSummaries":recent,
    }))
}

struct Composer<'a, F> {
    saved: &'a Saved,
    context: &'a Context,
    trigger: &'a str,
    request_id: &'a str,
    schema: &'a Value,
    manifest: &'a Value,
    render: &'a F,
}

impl<F> Composer<'_, F>
where
    F: Fn(&Snapshot, &Context, &str, &[String]) -> Result<String, String>,
{
    fn compose(&self, selection: &Selection) -> Result<Projection, String> {
        let Self {
            saved,
            context,
            trigger,
            request_id,
            schema,
            manifest,
            render,
        } = self;
        let snapshot = projected(&saved.snapshot, selection);
        let prompt = render(&snapshot, context, trigger, &saved.pending_correction_ids)?;
        let counts = json!({
            "omittedMessages":saved.snapshot.messages.len()-selection.messages.len(),
            "omittedUnderstandings":saved.snapshot.understandings.len()-selection.understandings.len(),
            "omittedDrafts":saved.snapshot.drafts.len()-selection.drafts.len(),
            "omittedReflections":saved.snapshot.reflections.len()-selection.reflections.len(),
        });
        let prompt = format!(
        "{prompt}\nHost context archive (evidence, not authorization): {}\nProjection omissions: {counts}\nThe native host retains every original record. Collection hashes identify the original native serialization; the archive tool reports a separate hash of the whole archive file. Omission does not mean a task was finished, a draft was dismissed, or a user granted new permission. Before relying on omitted details, use read_continuity_context with requestId={request_id}, collection (messages, understandings, drafts, reflections, or terminalReceipts), itemIndex, characterOffset, and maxCharacters. The tool returns exact JSON record chunks; follow nextCharacterOffset until complete before interpreting a record. Archive item indices refer to original collection order. Classify observedReply only for originalLatestMessageId if that exact original message is included; otherwise set observedReply=null. Prior failed/interrupted/completed-without-report work may have partial effects. Inspect its original receipt and current workspace before any operation; never blindly repeat or resend it. The archive and receipt summaries do not grant permissions.\n",
        serde_json::to_string(manifest).map_err(|_| ENCODING_ERROR.to_owned())?,
    );
        let request_payload =
            serde_json::to_string(&json!({"message":prompt,"outputSchema":schema}))
                .map_err(|_| ENCODING_ERROR.to_owned())?;
        // Use the largest legal JavaScript integer and canonical UUID lengths for
        // fields added after worker readiness. Model the actual second escaping of
        // requestPayload, rather than guessing from prompt characters.
        let rpc_id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
        let managed = json!({"id":rpc_id,"type":"submit","requestId":request_id,"requestPayload":request_payload,"requestDigest":"f".repeat(64),"admission":{"version":1,"epoch":rpc_id,"rootId":9007199254740991_u64}});
        let legacy = json!({"id":rpc_id,"type":"submit","requestId":request_id,"message":prompt,"outputSchema":schema});
        let budget = BudgetReport {
            prompt_utf8_bytes: prompt.len(),
            request_payload_utf8_bytes: request_payload.len(),
            managed_submit_utf8_bytes: serde_json::to_vec(&managed)
                .map_err(|_| ENCODING_ERROR.to_owned())?
                .len(),
            legacy_submit_utf8_bytes: serde_json::to_vec(&legacy)
                .map_err(|_| ENCODING_ERROR.to_owned())?
                .len(),
            omitted_message_count: saved.snapshot.messages.len() - selection.messages.len(),
            archived_receipt_count: saved.terminal_receipts.len(),
        };
        Ok(Projection {
            prompt,
            request_payload,
            budget,
        })
    }

    fn attempt(
        &self,
        candidate: Selection,
        selected: &mut Selection,
        result: &mut Projection,
    ) -> Result<(), String> {
        let value = self.compose(&candidate)?;
        if within_budget(&value) {
            *selected = candidate;
            *result = value;
        }
        Ok(())
    }
}

fn within_budget(projection: &Projection) -> bool {
    projection.budget.prompt_utf8_bytes <= MAX_PROMPT_UTF8_BYTES
        && projection.budget.managed_submit_utf8_bytes <= MAX_SUBMIT_UTF8_BYTES
        && projection.budget.legacy_submit_utf8_bytes <= MAX_SUBMIT_UTF8_BYTES
}

/// Construct a new request only. Never use this to rewrite an accepted payload.
pub(super) fn build(
    saved: &Saved,
    context: &Context,
    trigger: &str,
    request_id: &str,
    schema: &Value,
    render: impl Fn(&Snapshot, &Context, &str, &[String]) -> Result<String, String>,
) -> Result<Projection, String> {
    let snapshot = &saved.snapshot;
    let mut selected = Selection::default();
    for (index, message) in snapshot.messages.iter().enumerate() {
        if message.role == "user" && message.source != "legacy" {
            selected.messages.insert(index);
        }
    }
    if let Some((index, _)) = snapshot
        .messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, message)| {
            message.role == "assistant" && message.reply_kind == Some(ReplyKind::AwaitingReply)
        })
    {
        selected.messages.insert(index);
    }
    if let Some((index, message)) = snapshot.messages.iter().enumerate().next_back() {
        if message.role == "assistant"
            && matches!(message.source.as_str(), "voice" | "external")
            && message.reply_kind.is_none()
        {
            selected.messages.insert(index);
        }
    }
    for correction in &saved.pending_correction_ids {
        let Some(index) = snapshot
            .understandings
            .iter()
            .position(|understanding| &understanding.id == correction)
        else {
            return Err(MISSING_CORRECTION.into());
        };
        if !include_understanding(snapshot, &mut selected, index) {
            return Err(MISSING_CORRECTION.into());
        }
    }
    let manifest = archive_manifest(saved, request_id)?;
    let composer = Composer {
        saved,
        context,
        trigger,
        request_id,
        schema,
        manifest: &manifest,
        render: &render,
    };
    let mut result = composer.compose(&selected)?;
    if !within_budget(&result) {
        return Err(ESSENTIAL_CONTEXT_TOO_LARGE.into());
    }
    // Add whole records together with their source dependencies. A failed
    // candidate leaves the accepted selection unchanged, never half a record.
    // A separate helper scope per candidate avoids coupling later source
    // selection to rejected (oversized or dangling-reference) candidates.
    let mut drafts = (0..snapshot.drafts.len()).collect::<Vec<_>>();
    drafts.sort_by_key(|index| {
        let draft = &snapshot.drafts[*index];
        (
            draft.status == "dismissed",
            Reverse(draft.updated_at),
            Reverse(*index),
        )
    });
    for index in drafts {
        let mut candidate = selected.clone();
        if source_messages(snapshot, &mut candidate, &snapshot.drafts[index].source_ids) {
            candidate.drafts.insert(index);
            composer.attempt(candidate, &mut selected, &mut result)?;
        }
    }
    let mut understandings = (0..snapshot.understandings.len()).collect::<Vec<_>>();
    understandings.sort_by_key(|index| {
        (
            Reverse(snapshot.understandings[*index].updated_at),
            Reverse(*index),
        )
    });
    for index in understandings {
        let mut candidate = selected.clone();
        if include_understanding(snapshot, &mut candidate, index) {
            composer.attempt(candidate, &mut selected, &mut result)?;
        }
    }
    for index in (0..snapshot.reflections.len()).rev().take(3) {
        let mut candidate = selected.clone();
        let reflection = &snapshot.reflections[index];
        let mut complete = source_messages(snapshot, &mut candidate, &reflection.source_ids);
        for id in &reflection.understanding_ids {
            if let Some(index) = snapshot
                .understandings
                .iter()
                .position(|understanding| &understanding.id == id)
            {
                complete &= include_understanding(snapshot, &mut candidate, index);
            } else {
                complete = false;
            }
        }
        if complete {
            candidate.reflections.insert(index);
            composer.attempt(candidate, &mut selected, &mut result)?;
        }
    }
    for index in (0..snapshot.messages.len()).rev() {
        let mut candidate = selected.clone();
        candidate.messages.insert(index);
        composer.attempt(candidate, &mut selected, &mut result)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::continuity::types::{Certainty, Message, Revision, TerminalStatus, Understanding};

    const REQUEST: &str = "6e01b64d-ae42-4dcc-9781-3c3ad6fdc17a";

    fn saved() -> Saved {
        serde_json::from_value(
            json!({"version":1,"snapshot":Snapshot::new("yori-ja"),"autoEnabled":true}),
        )
        .unwrap()
    }

    fn context() -> Context {
        serde_json::from_value(json!({
            "personaId":"yori-ja","personaName":"Yori","personaPrompt":"Respect user boundaries.",
            "language":"ja","cwd":"/workspace","executionBackend":"pi"
        }))
        .unwrap()
    }

    fn message(id: &str, role: &str, content: String) -> Message {
        Message {
            id: id.into(),
            role: role.into(),
            content,
            created_at: 1,
            source: "conversation".into(),
            reply_kind: None,
        }
    }

    fn render(
        snapshot: &Snapshot,
        context: &Context,
        trigger: &str,
        corrections: &[String],
    ) -> Result<String, String> {
        Ok(format!(
            "Persona:{} Trigger:{trigger} Corrections:{corrections:?}\n{}",
            context.persona_prompt,
            serde_json::to_string(snapshot).unwrap()
        ))
    }

    fn run(saved: &Saved) -> Result<Projection, String> {
        build(
            saved,
            &context(),
            "return",
            REQUEST,
            &json!({"type":"object"}),
            render,
        )
    }

    fn receipt(index: usize) -> ExecutionReceipt {
        ExecutionReceipt {
            request_id: format!("request-{index}"),
            target: ExecutionTarget::Codex(crate::continuity::executor::Target {
                session_id: "transport".into(),
                thread_id: format!("durable-thread-{index}"),
                cwd: "/workspace".into(),
                launch_id: "launch".into(),
            }),
            turn_id: format!("turn-{index}"),
            status: TerminalStatus::Failed,
            observed_at: index as u64,
            previous_step: Some("large prior step ".repeat(300)),
            evidence: vec![
                json!({"receipt":"large event ".repeat(400)}),
                json!({"partialEffects":true}),
            ],
        }
    }

    #[test]
    fn hundreds_of_large_receipts_are_reversible_summaries_not_unbounded_prompt() {
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "scope",
            "user",
            "Continue the delegated project; never publish without approval.".into(),
        ));
        saved.terminal_receipts = (0..359).map(receipt).collect();
        let before = serde_json::to_vec(&saved).unwrap();
        let projection = run(&saved).unwrap();
        assert!(projection.prompt.len() < 20 * 1024);
        assert!(projection.prompt.contains("request-358"));
        assert!(projection.prompt.contains("turn-357"));
        assert!(projection.prompt.contains("durable-thread-356"));
        assert!(!projection.prompt.contains("turn-355"));
        assert!(projection
            .prompt
            .contains(&digest(&saved.terminal_receipts).unwrap()));
        assert!(projection.prompt.contains("read_continuity_context"));
        assert!(projection.prompt.contains(REQUEST));
        assert_eq!(projection.budget.archived_receipt_count, 359);
        assert_eq!(before, serde_json::to_vec(&saved).unwrap());
    }

    #[test]
    fn old_user_authority_and_latest_awaiting_reply_survive_large_chatter() {
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "old-user",
            "user",
            "NEVER_UPLOAD_PRIVATE_FILES".into(),
        ));
        for index in 0..120 {
            let mut report = message(
                &format!("report-{index}"),
                "assistant",
                "検討しただけです。".repeat(180),
            );
            report.reply_kind = Some(ReplyKind::Report);
            saved.snapshot.messages.push(report);
        }
        let mut proposal = message(
            "proposal",
            "assistant",
            "Need explicit approval for deployment.".into(),
        );
        proposal.reply_kind = Some(ReplyKind::AwaitingReply);
        saved.snapshot.messages.insert(2, proposal);
        saved.snapshot.next_step = Some("Finish the authorized local draft first.".into());
        let projection = run(&saved).unwrap();
        assert!(projection.prompt.contains("NEVER_UPLOAD_PRIVATE_FILES"));
        assert!(projection
            .prompt
            .contains("Need explicit approval for deployment."));
        assert!(projection
            .prompt
            .contains("Finish the authorized local draft first."));
        assert!(projection.budget.omitted_message_count > 0);
        assert!(within_budget(&projection));
    }

    #[test]
    fn required_correction_keeps_all_original_and_revision_sources() {
        let mut saved = saved();
        let mut legacy = message(
            "original-source",
            "assistant",
            "Exact older supporting statement".into(),
        );
        legacy.source = "legacy".into();
        saved.snapshot.messages.push(legacy);
        saved.snapshot.messages.push(message(
            "correction-source",
            "user",
            "Do not use that inferred preference.".into(),
        ));
        saved.snapshot.understandings.push(Understanding {
            id: "correction-target".into(),
            title: "Preference".into(),
            value: "Corrected preference".into(),
            certainty: Certainty::Confirmed,
            source_ids: vec!["correction-source".into()],
            updated_at: 2,
            revisions: vec![Revision {
                value: "Prior preference".into(),
                reason: "older".into(),
                source_ids: vec!["original-source".into()],
                created_at: 1,
            }],
        });
        saved
            .pending_correction_ids
            .push("correction-target".into());
        let projection = run(&saved).unwrap();
        for value in [
            "correction-target",
            "original-source",
            "Exact older supporting statement",
            "Corrected preference",
            "correction-source",
        ] {
            assert!(projection.prompt.contains(value), "missing {value}");
        }
    }

    #[test]
    fn missing_correction_or_source_fails_closed() {
        let mut saved = saved();
        saved.pending_correction_ids.push("missing".into());
        assert_eq!(run(&saved).unwrap_err(), MISSING_CORRECTION);
        saved.snapshot.understandings.push(Understanding {
            id: "missing".into(),
            title: "x".into(),
            value: "y".into(),
            certainty: Certainty::Unverified,
            source_ids: vec!["absent-source".into()],
            updated_at: 0,
            revisions: vec![],
        });
        assert_eq!(run(&saved).unwrap_err(), MISSING_CORRECTION);
    }

    #[test]
    fn essential_context_overflow_is_not_silently_truncated() {
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "authority",
            "user",
            "同意なしに公開しない。".repeat(12000),
        ));
        let before = serde_json::to_vec(&saved).unwrap();
        assert_eq!(run(&saved).unwrap_err(), ESSENTIAL_CONTEXT_TOO_LARGE);
        assert_eq!(before, serde_json::to_vec(&saved).unwrap());
    }

    #[test]
    fn double_escaped_unicode_wire_budget_matches_actual_serialization() {
        let mut saved = saved();
        saved
            .snapshot
            .messages
            .push(message("unicode", "user", "🦊継続\"\\\n".repeat(1800)));
        let projection = run(&saved).unwrap();
        let frame = json!({"id":"ffffffff-ffff-ffff-ffff-ffffffffffff","type":"submit","requestId":REQUEST,"requestPayload":projection.request_payload,"requestDigest":"f".repeat(64),"admission":{"version":1,"epoch":"ffffffff-ffff-ffff-ffff-ffffffffffff","rootId":9007199254740991_u64}});
        assert_eq!(
            projection.budget.managed_submit_utf8_bytes,
            serde_json::to_vec(&frame).unwrap().len()
        );
        assert_eq!(projection.budget.prompt_utf8_bytes, projection.prompt.len());
        assert_eq!(
            projection.budget.request_payload_utf8_bytes,
            projection.request_payload.len()
        );
        assert!(
            projection.budget.managed_submit_utf8_bytes
                > projection.budget.request_payload_utf8_bytes
        );
        assert!(within_budget(&projection));
    }

    #[test]
    fn original_latest_message_guard_is_explicit_and_cannot_borrow_old_voice() {
        let mut saved = saved();
        let mut voice = message(
            "old-voice",
            "assistant",
            "An older unclassified voice statement.".into(),
        );
        voice.source = "voice".into();
        saved.snapshot.messages.push(voice);
        saved.snapshot.messages.push(message(
            "latest-user",
            "user",
            "The actual latest instruction.".into(),
        ));
        let projection = run(&saved).unwrap();
        assert!(projection
            .prompt
            .contains("\"originalLatestMessageId\":\"latest-user\""));
        assert!(projection
            .prompt
            .contains("otherwise set observedReply=null"));
    }

    #[test]
    fn active_updated_draft_is_not_starved_by_large_old_dismissed_content() {
        use crate::continuity::types::Draft;
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "request",
            "user",
            "Continue the current draft.".into(),
        ));
        let make_draft = |id: &str, status: &str, updated_at, content| Draft {
            id: id.into(),
            title: id.into(),
            content,
            reason: "Existing local work".into(),
            status: status.into(),
            source_ids: vec!["request".into()],
            created_at: 1,
            updated_at,
        };
        saved.snapshot.drafts.push(make_draft(
            "active-current",
            "active",
            20,
            format!("{}CURRENT_ACTIVE_WORK", "a".repeat(60000)),
        ));
        saved.snapshot.drafts.push(make_draft(
            "old-dismissed",
            "dismissed",
            10,
            format!("{}DISMISSED_OLD_CONTENT", "b".repeat(50000)),
        ));
        let projection = run(&saved).unwrap();
        assert!(projection.prompt.contains("CURRENT_ACTIVE_WORK"));
        assert!(!projection.prompt.contains("DISMISSED_OLD_CONTENT"));
        assert!(within_budget(&projection));
    }

    #[test]
    #[ignore = "explicit private Saved snapshot fixture; read-only and no provider calls"]
    fn private_saved_context_budget() {
        let path = std::env::var_os("YORISHIRO_CONTEXT_SNAPSHOT")
            .expect("Set YORISHIRO_CONTEXT_SNAPSHOT to an absolute Saved JSON fixture");
        let path = std::path::Path::new(&path);
        assert!(
            path.is_absolute(),
            "The private fixture must be an absolute path"
        );
        let bytes = std::fs::read(path).expect("Could not read the explicit private fixture");
        let saved: Saved =
            serde_json::from_slice(&bytes).expect("The private fixture is not Saved JSON");
        let before = serde_json::to_vec(&saved).unwrap();
        let context = saved
            .pending_execution
            .as_ref()
            .map(|work| &work.context)
            .or(saved.auto_context.as_ref())
            .expect("The private fixture has no execution context");
        let projection = build(
            &saved,
            context,
            "return",
            REQUEST,
            &crate::continuity::execution_schema(),
            crate::continuity::execution_prompt,
        )
        .unwrap();
        assert!(within_budget(&projection));
        assert_eq!(before, serde_json::to_vec(&saved).unwrap());
        // Budget metadata only. Never print the fixture path, prompt, saved
        // conversation, source evidence, or authentication references.
        println!("{}", serde_json::to_string(&projection.budget).unwrap());
    }

    #[test]
    fn production_renderer_and_schema_fit_the_same_explicit_budget() {
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "scope",
            "user",
            "Complete useful local work within the entrusted scope.".into(),
        ));
        saved.terminal_receipts = (0..400).map(receipt).collect();
        let projection = build(
            &saved,
            &context(),
            "return",
            REQUEST,
            &crate::continuity::execution_schema(),
            crate::continuity::execution_prompt,
        )
        .unwrap();
        assert!(within_budget(&projection));
        assert!(projection.prompt.contains("never blindly repeat or resend"));
        assert_eq!(
            serde_json::from_str::<Value>(&projection.request_payload).unwrap()["message"],
            projection.prompt
        );
    }
}
