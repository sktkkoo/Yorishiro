//! メモリーを忘れる操作と、古い判断結果からの復活を防ぐ処理。
use super::types::{ForgottenUnderstanding, ModelResult, Saved, Snapshot};
use std::collections::BTreeSet;

pub(super) fn is_forgotten(snapshot: &Snapshot, id: &str) -> bool {
    snapshot
        .forgotten_understandings
        .iter()
        .any(|item| item.understanding_id == id)
}

pub(super) fn remove(saved: &mut Saved, id: &str, at: u64) -> Result<bool, String> {
    let snapshot = &mut saved.snapshot;
    let Some(index) = snapshot
        .understandings
        .iter()
        .position(|item| item.id == id)
    else {
        return if is_forgotten(snapshot, id) {
            Ok(false)
        } else {
            Err("This memory no longer exists.".into())
        };
    };
    let understanding = snapshot.understandings.remove(index);
    let source_ids = understanding
        .source_ids
        .into_iter()
        .chain(
            understanding
                .revisions
                .into_iter()
                .flat_map(|revision| revision.source_ids),
        )
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    snapshot
        .forgotten_understandings
        .push(ForgottenUnderstanding {
            understanding_id: understanding.id,
            source_ids,
            forgotten_at: at,
        });
    // 複数の記憶が混ざった自由文は一部分だけ安全に取り除けない。元発言や他の記憶は残す。
    snapshot.reflections.retain(|reflection| {
        !reflection
            .understanding_ids
            .iter()
            .any(|source| source == id)
    });
    saved.pending_correction_ids.retain(|target| target != id);
    Ok(true)
}

/// 現在の確定状態を優先し、処理開始後に忘れた記憶も結果の検証より前に除外する。
/// 同じ元発言を参照する別の既存メモリーは削除せず、その更新も妨げない。
pub(super) fn filter_result(snapshot: &Snapshot, result: &mut ModelResult) {
    let forgotten_ids = snapshot
        .forgotten_understandings
        .iter()
        .map(|item| item.understanding_id.as_str())
        .collect::<BTreeSet<_>>();
    let sources = snapshot
        .forgotten_understandings
        .iter()
        .flat_map(|item| item.source_ids.iter().map(String::as_str))
        .collect::<BTreeSet<_>>();
    let existing = snapshot
        .understandings
        .iter()
        .map(|item| item.id.as_str())
        .collect::<BTreeSet<_>>();
    let before = result.understandings.len();
    result.understandings.retain(|update| {
        !forgotten_ids.contains(update.id.as_str())
            && (existing.contains(update.id.as_str())
                || !update
                    .source_ids
                    .iter()
                    .any(|id| sources.contains(id.as_str())))
    });
    if result.understandings.len() != before {
        // 除外した記憶の内容が別の理解に紐づく reflection に混入することも防ぐ。
        result.reflection.clear();
    }
}
