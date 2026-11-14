//! Budgeted, reversible projection of native evidence for a new execution.
//!
//! Canonical Saved data and accepted payloads are never modified here. Omitted
//! records remain addressable through the backend's bounded context reader.
use super::execution_target::ExecutionTarget;
use super::types::{Context, ExecutionBackend, ExecutionReceipt, ReplyKind, Saved, Snapshot};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Reverse;
use std::collections::BTreeSet;

pub(super) const MAX_PROMPT_UTF8_BYTES: usize = 96 * 1024;
pub(super) const MAX_SUBMIT_UTF8_BYTES: usize = 256 * 1024;
const FIXED_CONTEXT_TOO_LARGE: &str =
    "The fixed execution instructions exceed the transport budget; retained conversation was not truncated.";
const MAX_INLINE_EVIDENCE_BYTES: usize = 24 * 1024;
const MAX_INLINE_USER_MESSAGES: usize = 8;
const MAX_INLINE_EXPLICIT_MEMORIES: usize = 8;
const MAX_INLINE_CORRECTION_IDS: usize = 16;
const TEXT_CONTEXT_REQUIRES_RETRIEVAL: &str = "This text-only connection cannot retrieve an oversized current request or required correction. Use a tool-enabled connection; the original evidence is preserved.";
const ENCODING_ERROR: &str = "Could not encode the bounded execution context.";
const MISSING_CORRECTION: &str =
    "A required correction or its original source is missing; no execution was started.";
const MISSING_EXPLICIT_MEMORY: &str =
    "An explicit memory request or its original context is missing; no execution was started.";
const MAX_RECEIPT_EVENTS_BYTES: usize = 2048;
const MAX_OPTIONAL_MESSAGES: usize = 6;
const MAX_OPTIONAL_UNDERSTANDINGS: usize = 8;
const MAX_OPTIONAL_DRAFTS: usize = 3;
const MAX_OPTIONAL_REFLECTIONS: usize = 3;
const MAX_FORGETTING_HINTS: usize = 8;

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
    forgotten_understandings: BTreeSet<usize>,
    explicit_memories: BTreeSet<usize>,
    next_step: bool,
}

fn explicit_memory_is_active(snapshot: &Snapshot, memory: &super::types::ExplicitMemory) -> bool {
    !snapshot.forgotten_understandings.iter().any(|forgotten| {
        forgotten.source_ids.iter().any(|source| {
            source == &memory.request_message_id || memory.source_ids.contains(source)
        })
    })
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
        explicit_memories: selected
            .explicit_memories
            .iter()
            .map(|index| snapshot.explicit_memories[*index].clone())
            .collect(),
        forgotten_understandings: selected
            .forgotten_understandings
            .iter()
            .map(|index| snapshot.forgotten_understandings[*index].clone())
            .collect(),
        error: snapshot.error.clone(),
        last_observed_at: snapshot.last_observed_at,
        next_step: if selected.next_step {
            snapshot.next_step.clone()
        } else {
            None
        },
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

fn preview(text: &str) -> String {
    text.chars().take(120).collect()
}

fn recent_index<T: Serialize>(items: &[T], count: usize) -> Result<Vec<Value>, String> {
    items
        .iter()
        .enumerate()
        .rev()
        .take(count)
        .map(|(index, item)| {
            let record = serde_json::to_value(item).map_err(|_| ENCODING_ERROR.to_owned())?;
            let body = record
                .get("content")
                .or_else(|| record.get("value"))
                .or_else(|| record.get("title"))
                .and_then(Value::as_str)
                .unwrap_or("");
            Ok(
                json!({"itemIndex":index,"id":record.get("id"),"role":record.get("role"),
            "preview":preview(body),"previewOnly":true}),
            )
        })
        .collect()
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
        "version":2,"requestId":request_id,"personaId":snapshot.persona_id,"revision":snapshot.revision,
        "originalLatestMessageId":snapshot.messages.last().map(|message| &message.id),
        "collections":{
            "messages":{"totalCount":snapshot.messages.len(),"nativeCollectionEncodingSha256":digest(&snapshot.messages)?},
            "understandings":{"totalCount":snapshot.understandings.len(),"nativeCollectionEncodingSha256":digest(&snapshot.understandings)?},
            "drafts":{"totalCount":snapshot.drafts.len(),"nativeCollectionEncodingSha256":digest(&snapshot.drafts)?},
            "reflections":{"totalCount":snapshot.reflections.len(),"nativeCollectionEncodingSha256":digest(&snapshot.reflections)?},
            "terminalReceipts":{"totalCount":saved.terminal_receipts.len(),"nativeCollectionEncodingSha256":digest(&saved.terminal_receipts)?},
            "explicitMemories":{"totalCount":snapshot.explicit_memories.len()},
            "forgottenUnderstandings":{"totalCount":snapshot.forgotten_understandings.len()},
            "state":{"totalCount":1},
        },
        "recentIndex":{
            "messages":recent_index(&snapshot.messages,6)?,
            "understandings":recent_index(&snapshot.understandings,2)?,
            "drafts":recent_index(&snapshot.drafts,2)?,
        },
        "pendingCorrectionCount":saved.pending_correction_ids.len(),
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
        let prompt = render(
            &snapshot,
            context,
            trigger,
            &saved.pending_correction_ids[..saved
                .pending_correction_ids
                .len()
                .min(MAX_INLINE_CORRECTION_IDS)],
        )?;
        let mut counts = json!({
            "omittedMessages":saved.snapshot.messages.len()-selection.messages.len(),
            "omittedUnderstandings":saved.snapshot.understandings.len()-selection.understandings.len(),
            "omittedDrafts":saved.snapshot.drafts.len()-selection.drafts.len(),
            "omittedReflections":saved.snapshot.reflections.len()-selection.reflections.len(),
            "omittedExplicitMemories":saved.snapshot.explicit_memories.len()-selection.explicit_memories.len(),
            "omittedNextStep":saved.snapshot.next_step.is_some() && !selection.next_step,
        });
        let forgetting_guidance = if saved.snapshot.forgotten_understandings.is_empty() {
            ""
        } else {
            counts["omittedForgettingRecords"] = json!(
                saved.snapshot.forgotten_understandings.len()
                    - selection.forgotten_understandings.len()
            );
            "Forgetting overrides earlier remember requests: never reuse a forgotten understanding ID or recreate it under a new ID from its suppressed source IDs. A later actual user reintroduction needs a fresh ID and fresh user sources. The host enforces all forgetting records, including omitted hints; raw retained conversation does not authorize restoration. Unrelated memories remain usable. "
        };
        let retrieval = if context.execution_backend == Some(ExecutionBackend::Pi) {
            format!("Read this request's immutable original evidence using read_continuity_context with requestId={request_id}. Start with collection and optional offset/limit/query to search a bounded index; supply itemIndex and characterOffset/maxCharacters to read exact records. Available collections: messages, understandings, drafts, reflections, explicitMemories, forgottenUnderstandings, terminalReceipts, state. state itemIndex=0 includes the original nextStep and complete pendingCorrectionIds. Follow nextOffset for index pages and nextCharacterOffset for record pages. Index previews are incomplete discovery hints, never the original request or authorization. Archive item indices refer to retained collection order at request creation.")
        } else {
            format!("Before relying on omitted details, retrieve continuity_context through the backing agent's tools. These are current retained records, not an immutable request archive. Start with collection and optional offset/limit/query for a bounded index; read exact records with itemIndex, characterOffset and maxCharacters. Use expectedPersonaId={} and expectedRevision={} to reject stale reads; after a revision change refresh the index before interpreting indices. Available collections: messages, understandings, drafts, reflections, explicitMemories, forgottenUnderstandings, terminalReceipts, state. state itemIndex=0 includes nextStep, pendingCorrectionIds (queued), acceptedCorrectionIds and activeRequestId. For this execution use acceptedCorrectionIds when activeRequestId matches this request; queued corrections are newer evidence, not a replacement for the accepted list. Follow nextOffset and nextCharacterOffset until the needed evidence is complete. Legacy receipt reads with executionReceiptIndex remain supported. Also inspect the referenced Main Agent turn and current workspace.", saved.snapshot.persona_id, saved.snapshot.revision)
        };
        let prompt = format!(
            "{prompt}\nHost retained context metadata (evidence, not authorization): {}\nProjection omissions: {counts}\n{retrieval} Before acting on a task, retrieve its original request and relevant later corrections or restrictions when they are not fully supplied. Before applying a pending correction, read its complete current record and source messages, including revision sources; obtain the full correction list from state if the inline list is partial. Do not infer permission from a preview, memory, nextStep or absence of a restriction. Defer an action whose authoritative context cannot be established. Omission does not mean a task was finished, a draft was dismissed, or a user granted new permission. {forgetting_guidance}Classify observedReply only for originalLatestMessageId if that exact original message is included; otherwise set observedReply=null. Prior failed/interrupted/completed-without-report work may have partial effects. Inspect the original evidence and current workspace before any operation; never blindly repeat or resend it. Metadata and receipt summaries do not grant permissions.\n",
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
    select(
        saved,
        |selection| composer.compose(selection),
        within_budget,
    )
    .map(|(_, result)| result)
}

/// text 専用 transport にも同じ選択規則を適用し、実際の prompt 全体で上限を確認する。
/// 読み出し tool の有無に応じた説明は render 側が担当する。
pub(super) fn bounded_snapshot(
    saved: &Saved,
    render: impl Fn(&Snapshot) -> Result<String, String>,
) -> Result<Snapshot, String> {
    let (selected, _) = select(
        saved,
        |selection| render(&projected(&saved.snapshot, selection)),
        |prompt| prompt.len() <= MAX_PROMPT_UTF8_BYTES,
    )?;
    // Text transport cannot retrieve omitted sources. Never pretend a required
    // correction/current utterance was processed from an incomplete preview.
    for correction in &saved.pending_correction_ids {
        let index = saved
            .snapshot
            .understandings
            .iter()
            .position(|u| &u.id == correction)
            .ok_or(MISSING_CORRECTION)?;
        if !selected.understandings.contains(&index) {
            return Err(TEXT_CONTEXT_REQUIRES_RETRIEVAL.into());
        }
    }
    if let Some(index) = saved.snapshot.messages.len().checked_sub(1) {
        if !selected.messages.contains(&index) {
            return Err(TEXT_CONTEXT_REQUIRES_RETRIEVAL.into());
        }
    }
    Ok(projected(&saved.snapshot, &selected))
}

fn select<T>(
    saved: &Saved,
    compose: impl Fn(&Selection) -> Result<T, String>,
    fits: impl Fn(&T) -> bool,
) -> Result<(Selection, T), String> {
    let snapshot = &saved.snapshot;
    let recent_messages = snapshot
        .messages
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, message)| message.source != "legacy")
        .take(MAX_OPTIONAL_MESSAGES)
        .map(|(index, _)| index)
        .collect::<BTreeSet<_>>();
    // Validate provenance independently of what fits inline. Original records
    // remain in native storage and are discoverable through a paged index.
    for correction in &saved.pending_correction_ids {
        let Some(index) = snapshot
            .understandings
            .iter()
            .position(|u| &u.id == correction)
        else {
            return Err(MISSING_CORRECTION.into());
        };
        if !include_understanding(snapshot, &mut Selection::default(), index) {
            return Err(MISSING_CORRECTION.into());
        }
    }
    for memory in snapshot
        .explicit_memories
        .iter()
        .filter(|m| explicit_memory_is_active(snapshot, m))
    {
        let mut check = Selection::default();
        if !source_messages(
            snapshot,
            &mut check,
            std::slice::from_ref(&memory.request_message_id),
        ) || !source_messages(snapshot, &mut check, &memory.source_ids)
        {
            return Err(MISSING_EXPLICIT_MEMORY.into());
        }
    }
    let mut selected = Selection::default();
    let mut result = compose(&selected)?;
    if !fits(&result) {
        return Err(FIXED_CONTEXT_TOO_LARGE.into());
    }
    let attempt = |candidate: Selection, selected: &mut Selection, result: &mut T| {
        // A fixed evidence allowance prevents sparse history from filling the
        // whole model context. Never cut a record or a source dependency in half.
        if serde_json::to_vec(&projected(snapshot, &candidate))
            .map_err(|_| ENCODING_ERROR.to_owned())?
            .len()
            > MAX_INLINE_EVIDENCE_BYTES
        {
            return Ok::<(), String>(());
        }
        let value = compose(&candidate)?;
        if fits(&value) {
            *selected = candidate;
            *result = value;
        }
        Ok(())
    };
    // Newest conversation and current task first; older evidence stays indexed.
    for index in recent_messages.iter().rev() {
        let mut candidate = selected.clone();
        candidate.messages.insert(*index);
        attempt(candidate, &mut selected, &mut result)?;
    }
    if snapshot.next_step.is_some() {
        let mut candidate = selected.clone();
        candidate.next_step = true;
        attempt(candidate, &mut selected, &mut result)?;
    }
    for correction in &saved.pending_correction_ids {
        let index = snapshot
            .understandings
            .iter()
            .position(|u| &u.id == correction)
            .unwrap();
        let mut candidate = selected.clone();
        include_understanding(snapshot, &mut candidate, index);
        attempt(candidate, &mut selected, &mut result)?;
    }
    for (index, memory) in snapshot
        .explicit_memories
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, m)| explicit_memory_is_active(snapshot, m))
        .take(MAX_INLINE_EXPLICIT_MEMORIES)
    {
        let mut candidate = selected.clone();
        source_messages(
            snapshot,
            &mut candidate,
            std::slice::from_ref(&memory.request_message_id),
        );
        source_messages(snapshot, &mut candidate, &memory.source_ids);
        candidate.explicit_memories.insert(index);
        attempt(candidate, &mut selected, &mut result)?;
    }
    // A bounded handful of older user turns and the last pending question are
    // useful hints, not an ever-growing mandatory transcript.
    for (index, _) in snapshot
        .messages
        .iter()
        .enumerate()
        .rev()
        .filter(|(_, m)| {
            m.role == "user" && m.source != "legacy" && !saved.retired_message_ids.contains(&m.id)
        })
        .take(MAX_INLINE_USER_MESSAGES)
    {
        let mut candidate = selected.clone();
        candidate.messages.insert(index);
        attempt(candidate, &mut selected, &mut result)?;
    }
    if let Some((index, _)) = snapshot
        .messages
        .iter()
        .enumerate()
        .rev()
        .find(|(_, m)| m.role == "assistant" && m.reply_kind == Some(ReplyKind::AwaitingReply))
    {
        let mut candidate = selected.clone();
        candidate.messages.insert(index);
        attempt(candidate, &mut selected, &mut result)?;
    }
    // 全削除履歴は host の更新検証が参照する。prompt には今の原文に関連する
    // 手掛かりと直近のものだけを載せ、削除件数で必須の依頼を圧迫しない。
    let required_sources = selected
        .messages
        .iter()
        .map(|index| snapshot.messages[*index].id.as_str())
        .collect::<BTreeSet<_>>();
    let mut forgotten = (0..snapshot.forgotten_understandings.len()).collect::<Vec<_>>();
    forgotten.sort_by_key(|index| {
        let entry = &snapshot.forgotten_understandings[*index];
        (
            !entry
                .source_ids
                .iter()
                .any(|source| required_sources.contains(source.as_str())),
            Reverse(entry.forgotten_at),
            Reverse(*index),
        )
    });
    for index in forgotten.into_iter().take(MAX_FORGETTING_HINTS) {
        let mut candidate = selected.clone();
        candidate.forgotten_understandings.insert(index);
        attempt(candidate, &mut selected, &mut result)?;
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
    for index in drafts.into_iter().take(MAX_OPTIONAL_DRAFTS) {
        let mut candidate = selected.clone();
        if source_messages(snapshot, &mut candidate, &snapshot.drafts[index].source_ids) {
            candidate.drafts.insert(index);
            attempt(candidate, &mut selected, &mut result)?;
        }
    }
    let mut understandings = (0..snapshot.understandings.len()).collect::<Vec<_>>();
    understandings.sort_by_key(|index| {
        (
            Reverse(snapshot.understandings[*index].updated_at),
            Reverse(*index),
        )
    });
    for index in understandings.into_iter().take(MAX_OPTIONAL_UNDERSTANDINGS) {
        let mut candidate = selected.clone();
        if include_understanding(snapshot, &mut candidate, index) {
            attempt(candidate, &mut selected, &mut result)?;
        }
    }
    for index in (0..snapshot.reflections.len())
        .rev()
        .take(MAX_OPTIONAL_REFLECTIONS)
    {
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
            attempt(candidate, &mut selected, &mut result)?;
        }
    }
    for index in recent_messages.into_iter().rev() {
        let mut candidate = selected.clone();
        candidate.messages.insert(index);
        attempt(candidate, &mut selected, &mut result)?;
    }
    Ok((selected, result))
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

    fn compact(saved: &Saved) -> Snapshot {
        bounded_snapshot(saved, |snapshot| {
            serde_json::to_string(snapshot).map_err(|error| error.to_string())
        })
        .unwrap()
    }

    #[test]
    fn forgetting_suppresses_old_memory_requests_without_hiding_raw_user_authority() {
        let mut saved = saved();
        saved.snapshot.messages = vec![
            message(
                "authority",
                "user",
                "Never publish without approval.".into(),
            ),
            message(
                "old-reply",
                "assistant",
                "Old remembered explanation".into(),
            ),
            message("remember", "user", "Remember this.".into()),
        ];
        saved.snapshot.explicit_memories = serde_json::from_value(json!([{
            "requestMessageId":"remember","sourceIds":["authority","old-reply","remember"]
        }]))
        .unwrap();
        saved.snapshot.forgotten_understandings = serde_json::from_value(json!([{
            "understandingId":"forgotten","sourceIds":["authority"],"forgottenAt":1
        }]))
        .unwrap();
        saved.retired_message_ids.insert("remember".into());
        for index in 0..8 {
            saved.snapshot.messages.push(message(
                &format!("report-{index}"),
                "assistant",
                "Recent report".into(),
            ));
        }
        let before = serde_json::to_vec(&saved).unwrap();
        let view = compact(&saved);
        assert!(view.explicit_memories.is_empty());
        assert!(view
            .messages
            .iter()
            .any(|message| message.id == "authority"));
        assert!(!view
            .messages
            .iter()
            .any(|message| message.id == "old-reply"));
        assert_eq!(
            view.forgotten_understandings[0].understanding_id,
            "forgotten"
        );
        let prompt = run(&saved).unwrap().prompt;
        assert!(prompt.contains("Forgetting overrides earlier remember requests"));
        assert!(prompt.contains("fresh ID and fresh user sources"));
        assert_eq!(before, serde_json::to_vec(&saved).unwrap());
    }

    #[test]
    fn many_forgetting_records_are_bounded_hints_not_mandatory_context_overflow() {
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "current",
            "user",
            "Continue the current local draft.".into(),
        ));
        saved.snapshot.forgotten_understandings = serde_json::from_value(json!(
            (0..2000).map(|index| json!({
                "understandingId":format!("forgotten-{index}"),
                "sourceIds":[if index == 0 { "current".into() } else { format!("source-{}-{index}", "x".repeat(256)) }],
                "forgottenAt":index,
            })).collect::<Vec<_>>()
        )).unwrap();
        let view = compact(&saved);
        assert_eq!(view.messages[0].id, "current");
        assert_eq!(view.forgotten_understandings.len(), MAX_FORGETTING_HINTS);
        assert!(view
            .forgotten_understandings
            .iter()
            .any(|entry| entry.understanding_id == "forgotten-0"));
        let projection = run(&saved).unwrap();
        assert!(projection.prompt.len() < 20 * 1024);
        assert!(projection
            .prompt
            .contains("\"omittedForgettingRecords\":1992"));
        assert!(projection.prompt.contains("including omitted hints"));
        assert!(within_budget(&projection));
    }

    #[test]
    fn normal_context_does_not_fill_spare_budget_with_old_optional_records() {
        let mut saved = saved();
        for index in 0..20 {
            let id = format!("message-{index}");
            saved.retired_message_ids.insert(id.clone());
            saved
                .snapshot
                .messages
                .push(message(&id, "user", format!("Reviewed chatter {index}")));
        }
        saved.snapshot.understandings = serde_json::from_value(json!((0..12)
            .map(|index| json!({
                "id":format!("memory-{index}"),"title":"Preference","value":"Short value",
                "certainty":"confirmed","sourceIds":["message-19"],"updatedAt":index,"revisions":[]
            }))
            .collect::<Vec<_>>()))
        .unwrap();
        saved.snapshot.drafts = serde_json::from_value(json!(
            (0..6).map(|index| json!({
                "id":format!("draft-{index}"),"title":"Draft","content":"Short body","reason":"Request",
                "status":"ready","sourceIds":["message-19"],"createdAt":index,"updatedAt":index
            })).collect::<Vec<_>>()
        )).unwrap();
        saved.snapshot.reflections = serde_json::from_value(json!((0..6)
            .map(|index| json!({
                "id":format!("reflection-{index}"),"content":"Brief observation",
                "sourceIds":["message-19"],"understandingIds":["memory-11"],"createdAt":index
            }))
            .collect::<Vec<_>>()))
        .unwrap();
        let before = serde_json::to_vec(&saved).unwrap();
        let view = compact(&saved);
        assert_eq!(
            view.messages
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            (14..20)
                .map(|index| format!("message-{index}"))
                .collect::<Vec<_>>()
        );
        assert_eq!(view.understandings.len(), 8);
        assert_eq!(view.understandings[0].id, "memory-4");
        assert_eq!(view.drafts.len(), 3);
        assert_eq!(view.drafts[0].id, "draft-3");
        assert_eq!(view.reflections.len(), 3);
        assert_eq!(view.reflections[0].id, "reflection-3");
        let projection = run(&saved).unwrap();
        assert!(projection.prompt.len() < MAX_PROMPT_UTF8_BYTES / 4);
        assert_eq!(projection.budget.omitted_message_count, 14);
        assert_eq!(before, serde_json::to_vec(&saved).unwrap());
    }

    #[test]
    fn retirement_cannot_hide_unreviewed_or_referenced_user_authority() {
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "unreviewed",
            "user",
            "Never publish without asking.".into(),
        ));
        saved.snapshot.messages.push(message(
            "referenced",
            "user",
            "Keep the client's address private.".into(),
        ));
        saved.snapshot.messages.push(message(
            "retired",
            "user",
            "Thanks for the completed example.".into(),
        ));
        saved
            .retired_message_ids
            .extend(["referenced".into(), "retired".into()]);
        saved.snapshot.understandings.push(Understanding {
            id: "boundary".into(),
            title: "Privacy".into(),
            value: "Keep address private".into(),
            certainty: Certainty::Confirmed,
            source_ids: vec!["referenced".into()],
            updated_at: 0,
            revisions: vec![],
        });
        for index in 0..8 {
            saved.snapshot.messages.push(message(
                &format!("report-{index}"),
                "assistant",
                "Recent report.".into(),
            ));
        }
        let view = compact(&saved);
        let ids = view
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect::<Vec<_>>();
        assert!(ids.contains(&"unreviewed"));
        assert!(ids.contains(&"referenced"));
        assert!(!ids.contains(&"retired"));
        assert!(!ids.contains(&"report-0"));
        assert_eq!(ids.len(), 8);
    }

    #[test]
    fn explicit_memory_keeps_exact_original_request_and_context_even_outside_recent_window() {
        use crate::continuity::types::ExplicitMemory;
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "context",
            "assistant",
            "The exact explanation to remember.".into(),
        ));
        saved
            .snapshot
            .messages
            .push(message("remember", "user", "Please remember this.".into()));
        saved.snapshot.explicit_memories.push(ExplicitMemory {
            request_message_id: "remember".into(),
            source_ids: vec!["context".into(), "remember".into()],
        });
        saved
            .retired_message_ids
            .extend(["context".into(), "remember".into()]);
        for index in 0..8 {
            saved.snapshot.messages.push(message(
                &format!("report-{index}"),
                "assistant",
                "Recent report.".into(),
            ));
        }
        let view = compact(&saved);
        assert_eq!(view.explicit_memories, saved.snapshot.explicit_memories);
        assert_eq!(view.messages[0].id, "context");
        assert_eq!(
            view.messages[0].content,
            "The exact explanation to remember."
        );
        assert_eq!(view.messages[1].id, "remember");
        saved.snapshot.messages[0].content = "x".repeat(MAX_PROMPT_UTF8_BYTES);
        let projection = run(&saved).unwrap();
        assert!(within_budget(&projection));
        assert!(projection.prompt.contains("explicitMemories"));
        saved.snapshot.messages.remove(0);
        assert_eq!(run(&saved).unwrap_err(), MISSING_EXPLICIT_MEMORY);
    }

    #[test]
    fn text_snapshot_budget_counts_renderer_overhead_without_truncating_mandatory_context() {
        let mut saved = saved();
        saved
            .snapshot
            .messages
            .push(message("current", "user", "Current request".into()));
        let result = bounded_snapshot(&saved, |_| Ok("x".repeat(MAX_PROMPT_UTF8_BYTES + 1)));
        assert_eq!(result.unwrap_err(), FIXED_CONTEXT_TOO_LARGE);
    }

    #[test]
    fn codex_uses_current_context_retrieval_without_promising_a_pi_archive() {
        let mut context = context();
        context.execution_backend = Some(ExecutionBackend::Codex);
        let projection = build(&saved(), &context, "return", REQUEST, &json!({}), render).unwrap();
        assert!(projection.prompt.contains("retrieve continuity_context"));
        assert!(projection.prompt.contains("current retained records"));
        assert!(projection
            .prompt
            .contains("not an immutable request archive"));
        assert!(!projection.prompt.contains("read_continuity_context"));
        assert!(projection.prompt.contains("executionReceiptIndex"));
        assert!(projection.prompt.contains("nextCharacterOffset"));
        assert!(!projection.prompt.contains("every original record"));
        assert!(within_budget(&projection));
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
    fn oversized_original_is_indexed_and_retrievable_without_truncating_native_history() {
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "authority",
            "user",
            "同意なしに公開しない。".repeat(12000),
        ));
        let before = serde_json::to_vec(&saved).unwrap();
        let projection = run(&saved).unwrap();
        assert!(within_budget(&projection));
        assert!(projection.prompt.contains("previewOnly"));
        assert!(projection.prompt.contains("retrieve its original request"));
        assert!(!projection
            .prompt
            .contains(&saved.snapshot.messages[0].content));
        assert_eq!(before, serde_json::to_vec(&saved).unwrap());
    }

    #[test]
    fn growing_user_history_uses_a_fixed_inline_allowance_and_does_not_mutate_evidence() {
        let mut saved = saved();
        for index in 0..1000 {
            saved.snapshot.messages.push(message(
                &format!("user-{index}"),
                "user",
                format!("Original task {index}. {}", "条件".repeat(120)),
            ));
        }
        let before = serde_json::to_vec(&saved).unwrap();
        let projection = run(&saved).unwrap();
        assert!(projection.prompt.len() < 40 * 1024);
        assert!(projection.budget.omitted_message_count > 980);
        assert!(projection.prompt.contains("user-999"));
        assert!(projection.prompt.contains("totalCount\":1000"));
        assert!(projection.prompt.contains("offset/limit/query"));
        assert_eq!(serde_json::to_vec(&saved).unwrap(), before);
    }

    #[test]
    fn large_correction_sources_are_retrievable_and_text_transport_defers_explicitly() {
        let mut saved = saved();
        saved.snapshot.messages.push(message(
            "original",
            "user",
            format!("{} NEVER_SEND_WITHOUT_APPROVAL", "文脈".repeat(40000)),
        ));
        saved.snapshot.messages.push(message(
            "current",
            "user",
            "Correct that understanding.".into(),
        ));
        saved.snapshot.understandings.push(Understanding {
            id: "correct-me".into(),
            title: "Boundary".into(),
            value: "Do not send".into(),
            certainty: Certainty::Confirmed,
            source_ids: vec!["current".into()],
            updated_at: 1,
            revisions: vec![Revision {
                value: "Earlier".into(),
                reason: "Original".into(),
                source_ids: vec!["original".into()],
                created_at: 0,
            }],
        });
        saved.pending_correction_ids.push("correct-me".into());
        let before = serde_json::to_vec(&saved).unwrap();
        let projection = run(&saved).unwrap();
        assert!(within_budget(&projection));
        assert!(projection.prompt.contains("correct-me"));
        assert!(projection
            .prompt
            .contains("read its complete current record and source messages"));
        assert!(projection.prompt.contains("pendingCorrectionCount\":1"));
        assert_eq!(
            bounded_snapshot(&saved, |s| Ok(serde_json::to_string(s).unwrap())).unwrap_err(),
            TEXT_CONTEXT_REQUIRES_RETRIEVAL
        );
        assert_eq!(serde_json::to_vec(&saved).unwrap(), before);
    }

    #[test]
    fn huge_next_step_and_latest_request_do_not_overflow_tool_projection() {
        let mut saved = saved();
        saved
            .snapshot
            .messages
            .push(message("huge", "user", "🦊".repeat(100000)));
        saved.snapshot.next_step = Some("Follow up ".repeat(50000));
        let before = serde_json::to_vec(&saved).unwrap();
        let projection = run(&saved).unwrap();
        assert!(projection.prompt.len() < 20 * 1024);
        assert!(projection.prompt.contains("omittedNextStep\":true"));
        assert!(projection.prompt.contains("state itemIndex=0"));
        assert_eq!(
            bounded_snapshot(&saved, |s| Ok(serde_json::to_string(s).unwrap())).unwrap_err(),
            TEXT_CONTEXT_REQUIRES_RETRIEVAL
        );
        assert_eq!(serde_json::to_vec(&saved).unwrap(), before);
    }

    /// Local diagnosis only: never commits private conversation as a fixture.
    #[test]
    #[ignore]
    fn replay_native_state_without_copying_private_evidence() {
        let path = std::env::var("YORISHIRO_CONTEXT_REPLAY").expect("set native state path");
        let bytes = std::fs::read(&path).unwrap();
        let decoded =
            super::super::storage::decode_saved(serde_json::from_slice(&bytes).unwrap()).unwrap();
        let saved: Saved = serde_json::from_value(decoded).unwrap();
        let context = saved.auto_context.as_ref().unwrap();
        let projection = build(
            &saved,
            context,
            "return",
            REQUEST,
            &super::super::execution_schema(),
            super::super::execution_prompt,
        )
        .unwrap();
        assert!(within_budget(&projection));
        assert!(projection.prompt.len() < 64 * 1024);
        assert_eq!(std::fs::read(path).unwrap(), bytes);
        eprintln!(
            "Replay budget: prompt={} omittedMessages={}",
            projection.budget.prompt_utf8_bytes, projection.budget.omitted_message_count
        );
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
            format!("{}CURRENT_ACTIVE_WORK", "a".repeat(12000)),
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
