//! Change execution cadence without replacing authority or interrupting work.
use super::{AutonomyState, Contract, ReviewMode, Runtime, Status};
use tauri::Emitter;

/// The next normal work opportunity, including gates that the timer also checks.
/// Continuations belong to an existing run and are not a new scheduled attempt.
pub(super) fn scheduled_at(status: &Status, now: u64) -> Option<u64> {
    let contract = status.contract.as_ref().filter(|scope| scope.enabled)?;
    let mut next = status.next_run_at?;
    if status.pending_work.is_some()
        || super::actions::has_pending(status)
        || status
            .pending_actions
            .iter()
            .any(|action| action.continuation_pending)
    {
        return None;
    }
    if contract.review_mode == ReviewMode::Daily
        && status
            .daily_work
            .as_ref()
            .is_some_and(|work| work.complete && work.day == super::local_day(now))
    {
        next = next.max(super::next_day(now));
    }
    if let Some(at) = super::next_budget_time(&status.runs, now, contract.max_runs_per_day) {
        next = next.max(at);
    }
    Some(next)
}

fn update(
    runtime: &mut Runtime,
    expected_contract: &Contract,
    interval_minutes: u64,
    max_runs_per_day: usize,
    now: u64,
    save: impl Fn(&Status) -> Result<(), String>,
) -> Result<(), String> {
    if !(5..=1440).contains(&interval_minutes) {
        return Err("実行間隔は5〜1440分です".into());
    }
    super::validate_run_budget(max_runs_per_day)?;
    let current = runtime
        .status
        .contract
        .as_ref()
        .ok_or("先に任せる範囲を設定してください")?;
    // Compare all saved fields, including legacy grants. A stale settings panel
    // cannot change another request or overwrite a more recent cadence choice.
    if current != expected_contract {
        return Err("依頼または実行頻度が変わりました。最新の内容を確認してください".into());
    }
    if current.interval_minutes == interval_minutes && current.max_runs_per_day == max_runs_per_day
    {
        return Ok(());
    }
    let mut next = runtime.status.clone();
    let contract = next.contract.as_mut().unwrap();
    contract.interval_minutes = interval_minutes;
    contract.max_runs_per_day = max_runs_per_day;
    if next.next_run_at.is_some() {
        // Normal claims measure cadence from their start. Removing a budget
        // wait must re-evaluate that anchor rather than retain yesterday's cap.
        next.next_run_at = Some(
            next.runs
                .iter()
                .map(|run| run.started_at)
                .max()
                .map(|at| at.saturating_add(interval_minutes * 60_000))
                .unwrap_or(now)
                .max(now),
        );
    }
    next.next_run_at = scheduled_at(&next, now);
    // Unlike replacing a delegation, this leaves revision, cancellation tokens,
    // pending approvals and worker ownership intact. A failed save changes none.
    save(&next)?;
    runtime.status = next;
    Ok(())
}

#[tauri::command]
pub fn autonomy_update_cadence(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, AutonomyState>,
    expected_contract: Contract,
    interval_minutes: u64,
    max_runs_per_day: usize,
) -> Result<(), String> {
    super::main_window(&window)?;
    let mut runtime = super::lock(&state)?;
    let dir = super::storage_dir(&runtime)?;
    update(
        &mut runtime,
        &expected_contract,
        interval_minutes,
        max_runs_per_day,
        super::clock_ms(),
        |status| super::persist_at(&dir, status),
    )?;
    drop(runtime);
    let _ = window.emit("autonomy:status-changed", ());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::autonomy::{actions, DailyWork, PendingWork, Run, WorkMode, DAY_MS};
    use serde_json::json;
    use tokio_util::sync::CancellationToken;

    fn fixture(now: u64) -> (tempfile::TempDir, Runtime) {
        let dir = tempfile::tempdir().unwrap();
        let runtime = Runtime {
            loaded: true,
            storage_root: Some(dir.path().join("state")),
            status: Status {
                contract: Some(Contract {
                    goal: "Summarize the notes".into(),
                    root: dir
                        .path()
                        .canonicalize()
                        .unwrap()
                        .to_string_lossy()
                        .into_owned(),
                    allowed_operations: vec!["write".into()],
                    interval_minutes: 30,
                    max_runs_per_day: 4,
                    enabled: true,
                    review_mode: ReviewMode::Automatic,
                    work_mode: WorkMode::Documents,
                    publish_pull_request: false,
                    automatic_action_approval: true,
                    development_repository: None,
                }),
                next_run_at: Some(now),
                ..Status::default()
            },
            ..Runtime::default()
        };
        (dir, runtime)
    }

    fn run(at: u64) -> Run {
        serde_json::from_value(json!({
            "id": uuid::Uuid::new_v4().to_string(), "startedAt": at,
            "finishedAt": at, "status": "completed", "summary": "Done",
            "reason": "", "changedPaths": [], "canUndo": false
        }))
        .unwrap()
    }

    #[test]
    fn cadence_update_preserves_authority_and_running_claim_until_its_normal_finish() {
        let now = crate::autonomy::clock_ms();
        let (_dir, mut runtime) = fixture(now);
        let (expected, id, revision, cancel, _) =
            crate::autonomy::claim_due(&mut runtime, false, now, |_| Ok(()))
                .unwrap()
                .unwrap();
        let before = runtime.status.clone();
        let fingerprint = actions::scope_fingerprint(&expected).unwrap();
        let store = runtime.storage_root.clone().unwrap();
        update(&mut runtime, &expected, 60, 8, now + 1, |status| {
            crate::autonomy::persist_at(&store, status)
        })
        .unwrap();
        assert!(crate::autonomy::authorized_result(
            &runtime, &id, revision, &cancel
        ));
        assert_eq!(runtime.status.phase, before.phase);
        assert_eq!(runtime.status.error, before.error);
        assert_eq!(runtime.status.next_run_at, Some(now + 60 * 60_000));
        let mut expected = expected;
        expected.interval_minutes = 60;
        expected.max_runs_per_day = 8;
        assert_eq!(runtime.status.contract.as_ref(), Some(&expected));
        assert_eq!(actions::scope_fingerprint(&expected).unwrap(), fingerprint);
        let saved: Status =
            serde_json::from_slice(&std::fs::read(store.join("state.json")).unwrap()).unwrap();
        assert_eq!(saved.contract, runtime.status.contract);

        let state = AutonomyState(std::sync::Arc::new(std::sync::Mutex::new(runtime)));
        crate::autonomy::finish(
            &state,
            &id,
            revision,
            &cancel,
            Ok(crate::autonomy::Plan {
                outcome: crate::autonomy::Outcome::Continue,
                summary: "One step complete".into(),
                reason: "More remains".into(),
                work_goal: String::new(),
                operations: vec![],
                requested_action: None,
            }),
        );
        let current = crate::autonomy::lock(&state).unwrap();
        assert_eq!(current.status.phase, "idle");
        assert_eq!(current.status.next_run_at, Some(now + 60 * 60_000));
        assert_eq!(current.status.contract.as_ref(), Some(&expected));
    }

    #[test]
    fn cadence_update_rejects_stale_contracts_and_invalid_values_without_side_effects() {
        let (_dir, mut runtime) = fixture(DAY_MS * 2);
        let expected = runtime.status.contract.clone().unwrap();
        let before = serde_json::to_value(&runtime.status).unwrap();
        for (minutes, limit) in [
            (4, 4),
            (1441, 4),
            (30, 0),
            (30, super::super::MAX_RUNS_PER_DAY + 1),
        ] {
            assert!(update(
                &mut runtime,
                &expected,
                minutes,
                limit,
                DAY_MS * 2,
                |_| panic!("invalid save")
            )
            .is_err());
        }
        for field in [
            "goal",
            "root",
            "allowedOperations",
            "enabled",
            "intervalMinutes",
            "maxRunsPerDay",
            "automaticActionApproval",
            "reviewMode",
            "workMode",
            "developmentRepository",
        ] {
            let mut stale = serde_json::to_value(&expected).unwrap();
            stale[field] = match field {
                "allowedOperations" => json!([]),
                "enabled" | "automaticActionApproval" => json!(false),
                "intervalMinutes" | "maxRunsPerDay" => json!(10),
                "reviewMode" => json!("daily"),
                "workMode" => json!("auto"),
                "developmentRepository" => {
                    json!({"remoteUrl": "https://example.invalid/a", "githubRepo": "owner/repo", "baseBranch": "main"})
                }
                _ => json!("different"),
            };
            let stale: Contract = serde_json::from_value(stale).unwrap();
            assert!(
                update(&mut runtime, &stale, 60, 8, DAY_MS * 2, |_| panic!(
                    "stale save"
                ))
                .is_err(),
                "{field}"
            );
            assert_eq!(serde_json::to_value(&runtime.status).unwrap(), before);
        }
        let cancel = CancellationToken::new();
        runtime.cancel = Some(cancel.clone());
        assert!(update(&mut runtime, &expected, 60, 8, DAY_MS * 2, |_| Err(
            "disk full".into()
        ))
        .is_err());
        assert!(!cancel.is_cancelled());
        assert_eq!(serde_json::to_value(&runtime.status).unwrap(), before);
    }

    #[test]
    fn cadence_budget_changes_recalculate_the_real_next_opportunity() {
        let now = DAY_MS * 2;
        let (_dir, mut runtime) = fixture(now);
        runtime.status.runs = vec![run(now - 20 * 60_000), run(now - 10 * 60_000)];
        let expected = runtime.status.contract.clone().unwrap();
        update(&mut runtime, &expected, 5, 1, now, |_| Ok(())).unwrap();
        assert_eq!(runtime.status.next_run_at, Some(now - 10 * 60_000 + DAY_MS));
        let expected = runtime.status.contract.clone().unwrap();
        update(&mut runtime, &expected, 60, 8, now, |_| Ok(())).unwrap();
        assert_eq!(runtime.status.next_run_at, Some(now + 50 * 60_000));
        let expected = runtime.status.contract.clone().unwrap();
        update(&mut runtime, &expected, 5, 8, now, |_| Ok(())).unwrap();
        assert_eq!(runtime.status.next_run_at, Some(now));
    }

    #[test]
    fn cadence_never_resumes_paused_finished_blocked_or_pending_work() {
        let now = DAY_MS * 2;
        for phase in [
            "paused",
            "completed",
            "blocked",
            "awaitingReview",
            "awaitingAction",
        ] {
            let (_dir, mut runtime) = fixture(now);
            runtime.status.phase = phase.into();
            runtime.status.next_run_at = None;
            if ["paused", "completed"].contains(&phase) {
                runtime.status.contract.as_mut().unwrap().enabled = false;
            }
            if phase == "awaitingReview" {
                runtime.status.pending_work = Some(PendingWork {
                    id: "proposal".into(),
                    goal: "Today's notes".into(),
                    reason: "Review".into(),
                    summary: "Proposal".into(),
                    changed_paths: vec![],
                    day: crate::autonomy::local_day(now),
                });
            }
            if phase == "awaitingAction" {
                runtime.status.pending_actions.push(
                    serde_json::from_value(json!({
                        "id": "action", "runId": "run", "kind": "operation", "status": "pending",
                        "createdAt": now, "summary": "Needs approval", "payloadDigest": "unchanged"
                    }))
                    .unwrap(),
                );
            }
            let before = runtime.status.clone();
            let expected = runtime.status.contract.clone().unwrap();
            update(&mut runtime, &expected, 60, 8, now, |_| Ok(())).unwrap();
            assert_eq!(runtime.status.phase, before.phase);
            assert!(runtime.status.next_run_at.is_none());
            assert_eq!(
                runtime.status.contract.as_ref().unwrap().enabled,
                expected.enabled
            );
            assert_eq!(
                serde_json::to_value(&runtime.status.pending_work).unwrap(),
                serde_json::to_value(&before.pending_work).unwrap()
            );
            assert_eq!(
                serde_json::to_value(&runtime.status.pending_actions).unwrap(),
                serde_json::to_value(&before.pending_actions).unwrap()
            );
        }
    }

    #[test]
    fn daily_completion_retains_tomorrows_review_and_rolling_budget() {
        let now = DAY_MS * 2;
        let (_dir, mut runtime) = fixture(now);
        runtime.status.contract.as_mut().unwrap().review_mode = ReviewMode::Daily;
        runtime.status.phase = "completed".into();
        runtime.status.daily_work = Some(DailyWork {
            day: crate::autonomy::local_day(now),
            goal: "Today's work".into(),
            complete: true,
        });
        runtime.status.runs = vec![run(now - 1)];
        let expected = runtime.status.contract.clone().unwrap();
        update(&mut runtime, &expected, 5, 1, now, |_| Ok(())).unwrap();
        assert_eq!(
            runtime.status.next_run_at,
            Some(crate::autonomy::next_day(now).max(now - 1 + DAY_MS))
        );
        assert_eq!(runtime.status.phase, "completed");
        assert!(runtime.status.daily_work.as_ref().unwrap().complete);
        assert_eq!(
            runtime.status.contract.as_ref().unwrap().review_mode,
            ReviewMode::Daily
        );
    }

    #[test]
    fn claimed_and_legacy_schedules_report_the_cap_before_another_timer_tick() {
        let now = crate::autonomy::clock_ms();
        let (_dir, mut runtime) = fixture(now);
        runtime.status.contract.as_mut().unwrap().max_runs_per_day = 1;
        crate::autonomy::claim_due(&mut runtime, false, now, |_| Ok(()))
            .unwrap()
            .unwrap();
        assert_eq!(runtime.status.next_run_at, Some(now + DAY_MS));
        runtime.status.next_run_at = Some(now + 30 * 60_000);
        assert_eq!(scheduled_at(&runtime.status, now), Some(now + DAY_MS));
        assert_eq!(
            crate::autonomy::work_status_context(&runtime)["nextRunAt"],
            now + DAY_MS
        );
    }
}
