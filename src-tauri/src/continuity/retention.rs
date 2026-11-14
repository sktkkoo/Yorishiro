//! レビュー済みの不要な会話だけを削減する。期限・件数だけでは依頼の完了を推測しない。
use super::types::Saved;
use std::collections::BTreeSet;

pub(super) const MAX_RECENT_MESSAGES: usize = 200;
pub(super) const MAX_MESSAGE_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct RetentionSummary {
    pub removed_messages: usize,
}

/// 保存前の候補にだけ適用し、保存が成功するまで呼び出し元の確定状態は置き換えない。
/// 保護された根拠や未レビューの会話は上限の例外となり、全容量の上限は保証しない。
pub(super) fn compact(saved: &mut Saved, at: u64, running: bool, queued: bool) -> RetentionSummary {
    // 受理済み処理は message_count を配列の境界として保持している。text backend も
    // snapshot を処理中なので、pending_execution だけでなく running / queued を見る。
    if running
        || queued
        || saved.pending_execution.is_some()
        || !saved.pending_correction_ids.is_empty()
        || saved.pending_trigger.is_some()
        || saved.snapshot.next_step.is_some()
        || saved.snapshot.phase != "idle"
        || saved.snapshot.error.is_some()
        || saved.execution_blocked
        || saved.resume_after_recovery
        || saved.stagnation_pause.is_some()
    {
        return RetentionSummary::default();
    }

    let snapshot = &mut saved.snapshot;
    let mut protected = BTreeSet::new();
    for memory in &snapshot.explicit_memories {
        protected.insert(memory.request_message_id.as_str());
        protected.extend(memory.source_ids.iter().map(String::as_str));
    }
    for understanding in &snapshot.understandings {
        protected.extend(understanding.source_ids.iter().map(String::as_str));
        for revision in &understanding.revisions {
            protected.extend(revision.source_ids.iter().map(String::as_str));
        }
    }
    // dismissed draft も再提案を防ぐ記録として残るため、その元発言を切り離さない。
    for draft in &snapshot.drafts {
        protected.extend(draft.source_ids.iter().map(String::as_str));
    }
    for reflection in &snapshot.reflections {
        protected.extend(reflection.source_ids.iter().map(String::as_str));
    }

    let recent_start = snapshot.messages.len().saturating_sub(MAX_RECENT_MESSAGES);
    let conversation_tail = snapshot
        .messages
        .iter()
        .rposition(|message| message.role == "user" && message.source != "legacy")
        .unwrap_or(0);
    let mut removed = BTreeSet::new();
    let mut removed_messages = 0;
    let mut index = 0;
    snapshot.messages.retain(|message| {
        let outside_window =
            index < recent_start || at.saturating_sub(message.created_at) > MAX_MESSAGE_AGE_MS;
        // 最新の相手の発言とそれ以降の返信を残し、未回答の提案や分類待ちを失わない。
        let in_conversation_tail = index >= conversation_tail
            && message.source != "legacy"
            && matches!(message.role.as_str(), "user" | "assistant");
        index += 1;
        let remove = outside_window
            && saved.retired_message_ids.contains(&message.id)
            && !protected.contains(message.id.as_str())
            && !in_conversation_tail;
        if remove {
            removed.insert(message.id.clone());
            removed_messages += 1;
        }
        !remove
    });
    saved.retired_message_ids.retain(|id| !removed.contains(id));
    RetentionSummary { removed_messages }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const NOW: u64 = 2 * MAX_MESSAGE_AGE_MS;

    fn message(id: &str, role: &str, created_at: u64) -> Value {
        json!({
            "id":id,"role":role,"content":format!("Original {id}"),
            "createdAt":created_at,"source":"conversation"
        })
    }

    fn saved(messages: Vec<Value>, retired: &[&str]) -> Saved {
        serde_json::from_value(json!({
            "version":1,"snapshot":{
                "personaId":"yori-ja","revision":7,"autoEnabled":false,"phase":"idle",
                "messages":messages,"understandings":[],"drafts":[],"reflections":[],
                "error":null,"lastObservedAt":NOW,"nextStep":null
            },"retiredMessageIds":retired
        }))
        .unwrap()
    }

    fn ids(saved: &Saved) -> Vec<&str> {
        saved
            .snapshot
            .messages
            .iter()
            .map(|m| m.id.as_str())
            .collect()
    }

    #[test]
    fn age_expiry_requires_review_and_preserves_exact_boundary_and_future_dates() {
        let mut value = saved(
            vec![
                message("old-reviewed", "assistant", NOW - MAX_MESSAGE_AGE_MS - 1),
                message("old-unreviewed-request", "user", 1),
                message("boundary", "assistant", NOW - MAX_MESSAGE_AGE_MS),
                message("future", "assistant", NOW + 1),
                message("latest-user", "user", NOW),
            ],
            &["old-reviewed", "boundary", "future"],
        );
        let remaining_before = value.snapshot.messages[1..].to_vec();
        assert_eq!(compact(&mut value, NOW, false, false).removed_messages, 1);
        assert_eq!(
            serde_json::to_value(&value.snapshot.messages).unwrap(),
            serde_json::to_value(remaining_before).unwrap()
        );
        assert!(!value.retired_message_ids.contains("old-reviewed"));
        assert!(value.retired_message_ids.contains("boundary"));
        assert_eq!(
            compact(&mut value, NOW, false, false),
            RetentionSummary::default()
        );
    }

    #[test]
    fn count_expiry_uses_original_order_and_only_removes_explicitly_reviewed_messages() {
        let mut messages = (0..203)
            .map(|index| message(&format!("m{index}"), "assistant", NOW))
            .collect::<Vec<_>>();
        messages.push(message("latest-user", "user", NOW));
        let mut value = saved(messages, &["m0", "m2", "m3", "m4"]);
        assert_eq!(compact(&mut value, NOW, false, false).removed_messages, 3);
        assert_eq!(&ids(&value)[..3], &["m1", "m4", "m5"]);
        assert_eq!(value.snapshot.messages.len(), 201);
        // 未レビューの例外で 200 件を超えても、勝手に依頼を削除しない。
        assert_eq!(value.retired_message_ids, BTreeSet::from(["m4".into()]));
    }

    #[test]
    fn current_revision_draft_and_reflection_sources_override_retirement() {
        let source_ids = ["current", "revision", "draft", "dismissed", "reflection"];
        let mut messages = source_ids
            .iter()
            .map(|id| message(id, "user", 1))
            .collect::<Vec<_>>();
        messages.push(message("discardable", "assistant", 1));
        messages.push(message("latest-user", "user", NOW));
        let mut value = saved(messages, &source_ids);
        value.retired_message_ids.insert("discardable".into());
        value.snapshot.understandings = serde_json::from_value(json!([{
            "id":"memory","title":"Boundary","value":"Current value","certainty":"confirmed",
            "sourceIds":["current"],"updatedAt":NOW,"revisions":[{
                "value":"Old value","reason":"Correction","sourceIds":["revision"],"createdAt":1
            }]
        }]))
        .unwrap();
        value.snapshot.drafts = serde_json::from_value(json!([
            {"id":"d1","title":"Work","content":"Draft","reason":"Request","status":"ready",
             "sourceIds":["draft"],"createdAt":1,"updatedAt":1},
            {"id":"d2","title":"Declined","content":"Old draft","reason":"Request","status":"dismissed",
             "sourceIds":["dismissed"],"createdAt":1,"updatedAt":1}
        ])).unwrap();
        value.snapshot.reflections = serde_json::from_value(json!([{
            "id":"r1","content":"Evidence","sourceIds":["reflection"],
            "understandingIds":["memory"],"createdAt":1
        }]))
        .unwrap();
        assert_eq!(compact(&mut value, NOW, false, false).removed_messages, 1);
        assert_eq!(
            ids(&value),
            [
                "current",
                "revision",
                "draft",
                "dismissed",
                "reflection",
                "latest-user"
            ]
        );
    }

    #[test]
    fn latest_user_and_following_replies_cannot_be_retired_even_when_old() {
        let mut proposal = message("proposal", "assistant", 1);
        proposal["replyKind"] = json!("awaitingReply");
        let mut report = message("report", "assistant", 1);
        report["replyKind"] = json!("report");
        let mut value = saved(
            vec![
                message("older", "assistant", 1),
                message("latest-user", "user", 1),
                proposal,
                report,
            ],
            &["older", "latest-user", "proposal", "report"],
        );
        assert_eq!(compact(&mut value, NOW, false, false).removed_messages, 1);
        assert_eq!(ids(&value), ["latest-user", "proposal", "report"]);
        let mut without_user = saved(
            vec![message("unclassified", "assistant", 1)],
            &["unclassified"],
        );
        assert_eq!(
            compact(&mut without_user, NOW, false, false),
            RetentionSummary::default()
        );
    }

    #[test]
    fn unsettled_work_defers_compaction_without_any_partial_changes() {
        for condition in [
            "running",
            "queued",
            "execution",
            "correction",
            "trigger",
            "next-step",
            "phase",
            "error",
            "blocked",
            "recovery",
            "stagnation",
        ] {
            let mut value = saved(
                vec![
                    message("old", "assistant", 1),
                    message("latest-user", "user", NOW),
                ],
                &["old"],
            );
            match condition {
                "execution" => {
                    value.pending_execution = Some(serde_json::from_value(json!({
                        "requestId":"pending","target":{"backend":"codex","target":{"sessionId":"main","threadId":"thread","cwd":"/workspace","launchId":"launch"}},
                        "context":{"personaId":"yori-ja","personaName":"Yori","personaPrompt":"","language":"ja","cwd":null},
                        "prompt":"Original accepted prompt","trigger":"message","correctionIds":[],"messageCount":2
                    })).unwrap());
                }
                "correction" => value.pending_correction_ids.push("memory".into()),
                "trigger" => value.pending_trigger = Some("message".into()),
                "next-step" => value.snapshot.next_step = Some("Continue entrusted work".into()),
                "phase" => value.snapshot.phase = "working".into(),
                "error" => value.snapshot.error = Some("Needs recovery".into()),
                "blocked" => value.execution_blocked = true,
                "recovery" => value.resume_after_recovery = true,
                "stagnation" => value.stagnation_pause = Some("Review work".into()),
                _ => (),
            }
            let before = serde_json::to_value(&value).unwrap();
            assert_eq!(
                compact(
                    &mut value,
                    NOW,
                    condition == "running",
                    condition == "queued"
                ),
                RetentionSummary::default(),
                "{condition}"
            );
            assert_eq!(serde_json::to_value(&value).unwrap(), before, "{condition}");
        }
    }
}
