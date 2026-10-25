//! One-shot, user-reviewed external actions. Local work can prepare a request;
//! only the main-window approval command can consume its frozen payload.
use super::{publishing, AutonomyState, CleanupOwner, Status};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::PathBuf;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ActionStatus {
    Pending,
    Submitting,
    Published,
    Declined,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum ActionKind {
    PublishPullRequest,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Action {
    pub id: String,
    pub run_id: String,
    kind: ActionKind,
    pub status: ActionStatus,
    #[serde(default)]
    pub acknowledged: bool,
    created_at: u64,
    summary: String,
    error: Option<String>,
    pull_request_url: Option<String>,
    #[serde(flatten)]
    pub review: publishing::PublicationReview,
}

pub(super) struct Completion {
    id: String,
    result: Result<String, publishing::PublicationError>,
}

pub(super) fn has_pending(status: &Status) -> bool {
    status.pending_actions.iter().any(|action| {
        matches!(
            action.status,
            ActionStatus::Pending | ActionStatus::Submitting | ActionStatus::Failed
        ) || (action.status == ActionStatus::Unknown && !action.acknowledged)
    })
}

pub(super) fn park(status: &mut Status) {
    if has_pending(status) {
        status.next_run_at = None;
        if !matches!(
            status.phase.as_str(),
            "thinking" | "applying" | "publishing" | "stopping"
        ) {
            status.phase = "awaitingAction".into();
        }
    }
}

/// Pending requests survive restart. An interrupted send is never retried:
/// its external outcome may already have happened before the app stopped.
pub(super) fn recover(status: &mut Status) -> Result<bool, String> {
    let mut ids = BTreeSet::new();
    let mut changed = false;
    for action in &mut status.pending_actions {
        if uuid::Uuid::parse_str(&action.id).is_err()
            || uuid::Uuid::parse_str(&action.run_id).is_err()
            || !ids.insert(action.id.clone())
            || !status.runs.iter().any(|run| run.id == action.run_id)
            || action.summary.len() > 8_000
            || action
                .error
                .as_ref()
                .is_some_and(|error| error.len() > 8_000)
            || action.review.payload_digest.is_empty()
            || action.review.payload_digest.len() > 128
        {
            return Err("保存された確認事項が不正です。外部への操作は開始しません".into());
        }
        if action.status == ActionStatus::Submitting {
            action.status = ActionStatus::Unknown;
            action.error = Some("公開処理の途中でアプリが終了しました。ブランチやPRが作成された可能性があります。GitHubを確認してください。自動で再送しません。".into());
            changed = true;
        }
    }
    if has_pending(status) && status.next_run_at.take().is_some() {
        changed = true;
    }
    Ok(changed)
}

fn job_path(runtime: &super::Runtime, run_id: &str) -> Result<PathBuf, String> {
    if uuid::Uuid::parse_str(run_id).is_err() {
        return Err("作業の識別子が不正です".into());
    }
    Ok(super::storage_dir(runtime)?
        .join("development")
        .join(run_id))
}

fn existing(status: &Status, run_id: &str) -> Option<Action> {
    status
        .pending_actions
        .iter()
        .rev()
        .find(|action| {
            action.run_id == run_id
                && matches!(
                    action.status,
                    ActionStatus::Pending
                        | ActionStatus::Submitting
                        | ActionStatus::Published
                        | ActionStatus::Unknown
                )
        })
        .cloned()
}

fn retire_failed(status: &mut Status, run_id: &str) {
    for previous in &mut status.pending_actions {
        if previous.run_id == run_id && previous.status == ActionStatus::Failed {
            previous.status = ActionStatus::Declined;
        }
    }
}

fn validate_preparation(
    runtime: &super::Runtime,
    run_id: &str,
    revision: Option<u64>,
) -> Result<(), String> {
    let run = runtime
        .status
        .runs
        .iter()
        .find(|run| run.id == run_id)
        .ok_or("作業履歴が見つかりません")?;
    if run.development_path.is_none() {
        return Err(
            "この結果には公開用の成果物がありません。作業内容をAIに相談してください。".into(),
        );
    }
    if let Some(revision) = revision {
        if runtime.revision != revision
            || runtime.active_run_id.as_deref() != Some(run_id)
            || runtime
                .cancel
                .as_ref()
                .is_none_or(CancellationToken::is_cancelled)
        {
            return Err("作業を停止しました。新しい確認事項は作成していません".into());
        }
    } else if run.status == "running" {
        return Err("作業とプロセスの終了を待ってから成果物を確認してください".into());
    }
    Ok(())
}

pub(super) async fn prepare_for_run(
    state: &AutonomyState,
    run_id: &str,
    revision: Option<u64>,
    reason: &str,
) -> Result<Action, String> {
    let job = {
        let runtime = super::lock(state)?;
        validate_preparation(&runtime, run_id, revision)?;
        if let Some(action) = existing(&runtime.status, run_id) {
            return Ok(action);
        }
        job_path(&runtime, run_id)?
    };
    let id = run_id.to_owned();
    let review = tauri::async_runtime::spawn_blocking(move || publishing::prepare(&job, &id))
        .await
        .map_err(|e| e.to_string())??;
    let mut runtime = super::lock(state)?;
    validate_preparation(&runtime, run_id, revision)?;
    if let Some(action) = existing(&runtime.status, run_id) {
        return Ok(action);
    }
    let action = Action {
        id: uuid::Uuid::new_v4().to_string(),
        run_id: run_id.to_owned(),
        kind: ActionKind::PublishPullRequest,
        status: ActionStatus::Pending,
        acknowledged: false,
        created_at: super::clock_ms(),
        summary: reason.chars().take(2_000).collect(),
        error: None,
        pull_request_url: None,
        review,
    };
    let mut next = runtime.status.clone();
    // Retain older declined/failed requests as history; preparing again creates
    // a fresh one-shot ID and never reuses an earlier approval.
    retire_failed(&mut next, run_id);
    next.pending_actions.push(action.clone());
    park(&mut next);
    super::persist_at(&super::storage_dir(&runtime)?, &next)?;
    runtime.status = next;
    Ok(action)
}

#[tauri::command]
pub async fn autonomy_prepare_publication(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AutonomyState>,
    run_id: String,
) -> Result<Action, String> {
    super::main_window(&window)?;
    let action = prepare_for_run(
        &state,
        &run_id,
        None,
        "この成果物をGitHubに送信し、ドラフトPRを作成してよいですか？",
    )
    .await?;
    let _ = window.emit("autonomy:action-review-available", &action);
    Ok(action)
}

fn claim_approval(
    runtime: &mut super::Runtime,
    id: &str,
    digest: &str,
    save: impl Fn(&Status) -> Result<(), String>,
) -> Result<(publishing::PublicationReview, CancellationToken), String> {
    if runtime.cancel.is_some() || runtime.consulting.is_some() || runtime.cleanup_pending {
        return Err("前の作業とプロセスの終了を待ってから承認してください".into());
    }
    let mut next = runtime.status.clone();
    let action = next
        .pending_actions
        .iter_mut()
        .find(|action| action.id == id)
        .ok_or("確認事項が見つかりません")?;
    if action.status != ActionStatus::Pending {
        return Err("この確認事項はすでに処理されています。再送しません".into());
    }
    if action.review.payload_digest != digest {
        return Err("表示した内容と確認事項が一致しません。最新の内容を確認してください".into());
    }
    let review = action.review.clone();
    action.status = ActionStatus::Submitting;
    action.error = None;
    next.phase = "publishing".into();
    next.next_run_at = None;
    next.error = None;
    // This durable transition consumes the one-shot approval before any send.
    save(&next)?;
    let cancel = CancellationToken::new();
    runtime.status = next;
    runtime.cancel = Some(cancel.clone());
    runtime.active_action_id = Some(id.to_owned());
    Ok((review, cancel))
}

pub(super) fn complete(state: &AutonomyState, completion: Completion) {
    let Ok(mut runtime) = super::lock(state) else {
        return;
    };
    if runtime.active_action_id.as_deref() != Some(&completion.id) {
        return;
    }
    if runtime.cleanup_pending {
        runtime.deferred_action = Some(completion);
        runtime.status.phase = "stopping".into();
        return;
    }
    runtime.active_action_id = None;
    runtime.cancel = None;
    let action = runtime
        .status
        .pending_actions
        .iter_mut()
        .find(|action| action.id == completion.id);
    if let Some(action) = action {
        match completion.result {
            Ok(url) => {
                action.status = ActionStatus::Published;
                action.pull_request_url = Some(url);
                action.error = None;
            }
            Err(publishing::PublicationError::NotStarted(message)) => {
                action.status = ActionStatus::Failed;
                action.error = Some(message.chars().take(2_000).collect());
            }
            Err(publishing::PublicationError::Unknown(message)) => {
                action.status = ActionStatus::Unknown;
                action.error = Some(message.chars().take(2_000).collect());
            }
        }
    }
    if let Some(action) = runtime
        .status
        .pending_actions
        .iter()
        .find(|action| action.id == completion.id)
        .cloned()
    {
        if let Some(url) = action.pull_request_url {
            if let Some(run) = runtime
                .status
                .runs
                .iter_mut()
                .find(|run| run.id == action.run_id)
            {
                run.pull_request_url = Some(url);
            }
        }
    }
    restore_schedule(&mut runtime);
    if let Err(error) = super::persist(&runtime) {
        if let Some(scope) = runtime.status.contract.as_mut() {
            scope.enabled = false;
        }
        runtime.status.next_run_at = None;
        runtime.status.error = Some(format!(
            "外部操作の結果を保存できません。再送せずGitHubを確認してください: {error}"
        ));
    }
}

fn restore_schedule(runtime: &mut super::Runtime) {
    let enabled = runtime
        .status
        .contract
        .as_ref()
        .is_some_and(|scope| scope.enabled);
    runtime.status.phase = if has_pending(&runtime.status) {
        "awaitingAction"
    } else if enabled {
        "idle"
    } else {
        "paused"
    }
    .into();
    runtime.status.next_run_at =
        (enabled && !has_pending(&runtime.status)).then_some(super::clock_ms());
}

struct ApprovalGuard {
    state: AutonomyState,
    id: String,
    cancel: CancellationToken,
    armed: bool,
}
impl Drop for ApprovalGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancel.cancel();
            complete(&self.state, Completion {
                id: self.id.clone(),
                result: Err(publishing::PublicationError::Unknown("公開処理の応答が中断されました。ブランチやPRが作成された可能性があります。GitHubを確認してください。自動で再送しません。".into())),
            });
        }
    }
}

#[tauri::command]
pub async fn autonomy_approve_action(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AutonomyState>,
    id: String,
    digest: String,
) -> Result<(), String> {
    super::main_window(&window)?;
    let (job, review, cancel) = {
        let mut runtime = super::lock(&state)?;
        let run_id = runtime
            .status
            .pending_actions
            .iter()
            .find(|action| action.id == id)
            .ok_or("確認事項が見つかりません")?
            .run_id
            .clone();
        let job = job_path(&runtime, &run_id)?;
        let store = super::storage_dir(&runtime)?;
        let (review, cancel) = claim_approval(&mut runtime, &id, &digest, |status| {
            super::persist_at(&store, status)
        })?;
        (job, review, cancel)
    };
    let mut guard = ApprovalGuard {
        state: state.inner().clone(),
        id: id.clone(),
        cancel: cancel.clone(),
        armed: true,
    };
    let observer = super::cleanup_observer(&state, CleanupOwner::Action(id.clone()));
    let result = super::process_supervisor::observe_cleanup(
        observer,
        publishing::publish(&job, &review, cancel),
    )
    .await;
    let error = result.as_ref().err().map(|error| match error {
        publishing::PublicationError::NotStarted(message)
        | publishing::PublicationError::Unknown(message) => message.clone(),
    });
    complete(&state, Completion { id, result });
    guard.armed = false;
    let _ = window.emit("autonomy:actions-changed", ());
    match error {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

fn decline(
    runtime: &mut super::Runtime,
    id: &str,
    save: impl Fn(&Status) -> Result<(), String>,
) -> Result<(), String> {
    let mut next = runtime.status.clone();
    let action = next
        .pending_actions
        .iter_mut()
        .find(|action| action.id == id)
        .ok_or("確認事項が見つかりません")?;
    if !matches!(action.status, ActionStatus::Pending | ActionStatus::Failed) {
        return Err(
            "送信中または送信結果が不明な確認事項は取り消せません。GitHubで結果を確認してください"
                .into(),
        );
    }
    action.status = ActionStatus::Declined;
    action.error = None;
    if runtime.cancel.is_none() && runtime.consulting.is_none() {
        let enabled = next.contract.as_ref().is_some_and(|scope| scope.enabled);
        next.phase = if has_pending(&next) {
            "awaitingAction"
        } else if enabled {
            "idle"
        } else {
            "paused"
        }
        .into();
        next.next_run_at = (enabled && !has_pending(&next)).then_some(super::clock_ms());
    }
    save(&next)?;
    runtime.status = next;
    Ok(())
}

#[tauri::command]
pub fn autonomy_decline_action(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AutonomyState>,
    id: String,
) -> Result<(), String> {
    super::main_window(&window)?;
    let mut runtime = super::lock(&state)?;
    let store = super::storage_dir(&runtime)?;
    decline(&mut runtime, &id, |status| {
        super::persist_at(&store, status)
    })
}

fn acknowledge(
    runtime: &mut super::Runtime,
    id: &str,
    save: impl Fn(&Status) -> Result<(), String>,
) -> Result<(), String> {
    let mut next = runtime.status.clone();
    let action = next
        .pending_actions
        .iter_mut()
        .find(|action| action.id == id)
        .ok_or("確認事項が見つかりません")?;
    if action.status != ActionStatus::Unknown {
        return Err("送信結果が不明な確認事項だけを確認終了にできます".into());
    }
    action.acknowledged = true;
    if runtime.cancel.is_none() && runtime.consulting.is_none() {
        let enabled = next.contract.as_ref().is_some_and(|scope| scope.enabled);
        next.phase = if has_pending(&next) {
            "awaitingAction"
        } else if enabled {
            "idle"
        } else {
            "paused"
        }
        .into();
        next.next_run_at = (enabled && !has_pending(&next)).then_some(super::clock_ms());
    }
    save(&next)?;
    runtime.status = next;
    Ok(())
}

#[tauri::command]
pub fn autonomy_acknowledge_action(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AutonomyState>,
    id: String,
) -> Result<(), String> {
    super::main_window(&window)?;
    let mut runtime = super::lock(&state)?;
    let store = super::storage_dir(&runtime)?;
    acknowledge(&mut runtime, &id, |status| {
        super::persist_at(&store, status)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autonomy::{Run, Runtime};

    fn fixture() -> (tempfile::TempDir, Runtime, String) {
        let dir = tempfile::tempdir().unwrap();
        let run_id = uuid::Uuid::new_v4().to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let review: publishing::PublicationReview = serde_json::from_value(serde_json::json!({
            "preparationId":uuid::Uuid::new_v4().to_string(), "artifactPath":"/private/artifact",
            "repository":"owner/repo", "baseBranch":"main", "baseCommit":"base", "headBranch":"autonomy/test",
            "commit":"commit", "artifactTree":"tree", "title":"Test", "body":"Review test", "diff":"diff",
            "changedPaths":["README.md"], "checks":[], "sourceRoot":"/private/source", "payloadDigest":"digest"
        })).unwrap();
        let mut runtime = Runtime {
            loaded: true,
            storage_root: Some(dir.path().to_owned()),
            ..Runtime::default()
        };
        runtime.status.runs.push(Run {
            id: run_id.clone(),
            started_at: 1,
            finished_at: Some(2),
            status: "completed".into(),
            summary: "done".into(),
            reason: "test".into(),
            changed_paths: vec![],
            can_undo: false,
            development_path: Some("/private/artifact".into()),
            pull_request_url: None,
            branch: None,
            validation_summary: None,
        });
        runtime.status.pending_actions.push(Action {
            id: id.clone(),
            run_id,
            kind: ActionKind::PublishPullRequest,
            status: ActionStatus::Pending,
            acknowledged: false,
            created_at: 2,
            summary: "Review".into(),
            error: None,
            pull_request_url: None,
            review,
        });
        (dir, runtime, id)
    }

    #[test]
    fn approval_requires_exact_digest_and_durable_consumption() {
        let (_dir, mut runtime, id) = fixture();
        assert!(claim_approval(&mut runtime, &id, "stale", |_| Ok(())).is_err());
        assert!(claim_approval(&mut runtime, &id, "digest", |_| Err("disk full".into())).is_err());
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Pending
        );
        assert!(runtime.cancel.is_none());
        claim_approval(&mut runtime, &id, "digest", |state| {
            assert_eq!(state.pending_actions[0].status, ActionStatus::Submitting);
            Ok(())
        })
        .unwrap();
        assert!(claim_approval(&mut runtime, &id, "digest", |_| Ok(())).is_err());
    }

    #[test]
    fn persisted_pending_and_interrupted_send_survive_restart() {
        let (dir, mut runtime, id) = fixture();
        super::super::persist(&runtime).unwrap();
        let (pending, _) = super::super::load_status_at(dir.path(), 10).unwrap();
        assert_eq!(pending.pending_actions[0].id, id);
        assert!(has_pending(&pending));
        claim_approval(&mut runtime, &id, "digest", |state| {
            super::super::persist_at(dir.path(), state)
        })
        .unwrap();
        let (recovered, changed) = super::super::load_status_at(dir.path(), 10).unwrap();
        assert!(changed);
        assert_eq!(recovered.pending_actions[0].status, ActionStatus::Unknown);
        assert!(has_pending(&recovered));
    }

    #[test]
    fn decline_never_claims_external_slot_and_is_durable() {
        let (_dir, mut runtime, id) = fixture();
        assert!(decline(&mut runtime, &id, |_| Err("disk full".into())).is_err());
        assert!(has_pending(&runtime.status));
        decline(&mut runtime, &id, |_| Ok(())).unwrap();
        assert!(!has_pending(&runtime.status));
        assert!(runtime.cancel.is_none());
        assert!(claim_approval(&mut runtime, &id, "digest", |_| Ok(())).is_err());
    }

    #[test]
    fn unknown_acknowledgment_releases_only_local_work_and_never_resends() {
        let (_dir, mut runtime, id) = fixture();
        assert!(acknowledge(&mut runtime, &id, |_| Ok(())).is_err());
        runtime.status.pending_actions[0].status = ActionStatus::Unknown;
        assert!(decline(&mut runtime, &id, |_| Ok(())).is_err());
        acknowledge(&mut runtime, &id, |_| Ok(())).unwrap();
        assert!(!has_pending(&runtime.status));
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Unknown
        );
        assert!(existing(&runtime.status, &runtime.status.pending_actions[0].run_id).is_some());
        assert!(claim_approval(&mut runtime, &id, "digest", |_| Ok(())).is_err());
    }

    #[test]
    fn unresolved_actions_block_scheduling_and_survive_stop() {
        let (_dir, mut runtime, id) = fixture();
        assert!(super::super::claim_due(&mut runtime, true, 10, |_| Ok(())).is_err());
        assert!(super::super::claim_due(&mut runtime, false, 10, |_| Ok(()))
            .unwrap()
            .is_none());
        super::super::cancel_active(&mut runtime);
        assert_eq!(runtime.status.pending_actions[0].id, id);
        assert!(has_pending(&runtime.status));
    }

    #[test]
    fn cancelled_approval_waits_for_cleanup_and_retains_unknown_outcome() {
        let (_dir, mut runtime, id) = fixture();
        let (_, cancel) = claim_approval(&mut runtime, &id, "digest", |_| Ok(())).unwrap();
        let state = AutonomyState(std::sync::Arc::new(std::sync::Mutex::new(runtime)));
        let observer = super::super::cleanup_observer(&state, CleanupOwner::Action(id.clone()));
        observer(super::super::process_supervisor::CleanupProgress::Pending);
        super::super::cancel_active(&mut super::super::lock(&state).unwrap());
        assert!(cancel.is_cancelled());
        complete(
            &state,
            Completion {
                id: id.clone(),
                result: Err(publishing::PublicationError::Unknown(
                    "cancelled after send".into(),
                )),
            },
        );
        assert!(super::super::lock(&state).unwrap().cancel.is_some());
        observer(super::super::process_supervisor::CleanupProgress::Complete);
        let runtime = super::super::lock(&state).unwrap();
        assert!(runtime.cancel.is_none());
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Unknown
        );
        assert!(has_pending(&runtime.status));
    }

    #[test]
    fn successful_reprepare_retires_only_same_run_failed_request() {
        let (_dir, mut runtime, _) = fixture();
        let run_id = runtime.status.pending_actions[0].run_id.clone();
        runtime.status.pending_actions[0].status = ActionStatus::Failed;
        runtime.status.pending_actions[0].error = Some("missing credentials".into());
        let mut other = runtime.status.pending_actions[0].clone();
        other.id = uuid::Uuid::new_v4().to_string();
        other.run_id = uuid::Uuid::new_v4().to_string();
        runtime.status.pending_actions.push(other);
        retire_failed(&mut runtime.status, &run_id);
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Declined
        );
        assert_eq!(
            runtime.status.pending_actions[0].error.as_deref(),
            Some("missing credentials")
        );
        assert_eq!(
            runtime.status.pending_actions[1].status,
            ActionStatus::Failed
        );
        assert!(has_pending(&runtime.status));
        runtime.status.pending_actions.pop();
        assert!(!has_pending(&runtime.status));
    }

    #[test]
    fn published_result_updates_original_run_and_persists() {
        let (dir, mut runtime, id) = fixture();
        claim_approval(&mut runtime, &id, "digest", |_| Ok(())).unwrap();
        let state = AutonomyState(std::sync::Arc::new(std::sync::Mutex::new(runtime)));
        let url = "https://github.com/owner/repo/pull/1";
        complete(
            &state,
            Completion {
                id,
                result: Ok(url.into()),
            },
        );
        let (saved, _) =
            super::super::load_status_at(dir.path(), super::super::clock_ms()).unwrap();
        assert_eq!(saved.pending_actions[0].status, ActionStatus::Published);
        assert_eq!(saved.runs[0].pull_request_url.as_deref(), Some(url));
        assert!(!has_pending(&saved));
    }

    #[test]
    fn acknowledgment_is_durable_and_does_not_change_unknown_result() {
        let (dir, mut runtime, id) = fixture();
        runtime.status.pending_actions[0].status = ActionStatus::Unknown;
        assert!(acknowledge(&mut runtime, &id, |_| Err("disk full".into())).is_err());
        assert!(!runtime.status.pending_actions[0].acknowledged);
        acknowledge(&mut runtime, &id, |status| {
            super::super::persist_at(dir.path(), status)
        })
        .unwrap();
        let (saved, _) = super::super::load_status_at(dir.path(), 10).unwrap();
        assert!(saved.pending_actions[0].acknowledged);
        assert_eq!(saved.pending_actions[0].status, ActionStatus::Unknown);
        assert!(!has_pending(&saved));
    }

    #[test]
    fn stale_completion_cannot_release_current_approval() {
        let (_dir, mut runtime, id) = fixture();
        claim_approval(&mut runtime, &id, "digest", |_| Ok(())).unwrap();
        let state = AutonomyState(std::sync::Arc::new(std::sync::Mutex::new(runtime)));
        complete(
            &state,
            Completion {
                id: uuid::Uuid::new_v4().to_string(),
                result: Ok("https://github.com/owner/repo/pull/1".into()),
            },
        );
        let runtime = super::super::lock(&state).unwrap();
        assert!(runtime.cancel.is_some());
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Submitting
        );
    }
}
