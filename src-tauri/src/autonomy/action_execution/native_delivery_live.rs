//! Explicit, opt-in delivery of a reviewed local commit through the same claim,
//! approval, native authentication, read-only completion assessment and durable
//! result-persistence path used by Auto.
//! This test never reads or changes the user's live Auto state.
use super::*;
use crate::autonomy::{actions, artifact, github_delivery, Runtime};
use git2::{Oid, Repository, StatusOptions};
use serde::Deserialize;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LiveDelivery {
    source_root: PathBuf,
    storage_root: PathBuf,
    head_commit: String,
    base_commit: String,
    delivery: github_delivery::Delivery,
    checks: Vec<crate::autonomy::development::ExecutedCheck>,
}

fn write_json(path: &Path, value: &serde_json::Value) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}

/// The configuration names the exact reviewed HEAD, destination branch and PR
/// content. It must be created for this verification, outside the live app's
/// state. Running this test publishes that real change and makes one authenticated
/// read-only completion assessment with the configured reasoning provider.
#[tokio::test]
#[ignore = "publishes the explicitly configured real GitHub PR and runs Auto's authenticated read-only completion assessment"]
async fn live_auto_delivery_claim_execute_and_persist() {
    assert_eq!(
        std::env::var("YORISHIRO_LIVE_NATIVE_DELIVERY").as_deref(),
        Ok("1")
    );
    let config_path = PathBuf::from(
        std::env::var_os("YORISHIRO_LIVE_NATIVE_DELIVERY_CONFIG")
            .expect("explicit live delivery config path"),
    );
    let bytes = fs::read(&config_path).unwrap();
    assert!(bytes.len() <= 64 * 1024);
    let config: LiveDelivery = serde_json::from_slice(&bytes).unwrap();
    let source = config.source_root.canonicalize().unwrap();
    assert_eq!(source, config.source_root, "use a canonical source path");
    assert!(config.storage_root.is_absolute());
    assert!(!config.storage_root.starts_with(&source));
    assert!(
        !config
            .storage_root
            .starts_with(crate::home_dir_or_err().unwrap().join(".yorishiro")),
        "never use the live app state"
    );
    assert!(config.checks.iter().all(|check| check.exit_code == 0));
    assert!(
        !config.checks.is_empty(),
        "record the completed validation commands"
    );
    let target = format!("{} https://api.github.com", config.delivery.remote_url);
    config.delivery.validate(&target, true).unwrap();
    let repository = Repository::open(&source).unwrap();
    assert_eq!(
        repository.workdir().unwrap().canonicalize().unwrap(),
        source
    );
    let mut options = StatusOptions::new();
    options.include_untracked(false).include_ignored(false);
    assert!(
        repository.statuses(Some(&mut options)).unwrap().is_empty(),
        "commit all reviewed changes before this verification"
    );
    let head_ref = repository.head().unwrap();
    assert!(head_ref.is_branch(), "review a named local source branch");
    let head = head_ref.peel_to_commit().unwrap();
    assert_eq!(head.id().to_string(), config.head_commit);
    let base = Oid::from_str(&config.base_commit).unwrap();
    assert!(repository.graph_descendant_of(head.id(), base).unwrap());
    let base_tree = repository.find_commit(base).unwrap().tree().unwrap();
    let tree = head.tree().unwrap();
    let changes = repository
        .diff_tree_to_tree(Some(&base_tree), Some(&tree), None)
        .unwrap();
    let mut changed_paths: Vec<String> = changes
        .deltas()
        .map(|delta| {
            delta
                .new_file()
                .path()
                .or_else(|| delta.old_file().path())
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    changed_paths.sort();
    changed_paths.dedup();
    assert!(!changed_paths.is_empty());
    let origin = repository
        .find_remote("origin")
        .unwrap()
        .url()
        .unwrap()
        .to_owned();
    let verified_tree = tree.id().to_string();
    drop(changes);
    drop(tree);
    drop(base_tree);
    drop(head);
    drop(head_ref);
    drop(repository);

    // A fresh isolated test store prevents retries of a possibly completed
    // operation. If interrupted, inspect this store and the remote; do not rerun.
    fs::create_dir(&config.storage_root).expect("fresh, previously unused verification store");
    let storage = config.storage_root.canonicalize().unwrap();
    let run_id = uuid::Uuid::new_v4().to_string();
    let job = storage.join("development").join(&run_id);
    fs::create_dir_all(&job).unwrap();
    let diagnostic = job.join("repository");
    Repository::clone(source.to_str().unwrap(), &diagnostic).unwrap();
    let artifact = artifact::export_verified_tree(&diagnostic, &job, &verified_tree).unwrap();
    write_json(
        &job.join("source.json"),
        &json!({
            "root": source, "baseCommit": config.base_commit, "baseBranch": config.delivery.base_branch,
            "branch": config.delivery.branch, "originUrl": origin,
        }),
    );
    write_json(
        &job.join("result.json"),
        &json!({
            "worktreePath": artifact, "baseCommit": config.base_commit, "baseBranch": config.delivery.base_branch,
            "branch": config.delivery.branch, "verifiedTree": verified_tree,
            "changedPaths": changed_paths, "checks": config.checks,
        }),
    );
    let contract: Contract = serde_json::from_value(json!({
        "goal": "Publish the explicitly reviewed authentication and native delivery fix as a pull request",
        "root": source, "allowedOperations": ["write", "move", "trash"], "intervalMinutes": 30,
        "maxRunsPerDay": 4, "enabled": true, "workMode": "auto", "reviewMode": "automatic",
        "automaticActionApproval": false,
    })).unwrap();
    let run: Run = serde_json::from_value(json!({
        "id": run_id, "startedAt": 1, "finishedAt": 2, "status": "completed",
        "summary": "Prepared and validated exact local commit for native delivery verification",
        "reason": "Explicit live verification", "changedPaths": changed_paths, "canUndo": false,
        "sourceRoot": source, "developmentPath": artifact, "branch": config.delivery.branch,
    }))
    .unwrap();
    let mut runtime = Runtime {
        loaded: true,
        storage_root: Some(storage.clone()),
        status: Status {
            contract: Some(contract),
            runs: vec![run],
            ..Default::default()
        },
        ..Default::default()
    };
    let request = actions::RequestedAction {
        operation: "Commit the verified tree, push it and create the exact reviewed GitHub pull request".into(),
        target,
        impact: "Publish the reviewed change and PR content to the named repository; no merge or deployment".into(),
        details: format!("repository={}\nremoteUrl={}\nbranch={}\nbaseBranch={}\ntitle={}\nbody={}\nverifiedTree={}", config.delivery.repository, config.delivery.remote_url, config.delivery.branch, config.delivery.base_branch, config.delivery.title, config.delivery.body, verified_tree),
        reason: "Explicit end-to-end verification of native Auto delivery for this reviewed fix".into(),
        network_access: true,
        delivery: Some(config.delivery.clone()),
    };
    let action = actions::queue(&mut runtime, &run_id, &request, config.checks).unwrap();
    actions::approve_for_live_test(&mut runtime, &action.id, &action.payload_digest, |status| {
        crate::autonomy::persist_at(&storage, status)
    })
    .unwrap();
    let state = AutonomyState(Arc::new(Mutex::new(runtime)));
    let claim = claim(
        &mut crate::autonomy::lock(&state).unwrap(),
        false,
        |status| crate::autonomy::persist_at(&storage, status),
    )
    .unwrap()
    .unwrap();
    let result = execute(&state, &claim).await;
    let expected_url = result
        .as_ref()
        .ok()
        .and_then(|result| result.result_url.clone());
    let failure = result.as_ref().err().cloned();
    finish(
        &state,
        DeferredFinish {
            id: claim.action.id.clone(),
            revision: claim.revision,
            cancel: claim.cancel,
            result,
        },
    );
    if let Some(error) = failure {
        panic!(
            "Live delivery failed; inspect {} before any retry: {error}",
            storage.display()
        );
    }
    let saved: Status =
        serde_json::from_slice(&fs::read(storage.join("state.json")).unwrap()).unwrap();
    let finished = saved
        .pending_actions
        .iter()
        .find(|entry| entry.id == action.id)
        .unwrap();
    assert_eq!(finished.status, ActionStatus::Completed);
    assert_eq!(finished.result_url, expected_url);
    assert_eq!(
        saved
            .runs
            .iter()
            .find(|run| run.id == run_id)
            .unwrap()
            .pull_request_url,
        expected_url
    );
    let published = Repository::open(
        storage
            .join("action-executions")
            .join(&action.id)
            .join("native-repository"),
    )
    .unwrap();
    let commit = published.head().unwrap().peel_to_commit().unwrap();
    assert_eq!(commit.tree_id().to_string(), verified_tree);
    let published_commit = commit.id().to_string();
    drop(commit);
    drop(published);
    let receipt_path = storage.join("verification-receipt.json");
    let mut receipt = json!({
        "actionId": action.id, "runId": run_id, "sourceHead": config.head_commit,
        "publishedCommit": published_commit, "verifiedTree": verified_tree, "resultUrl": expected_url,
        "actionStatus": finished.status, "sourceResultRecorded": true, "durableStateVerified": true,
        "completionAssessmentVerified": false,
    });
    // The successful publication is durable before the optional model judgment.
    // A judgment failure must never erase this receipt or rerun the publication.
    write_json(&receipt_path, &receipt);
    println!(
        "Native Auto publication verified: {}",
        expected_url.as_deref().unwrap()
    );
    assert!(crate::autonomy::action_continuation::start(&state, false, None)
        .unwrap_or_else(|error| panic!("PR already published; completion assessment could not start. Do not rerun delivery. Receipt: {}. {error}", receipt_path.display())));
    let settled = tokio::time::timeout(Duration::from_secs(180), async {
        loop {
            let complete = {
                let runtime = crate::autonomy::lock(&state).unwrap();
                let pending = runtime
                    .status
                    .pending_actions
                    .iter()
                    .find(|entry| entry.id == action.id)
                    .unwrap()
                    .continuation_pending;
                runtime.active_run_id.is_none()
                    && !runtime.cleanup_pending
                    && (!pending
                        || runtime.status.error.is_some()
                        || matches!(runtime.status.phase.as_str(), "blocked" | "failed"))
            };
            if complete {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    if settled.is_err() {
        if let Some(cancel) = crate::autonomy::lock(&state).unwrap().cancel.clone() {
            cancel.cancel();
        }
        // Cancel only this isolated read-only judgment and allow its process
        // cleanup to finish. Never start or retry any published operation.
        let _ = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let stopped = {
                    let runtime = crate::autonomy::lock(&state).unwrap();
                    runtime.active_run_id.is_none() && !runtime.cleanup_pending
                };
                if stopped {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        })
        .await;
        panic!("PR already published; read-only completion assessment timed out. Do not rerun delivery. Receipt: {}", receipt_path.display());
    }
    // Read the actual durable state again, rather than asserting only the
    // in-memory result of the model's completion decision.
    let completed: Status =
        serde_json::from_slice(&fs::read(storage.join("state.json")).unwrap()).unwrap();
    assert!(completed.error.is_none(), "PR already published; completion assessment failed: {:?}. Do not rerun delivery. Receipt: {}", completed.error, receipt_path.display());
    assert!(!matches!(completed.phase.as_str(), "blocked" | "failed"));
    let completed_action = completed
        .pending_actions
        .iter()
        .find(|entry| entry.id == action.id)
        .unwrap();
    assert_eq!(completed_action.status, ActionStatus::Completed);
    assert_eq!(completed_action.goal_complete, Some(true), "PR already published; goal completion was not confirmed. Do not rerun delivery. Receipt: {}", receipt_path.display());
    assert!(!completed_action.continuation_pending);
    assert_eq!(completed_action.result_url, expected_url);
    assert_eq!(
        completed
            .runs
            .iter()
            .find(|run| run.id == run_id)
            .unwrap()
            .pull_request_url,
        expected_url
    );
    receipt["completionAssessmentVerified"] = json!(true);
    receipt["goalComplete"] = json!(true);
    receipt["finalPhase"] = json!(completed.phase);
    write_json(&receipt_path, &receipt);
    println!(
        "Native Auto delivery and completion verified: {}",
        expected_url.unwrap()
    );
    println!(
        "Receipt: {}",
        storage.join("verification-receipt.json").display()
    );
}
