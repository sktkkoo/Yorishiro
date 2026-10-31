//! Durable, read-only reconciliation after a successful intermediate operation.
//! Restarting this phase may repeat a judgment, never the completed operation.
use super::actions::{Action, ActionStatus};
use super::{goal_handoff, AutonomyState, Contract, Run, Status};
use std::path::PathBuf;
use tauri::Emitter;
use tokio_util::sync::CancellationToken;

struct Claim {
    action: Action,
    run: Run,
    history: Vec<Action>,
    contract: Contract,
    goal: String,
    storage: PathBuf,
    revision: u64,
    cancel: CancellationToken,
}

enum Claimed {
    None,
    Handled,
    Assessment(Box<Claim>),
}

/// A persisted read-only judgment is safe to resume after restart. Real running
/// work and operation claims retain the normal interruption handling.
pub(super) fn recover(status: &mut Status, now: u64) -> Result<bool, String> {
    if !matches!(status.phase.as_str(), "thinking" | "stopping" | "idle")
        || status.runs.iter().any(|run| run.status == "running")
        || status
            .pending_actions
            .iter()
            .any(|action| action.status == ActionStatus::Executing)
    {
        return Ok(false);
    }
    let Some(action) = status
        .pending_actions
        .iter()
        .find(|action| action.continuation_pending)
    else {
        return Ok(false);
    };
    if action.status != ActionStatus::Completed
        || action.goal_complete != Some(false)
        || super::actions::digest(action)? != action.payload_digest
    {
        return Err("継続する操作の完了記録が不正です".into());
    }
    let enabled = status.contract.as_ref().is_some_and(|scope| scope.enabled);
    let phase = if enabled { "idle" } else { "paused" };
    let next = enabled.then_some(now);
    let changed = status.phase != phase || status.next_run_at != next;
    status.phase = phase.into();
    status.next_run_at = next;
    Ok(changed)
}

fn claim(
    runtime: &mut super::Runtime,
    manual: bool,
    save: impl Fn(&Status) -> Result<(), String>,
) -> Result<Claimed, String> {
    if runtime.cancel.is_some() || runtime.consulting.is_some() || runtime.cleanup_pending {
        return Ok(Claimed::None);
    }
    let Some(action) = runtime
        .status
        .pending_actions
        .iter()
        .find(|action| action.continuation_pending)
        .cloned()
    else {
        return Ok(Claimed::None);
    };
    let contract = runtime
        .status
        .contract
        .as_ref()
        .ok_or("次の操作を確認するための目的が保存されていません")?;
    if !manual && !contract.enabled {
        return Ok(Claimed::Handled);
    }
    let matching_scope = action.continuation_scope.as_deref()
        == Some(super::actions::scope_fingerprint(contract)?.as_str());
    let stale_daily_receipt = contract.review_mode == super::ReviewMode::Daily
        && runtime.status.runs.iter().any(|run| {
            run.id == action.id
                && super::local_day(run.started_at) != super::local_day(super::clock_ms())
        });
    if action.status != ActionStatus::Completed
        || action.goal_complete != Some(false)
        || contract.root != action.source_root
        || !matching_scope
        || stale_daily_receipt
    {
        let mut next = runtime.status.clone();
        let receipt = next
            .pending_actions
            .iter_mut()
            .find(|item| item.id == action.id)
            .unwrap();
        receipt.continuation_pending = false;
        next.phase = "blocked".into();
        next.next_run_at = None;
        next.error = Some(if stale_daily_receipt {
            "前日までの完了済み操作に残作業があります。実行結果と当日の目的を確認してください"
                .into()
        } else {
            "任せる目的または許可設定が変わったため、完了済み操作からの継続を停止しました。実行済みの結果は保持しています".into()
        });
        save(&next)?;
        runtime.status = next;
        return Ok(Claimed::Handled);
    }
    let run = runtime
        .status
        .runs
        .iter()
        .find(|run| run.id == action.run_id)
        .cloned()
        .ok_or("完了した操作の元の作業記録が見つかりません")?;
    let mut history = super::actions::chain(&runtime.status, &action)?;
    history.push(action.clone());
    let mut goal = contract.goal.clone();
    if contract.review_mode == super::ReviewMode::Daily {
        if let Some(work) = runtime.status.daily_work.as_ref() {
            if work.day != super::local_day(super::clock_ms()) {
                // Today's approval cannot replace the objective of a receipt
                // left over from another day.
                let mut next = runtime.status.clone();
                next.pending_actions
                    .iter_mut()
                    .find(|item| item.id == action.id)
                    .unwrap()
                    .continuation_pending = false;
                next.phase = "blocked".into();
                next.next_run_at = None;
                next.error = Some("前日までの完了済み操作に残作業があります。実行結果と当日の目的を確認してください".into());
                save(&next)?;
                runtime.status = next;
                return Ok(Claimed::Handled);
            }
            goal = format!(
                "継続して任された目的: {}\n今回承認された日次の仕事: {}",
                goal, work.goal
            );
        }
    }
    let storage = super::storage_dir(runtime)?;
    let contract = contract.clone();
    let mut next = runtime.status.clone();
    // Keep the durable marker until the judgment and any follow-up request are
    // saved. A crash here leaves only a read-only assessment to resume.
    next.phase = "thinking".into();
    next.next_run_at = None;
    next.error = None;
    save(&next)?;
    let cancel = CancellationToken::new();
    runtime.status = next;
    runtime.active_run_id = Some(action.id.clone());
    runtime.cancel = Some(cancel.clone());
    Ok(Claimed::Assessment(Box::new(Claim {
        action,
        run,
        history,
        contract,
        goal,
        storage,
        revision: runtime.revision,
        cancel,
    })))
}

pub(super) fn start(
    state: &AutonomyState,
    manual: bool,
    window: Option<tauri::WebviewWindow>,
) -> Result<bool, String> {
    let claimed = {
        let mut runtime = super::lock(state)?;
        let storage = super::storage_dir(&runtime)?;
        claim(&mut runtime, manual, |status| {
            super::persist_at(&storage, status)
        })?
    };
    let Claimed::Assessment(claim) = claimed else {
        return Ok(matches!(claimed, Claimed::Handled));
    };
    let owned = state.clone();
    tauri::async_runtime::spawn(async move {
        let observer =
            super::cleanup_observer(&owned, super::CleanupOwner::Action(claim.action.id.clone()));
        let result = super::process_supervisor::observe_cleanup(observer, async {
            super::validate_contract(&claim.contract)?;
            goal_handoff::assess_execution(
                std::path::Path::new(&claim.contract.root),
                &claim.storage,
                &claim.run,
                &claim.goal,
                &claim.history,
                claim.cancel.clone(),
            )
            .await
        })
        .await;
        // A judgment's child processes must be gone before releasing its slot.
        // Its pending marker remains durable throughout this cleanup wait.
        loop {
            let pending = super::lock(&owned).is_ok_and(|runtime| {
                runtime.active_run_id.as_deref() == Some(claim.action.id.as_str())
                    && runtime.cleanup_pending
            });
            if !pending {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        let dispatch = finish(&owned, &claim, result);
        if dispatch {
            if let Err(error) = super::start(&owned, false, window.clone()) {
                if let Ok(mut runtime) = super::lock(&owned) {
                    runtime.status.error = Some(error);
                    let _ = super::persist(&runtime);
                }
            }
        }
        if let Some(window) = window {
            let _ = window.emit("autonomy:status-changed", ());
        }
    });
    Ok(true)
}

/// Returns whether a queued follow-up may be dispatched. The predecessor stays
/// completed even when judgment, cancellation, or persistence prevents progress.
fn finish(
    state: &AutonomyState,
    claim: &Claim,
    result: Result<goal_handoff::Decision, String>,
) -> bool {
    let Ok(mut runtime) = super::lock(state) else {
        return false;
    };
    if runtime.active_run_id.as_deref() != Some(claim.action.id.as_str()) {
        return false;
    }
    let current =
        super::authorized_result(&runtime, &claim.action.id, claim.revision, &claim.cancel)
            && runtime.status.contract.as_ref().is_some_and(|contract| {
                super::actions::scope_fingerprint(contract)
                    .is_ok_and(|scope| Some(scope) == claim.action.continuation_scope)
            });
    let mut result = result;
    let mut dispatch = false;
    if current {
        if let Ok(goal_handoff::Decision::Action(request)) = &result {
            match super::actions::queue_continuation(&mut runtime, &claim.action.id, request) {
                Ok(_) => dispatch = true,
                Err(error) => result = Err(error),
            }
        }
    }
    let mut next = runtime.status.clone();
    if let Some(action) = next
        .pending_actions
        .iter_mut()
        .find(|action| action.id == claim.action.id)
    {
        action.continuation_pending = false;
        if current && matches!(&result, Ok(goal_handoff::Decision::Complete)) {
            action.goal_complete = Some(true);
        }
    }
    if current {
        let now = super::clock_ms();
        match result {
            Ok(goal_handoff::Decision::Complete) => {
                next.phase = if claim.contract.enabled {
                    "idle"
                } else {
                    "paused"
                }
                .into();
                next.next_run_at = claim
                    .contract
                    .enabled
                    .then_some(now.saturating_add(claim.contract.interval_minutes * 60_000));
                super::action_execution::complete_daily_work(&mut next, now);
            }
            Ok(goal_handoff::Decision::Action(_)) => {
                next.phase = "awaitingAction".into();
                next.next_run_at = None;
                super::actions::park(&mut next);
            }
            Ok(goal_handoff::Decision::Question(question)) | Err(question) => {
                next.phase = "blocked".into();
                next.next_run_at = None;
                next.error = Some(format!(
                    "操作は完了していますが、続きの作業を確認できません: {}",
                    question.chars().take(2000).collect::<String>()
                ));
            }
        }
    } else {
        dispatch = false;
        // New settings own their schedule. Cancellation within the same scope
        // must not fall through to fresh work and abandon this artifact.
        if runtime.revision == claim.revision {
            next.phase = "blocked".into();
            next.next_run_at = None;
            next.error =
                Some("次の操作の確認を停止しました。完了済みの実行結果は保持しています".into());
        }
    }
    runtime.active_run_id = None;
    runtime.cancel = None;
    match super::persist_at(&claim.storage, &next) {
        Ok(()) => runtime.status = next,
        Err(error) => {
            // Retain the pending receipt for read-only recovery, but stop this
            // process from starting another operation on an unsaved decision.
            if let Some(contract) = runtime.status.contract.as_mut() {
                contract.enabled = false;
            }
            runtime.status.phase = "failed".into();
            runtime.status.next_run_at = None;
            runtime.status.error = Some(format!("続きの作業の確認結果を保存できません: {error}"));
            dispatch = false;
        }
    }
    dispatch
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn fixture() -> (AutonomyState, tempfile::TempDir, String) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let project = root.join("project");
        let storage = root.join("state");
        std::fs::create_dir(&project).unwrap();
        std::fs::create_dir(&storage).unwrap();
        let contract: Contract = serde_json::from_value(json!({
            "goal": "Commit, push and open a pull request for the prepared update",
            "root": project, "allowedOperations": ["write", "move", "trash"],
            "intervalMinutes": 30, "maxRunsPerDay": 48, "enabled": true,
            "reviewMode": "automatic", "workMode": "auto",
            "automaticActionApproval": true,
        }))
        .unwrap();
        let run_id = uuid::Uuid::new_v4().to_string();
        let id = uuid::Uuid::new_v4().to_string();
        let now = super::super::clock_ms();
        let run: Run = serde_json::from_value(json!({
            "id": run_id, "startedAt": now, "finishedAt": now,
            "status": "completed", "summary": "Prepared the update",
            "reason": "Delegated work", "changedPaths": [], "canUndo": false,
            "sourceRoot": project,
        }))
        .unwrap();
        let receipt: Run = serde_json::from_value(json!({
            "id": id, "startedAt": now, "finishedAt": now,
            "status": "completed", "summary": "Created commit abc123",
            "reason": "Commit the prepared update", "changedPaths": [], "canUndo": false,
            "sourceRoot": project,
        }))
        .unwrap();
        let mut action: Action = serde_json::from_value(json!({
            "id": id, "runId": run_id, "kind": "operation", "status": "completed",
            "createdAt": now, "summary": "Commit the prepared update",
            "sourceRoot": project, "operation": "Create the local commit",
            "target": "private copy", "impact": "Local history receives a commit",
            "details": "Commit only the verified files", "executionSummary": "Created commit abc123",
            "goalComplete": false, "continuationPending": true,
            "continuationScope": super::super::actions::scope_fingerprint(&contract).unwrap(),
        }))
        .unwrap();
        action.payload_digest = super::super::actions::digest(&action).unwrap();
        let runtime = super::super::Runtime {
            loaded: true,
            storage_root: Some(storage),
            status: Status {
                contract: Some(contract),
                phase: "idle".into(),
                next_run_at: Some(now),
                runs: vec![run, receipt],
                pending_actions: vec![action],
                ..Default::default()
            },
            ..Default::default()
        };
        (AutonomyState(Arc::new(Mutex::new(runtime))), directory, id)
    }

    #[test]
    fn restart_resumes_only_the_read_only_assessment_of_a_completed_receipt() {
        let (state, _directory, id) = fixture();
        let mut runtime = super::super::lock(&state).unwrap();
        let Claimed::Assessment(first) = claim(&mut runtime, false, |_| Ok(())).unwrap() else {
            panic!("expected a read-only assessment");
        };
        assert_eq!(first.action.id, id);
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Completed
        );
        assert_eq!(runtime.status.runs.len(), 2);
        let storage = runtime.storage_root.clone().unwrap();
        super::super::persist_at(&storage, &runtime.status).unwrap();
        let (saved, recovered) =
            super::super::load_status_at(&storage, super::super::clock_ms()).unwrap();
        assert!(recovered);
        assert_eq!(saved.phase, "idle");
        assert!(saved.contract.as_ref().unwrap().enabled);
        let mut resumed = super::super::Runtime {
            loaded: true,
            storage_root: runtime.storage_root.clone(),
            status: saved,
            ..Default::default()
        };
        let Claimed::Assessment(second) = claim(&mut resumed, false, |_| Ok(())).unwrap() else {
            panic!("expected resumed read-only assessment");
        };
        assert_eq!(second.action.id, id);
        assert_eq!(resumed.status.runs.len(), 2);
        assert_eq!(
            resumed.status.pending_actions[0].status,
            ActionStatus::Completed
        );
        assert!(resumed.status.pending_actions[0].continuation_pending);
    }

    #[test]
    fn revoked_automatic_permission_blocks_the_old_continuation_without_replay() {
        let (state, _directory, _) = fixture();
        let mut runtime = super::super::lock(&state).unwrap();
        runtime
            .status
            .contract
            .as_mut()
            .unwrap()
            .automatic_action_approval = false;
        assert!(matches!(
            claim(&mut runtime, false, |_| Ok(())).unwrap(),
            Claimed::Handled
        ));
        assert!(!runtime.status.pending_actions[0].continuation_pending);
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Completed
        );
        assert!(runtime.active_run_id.is_none());
        assert!(runtime.status.next_run_at.is_none());
        assert_eq!(runtime.status.phase, "blocked");
    }

    #[test]
    fn judgment_failure_keeps_the_successful_commit_and_stops_new_work() {
        let (state, _directory, _) = fixture();
        let Claimed::Assessment(claimed) =
            claim(&mut super::super::lock(&state).unwrap(), false, |_| Ok(())).unwrap()
        else {
            panic!("expected assessment");
        };
        assert!(!finish(&state, &claimed, Err("Judge unavailable".into())));
        let runtime = super::super::lock(&state).unwrap();
        let action = &runtime.status.pending_actions[0];
        assert_eq!(action.status, ActionStatus::Completed);
        assert_eq!(
            action.execution_summary.as_deref(),
            Some("Created commit abc123")
        );
        assert_eq!(action.goal_complete, Some(false));
        assert!(!action.continuation_pending);
        assert_eq!(runtime.status.phase, "blocked");
        assert!(runtime.status.next_run_at.is_none());
        assert!(runtime.active_run_id.is_none());
        assert_eq!(runtime.status.runs[1].status, "completed");
    }

    #[test]
    fn changed_scope_during_judgment_cannot_queue_a_follow_up() {
        let (state, _directory, _) = fixture();
        let Claimed::Assessment(claimed) =
            claim(&mut super::super::lock(&state).unwrap(), false, |_| Ok(())).unwrap()
        else {
            panic!("expected assessment");
        };
        super::super::lock(&state)
            .unwrap()
            .status
            .contract
            .as_mut()
            .unwrap()
            .goal = "Prepare documentation only".into();
        let request = super::super::actions::RequestedAction {
            operation: "Push the existing commit".into(),
            target: "https://forge.example/project".into(),
            impact: "Remote branch changes".into(),
            details: "Push commit abc123 from the same private copy".into(),
            reason: "Required for the original pull request".into(),
            network_access: true,
        };
        assert!(!finish(
            &state,
            &claimed,
            Ok(goal_handoff::Decision::Action(request))
        ));
        let runtime = super::super::lock(&state).unwrap();
        assert_eq!(runtime.status.pending_actions.len(), 1);
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Completed
        );
        assert!(!runtime.status.pending_actions[0].continuation_pending);
    }

    #[test]
    fn manually_authorized_commit_keeps_the_network_follow_up_pending() {
        let (state, _directory, id) = fixture();
        {
            let mut runtime = super::super::lock(&state).unwrap();
            let contract = runtime.status.contract.as_mut().unwrap();
            contract.automatic_action_approval = false;
            let scope = super::super::actions::scope_fingerprint(contract).unwrap();
            runtime.status.pending_actions[0].continuation_scope = Some(scope);
        }
        let Claimed::Assessment(claimed) =
            claim(&mut super::super::lock(&state).unwrap(), false, |_| Ok(())).unwrap()
        else {
            panic!("expected assessment");
        };
        let request = super::super::actions::RequestedAction {
            operation: "Publish the prepared pull request".into(),
            target: "https://forge.example/project https://api.forge.example".into(),
            impact: "The verified update is shared for review".into(),
            details: "Push existing commit abc123 and create the described pull request".into(),
            reason: "Delivery remains after the successful local commit".into(),
            network_access: true,
        };
        assert!(finish(
            &state,
            &claimed,
            Ok(goal_handoff::Decision::Action(request))
        ));
        let runtime = super::super::lock(&state).unwrap();
        assert_eq!(runtime.status.pending_actions.len(), 2);
        let follow_up = &runtime.status.pending_actions[1];
        assert_eq!(follow_up.parent_action_id.as_deref(), Some(id.as_str()));
        assert_eq!(follow_up.status, ActionStatus::Pending);
        assert!(!follow_up.auto_approved);
        assert!(follow_up.network_access);
        assert_eq!(runtime.status.runs.len(), 2);
        assert!(runtime.active_run_id.is_none());
    }

    fn follow_up_request() -> super::super::actions::RequestedAction {
        super::super::actions::RequestedAction {
            operation: "Push the existing commit".into(),
            target: "https://forge.example/project".into(),
            impact: "Remote branch receives the verified update".into(),
            details: "Push commit abc123 from the preserved private copy".into(),
            reason: "Required to deliver the prepared update".into(),
            network_access: true,
        }
    }

    #[test]
    fn durable_successor_consumes_the_judgment_before_finish_can_be_interrupted() {
        let (state, _directory, id) = fixture();
        let mut runtime = super::super::lock(&state).unwrap();
        let Claimed::Assessment(_) = claim(&mut runtime, false, |_| Ok(())).unwrap() else {
            panic!("expected assessment");
        };
        let successor =
            super::super::actions::queue_continuation(&mut runtime, &id, &follow_up_request())
                .unwrap();
        // Simulate a crash immediately after queueing, before finish's later
        // save or dispatch. Only the exact successor may survive this boundary.
        let storage = runtime.storage_root.clone().unwrap();
        let (saved, _) = super::super::load_status_at(&storage, super::super::clock_ms()).unwrap();
        assert_eq!(saved.pending_actions.len(), 2);
        assert!(!saved.pending_actions[0].continuation_pending);
        assert_eq!(saved.pending_actions[0].status, ActionStatus::Completed);
        assert_eq!(saved.pending_actions[1].id, successor.id);
        assert_eq!(saved.pending_actions[1].status, ActionStatus::Approved);
        assert!(saved.contract.as_ref().unwrap().enabled);
        assert_eq!(saved.phase, "awaitingAction");
        let mut resumed = super::super::Runtime {
            loaded: true,
            storage_root: Some(storage),
            status: saved,
            ..Default::default()
        };
        assert!(matches!(
            claim(&mut resumed, false, |_| Ok(())).unwrap(),
            Claimed::None
        ));
        assert!(
            super::super::actions::queue_continuation(&mut resumed, &id, &follow_up_request(),)
                .is_err()
        );
        assert_eq!(resumed.status.pending_actions.len(), 2);
    }

    #[test]
    fn failed_successor_save_retains_only_the_pending_read_only_judgment() {
        let (state, _directory, id) = fixture();
        let mut runtime = super::super::lock(&state).unwrap();
        let storage = runtime.storage_root.clone().unwrap();
        std::fs::create_dir(storage.join("state.json")).unwrap();
        assert!(
            super::super::actions::queue_continuation(&mut runtime, &id, &follow_up_request(),)
                .is_err()
        );
        assert_eq!(runtime.status.pending_actions.len(), 1);
        assert!(runtime.status.pending_actions[0].continuation_pending);
        assert_eq!(
            runtime.status.pending_actions[0].status,
            ActionStatus::Completed
        );
    }

    #[test]
    fn recovery_never_mistakes_running_work_for_a_read_only_judgment() {
        let (state, _directory, _) = fixture();
        let mut runtime = super::super::lock(&state).unwrap();
        runtime.status.phase = "thinking".into();
        runtime.status.runs[0].status = "running".into();
        assert!(!recover(&mut runtime.status, super::super::clock_ms()).unwrap());
        assert_eq!(runtime.status.phase, "thinking");
    }
}
