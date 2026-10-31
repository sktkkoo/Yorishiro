//! Conversation-owned setup proposals, never execution authority.
//!
//! A native conversation agent may propose a delegation after talking with the
//! user. It can only replace this process-local draft. The existing main-window
//! save command remains the sole route to an active contract. Existing daily
//! review scopes retain their separate work approval.

use super::{AutonomyState, Contract, WorkMode};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::{LazyLock, Mutex};
use tauri::Emitter;

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewMode {
    #[default]
    Automatic,
    Daily,
}

/// Proposed result and scope, never a command to start work.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutonomyProposal {
    /// ID of the latest shared draft from autonomy_setup_context. Required when
    /// a draft exists; refresh context and reconcile user edits before retrying.
    #[serde(default)]
    pub base_draft_id: Option<String>,
    /// The requested result agreed in conversation, at most 8000 UTF-8 bytes.
    /// Keep empty if unknown and preserve the user's latest edits exactly.
    pub goal: String,
    /// User-selected folder or their unfinished path input, at most 4096 bytes.
    /// Use empty if unknown; never invent or infer folder permission. Final app
    /// confirmation validates the folder before any authority is granted.
    #[serde(default)]
    pub root: String,
    /// Only write, move and trash are supported. Empty means read-only. These
    /// scope local changes. All three are required for isolated repository work;
    /// a narrower grant permits only the corresponding document operations.
    /// External sending is never authorized by these operations.
    pub allowed_operations: Vec<String>,
    /// Interval between work opportunities, 5–1440 minutes. Preserve the latest
    /// chosen value unless the user explicitly requests a change; default to 30.
    pub interval_minutes: u64,
    /// Rolling 24-hour budget. Preserve the latest chosen value unless the user
    /// explicitly requests a change; default to 4. Positive JavaScript-safe integer.
    #[schemars(range(min = 1, max = "super::MAX_RUNS_PER_DAY"))]
    pub max_runs_per_day: usize,
    /// automatic: pursue the requested result within the confirmed scope.
    /// daily: compatibility for existing daily work review. Preserve an existing
    /// choice; a new draft defaults to automatic without granting any authority.
    #[serde(default)]
    pub review_mode: ReviewMode,
    /// Optional change to the user's purpose-based automatic operation choice.
    /// This only edits the inactive draft; the user must save it in the app.
    #[serde(default)]
    pub automatic_action_approval: Option<bool>,
    /// Short user-facing explanation of the scope and remaining choices,
    /// 1–4000 UTF-8 bytes. Do not claim the draft is active or approved.
    pub explanation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub id: String,
    pub goal: String,
    /// Host-owned routing; old restricted drafts retain their scope until save.
    #[serde(default = "auto_work_mode")]
    pub work_mode: WorkMode,
    /// Legacy Git-specific field; purpose-based permission is separate.
    #[serde(default)]
    pub publish_pull_request: bool,
    #[serde(default)]
    pub automatic_action_approval: bool,
    pub root: String,
    pub allowed_operations: Vec<String>,
    pub interval_minutes: u64,
    pub max_runs_per_day: usize,
    pub review_mode: ReviewMode,
    pub explanation: String,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DraftSnapshot {
    pub revision: u64,
    pub draft: Option<Draft>,
}

/// An incomplete request is a draft, not permission to perform any work.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftPatch {
    pub goal: Option<String>,
    pub work_mode: Option<WorkMode>,
    pub publish_pull_request: Option<bool>,
    pub automatic_action_approval: Option<bool>,
    pub root: Option<String>,
    pub allowed_operations: Option<Vec<String>>,
    pub interval_minutes: Option<u64>,
    pub max_runs_per_day: Option<usize>,
    pub review_mode: Option<ReviewMode>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftEditResult {
    pub snapshot: DraftSnapshot,
    pub conflict: bool,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutonomySetupContextRequest {}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalReceipt {
    pub draft_id: String,
    pub status: &'static str,
    pub applied: bool,
    pub requires_review: bool,
    pub message: &'static str,
    pub snapshot: DraftSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupContext {
    pub current_contract: Option<Contract>,
    pub draft: Option<Draft>,
    pub draft_revision: u64,
    pub work_status: serde_json::Value,
    pub guidance: &'static str,
}

const GUIDANCE: &str = "Discuss the result the user wants and its target. Offer a concrete, brief interpretation and ask at most one question about missing information that changes the result or scope. Do not turn setup into a questionnaire about intervals, run budgets, individual operation checkboxes, daily review, automatic approval, or document/development modes. Preserve the latest interval and run budget unless the user explicitly requests a different cadence; users can also change frequency in the app. Keep all other settings from the latest draft or saved contract; only for a new request use intervalMinutes=30, maxRunsPerDay=4, reviewMode=automatic, allowedOperations=[], and automaticActionApproval=false until the user explicitly delegates a reviewed local-edit scope in the app. Describe the proposed result and exact folder clearly before that decision. A request to edit files can inform an inactive proposal, but neither conversation nor the model's proposal grants permission. If the folder is unknown, leave root empty and let the user select it in the app. The host routes an exact Git repository root with all write/move/trash permissions through an isolated copy; narrower grants and other folders retain their supported reversible document operations. Never expand a selected subfolder to its parent repository or silently upgrade a saved document-only scope. Use autonomy_propose as the request becomes clear. Refresh autonomy_setup_context before each update, preserve the user's latest changes and incomplete input, and pass the latest draft id as baseDraftId. If an update conflicts, reread and reconcile rather than blindly retrying. Existing saved scopes, daily review choices, budgets and permissions stay unchanged until the user explicitly replaces them. Preserve automaticActionApproval unless the user explicitly changes that existing choice; omit the optional field otherwise. New requests do not automatically authorize external sending or publication. No MCP tool can activate a contract, approve an operation or execute file changes. The user must explicitly delegate the reviewed scope in the app before work starts. Never invent recipients, content or destinations or expand the requested result. For progress questions, use workStatus: it is a bounded host-recorded snapshot at capturedAt, with the current phase, activeRunId, nextRunAt, recentRuns, pendingActions and pendingWork. nextRunAt is the next scheduled opportunity after budget limits; prioritize active work or pending decisions over that time and do not promise execution from the timestamp alone. Do not claim to have read artifact bodies or know newer progress. Running work, pending approval and a successful intermediate operation are not proof that the whole purpose is complete. Additional directions only update an inactive draft; they do not alter the running worker.";

#[derive(Default)]
struct DraftStore(Mutex<DraftSnapshot>);

impl DraftStore {
    fn propose(&self, proposal: AutonomyProposal) -> Result<ProposalReceipt, String> {
        let result = self.replace(proposal, None)?;
        if result.conflict {
            return Err("Shared draft changed. Refresh autonomy_setup_context, reconcile the user's latest edits, and retry autonomy_propose with its current draft id as baseDraftId. Do not overwrite newer edits.".into());
        }
        Ok(ProposalReceipt {
            draft_id: result.snapshot.draft.as_ref().expect("successful replace has a draft").id.clone(),
            status: "proposal-only",
            applied: false,
            requires_review: true,
            message: "Request prepared. Review the result and target in Yorishiro, then explicitly delegate it in the app. This proposal did not change permissions or start work.",
            snapshot: result.snapshot,
        })
    }

    fn replace(
        &self,
        proposal: AutonomyProposal,
        expected_revision: Option<u64>,
    ) -> Result<DraftEditResult, String> {
        let base_id = proposal.base_draft_id.clone();
        let automatic_action_approval = proposal.automatic_action_approval;
        let mut draft = validate(proposal)?;
        let mut state = self.0.lock().map_err(|_| "設定案を保存できません")?;
        if state.draft.as_ref().map(|draft| &draft.id) != base_id.as_ref()
            || expected_revision.is_some_and(|revision| revision != state.revision)
        {
            return Ok(DraftEditResult {
                snapshot: state.clone(),
                conflict: true,
            });
        }
        if let Some(existing) = &state.draft {
            draft.work_mode = existing.work_mode;
            if automatic_action_approval.is_none() {
                draft.automatic_action_approval = existing.automatic_action_approval;
            }
        }
        let revision = next_revision(&state)?;
        *state = DraftSnapshot {
            revision,
            draft: Some(draft),
        };
        Ok(DraftEditResult {
            snapshot: state.clone(),
            conflict: false,
        })
    }

    fn get(&self) -> Result<Option<Draft>, String> {
        Ok(self.snapshot()?.draft)
    }

    fn snapshot(&self) -> Result<DraftSnapshot, String> {
        self.0
            .lock()
            .map(|draft| draft.clone())
            .map_err(|_| "設定案を取得できません".into())
    }

    fn with_reviewed_contract(
        &self,
        id: &str,
        contract: &Contract,
        save: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let state = self.0.lock().map_err(|_| "依頼案を確認できません")?;
        let draft = state
            .draft
            .as_ref()
            .filter(|draft| draft.id == id)
            .ok_or("確認中に依頼案が変わりました。最新の内容を確認してください")?;
        let review_mode = match draft.review_mode {
            ReviewMode::Automatic => super::ReviewMode::Automatic,
            ReviewMode::Daily => super::ReviewMode::Daily,
        };
        if contract.goal != draft.goal
            || contract.root != draft.root
            || contract.allowed_operations != draft.allowed_operations
            || contract.interval_minutes != draft.interval_minutes
            || contract.max_runs_per_day != draft.max_runs_per_day
            || contract.review_mode != review_mode
            || contract.work_mode != draft.work_mode
            || contract.publish_pull_request != draft.publish_pull_request
            || contract.automatic_action_approval != draft.automatic_action_approval
            || contract.development_repository.is_some()
        {
            return Err(
                "確認した依頼案と開始する内容が一致しません。最新の内容を確認してください".into(),
            );
        }
        // Keep the draft lock through durable save. A newer proposal cannot
        // replace the reviewed request between validation and activation.
        let result = save();
        drop(state);
        result
    }

    fn dismiss(&self, id: &str) -> Result<Option<DraftSnapshot>, String> {
        let mut state = self.0.lock().map_err(|_| "設定案を更新できません")?;
        if state.draft.as_ref().is_some_and(|draft| draft.id == id) {
            state.revision = next_revision(&state)?;
            state.draft = None;
            return Ok(Some(state.clone()));
        }
        Ok(None)
    }

    fn edit(&self, base_id: Option<&str>, patch: DraftPatch) -> Result<DraftEditResult, String> {
        let mut state = self.0.lock().map_err(|_| "設定案を更新できません")?;
        if state.draft.as_ref().map(|draft| draft.id.as_str()) != base_id {
            return Ok(DraftEditResult {
                snapshot: state.clone(),
                conflict: true,
            });
        }
        let mut draft = state.draft.clone().unwrap_or_else(|| Draft {
            id: String::new(),
            goal: String::new(),
            work_mode: WorkMode::Auto,
            publish_pull_request: false,
            automatic_action_approval: false,
            root: String::new(),
            allowed_operations: Vec::new(),
            interval_minutes: 30,
            max_runs_per_day: 4,
            review_mode: ReviewMode::Automatic,
            explanation: String::new(),
        });
        if let Some(mode) = patch.work_mode {
            draft.work_mode = mode;
        }
        if let Some(publish) = patch.publish_pull_request {
            draft.publish_pull_request = publish;
        }
        if let Some(automatic) = patch.automatic_action_approval {
            draft.automatic_action_approval = automatic;
        }
        if let Some(goal) = patch.goal {
            draft.goal = goal;
        }
        if let Some(root) = patch.root {
            draft.root = root;
        }
        if let Some(operations) = patch.allowed_operations {
            draft.allowed_operations = operations;
        }
        if let Some(interval) = patch.interval_minutes {
            draft.interval_minutes = interval;
        }
        if let Some(limit) = patch.max_runs_per_day {
            draft.max_runs_per_day = limit;
        }
        if let Some(mode) = patch.review_mode {
            draft.review_mode = mode;
        }
        validate_bounds(&draft)?;
        draft.id = uuid::Uuid::new_v4().to_string();
        state.revision = next_revision(&state)?;
        state.draft = Some(draft);
        Ok(DraftEditResult {
            snapshot: state.clone(),
            conflict: false,
        })
    }
}

fn next_revision(snapshot: &DraftSnapshot) -> Result<u64, String> {
    snapshot
        .revision
        .checked_add(1)
        .ok_or_else(|| "設定案の更新回数の上限に達しました".into())
}

static DRAFT: LazyLock<DraftStore> = LazyLock::new(DraftStore::default);

/// Caller holds the runtime lock first, matching propose/consultation ordering.
pub(super) fn with_reviewed_contract(
    id: &str,
    contract: &Contract,
    save: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    DRAFT.with_reviewed_contract(id, contract, save)
}

fn auto_work_mode() -> WorkMode {
    WorkMode::Auto
}

fn validate(mut proposal: AutonomyProposal) -> Result<Draft, String> {
    proposal.explanation = proposal.explanation.trim().to_owned();
    if proposal.explanation.is_empty() || proposal.explanation.len() > 4_000 {
        return Err("設定案の説明は1〜4000バイトで入力してください".into());
    }
    let draft = Draft {
        id: uuid::Uuid::new_v4().to_string(),
        goal: proposal.goal,
        work_mode: WorkMode::Auto,
        publish_pull_request: false,
        automatic_action_approval: proposal.automatic_action_approval.unwrap_or(false),
        root: proposal.root,
        allowed_operations: proposal.allowed_operations,
        interval_minutes: proposal.interval_minutes,
        max_runs_per_day: proposal.max_runs_per_day,
        review_mode: proposal.review_mode,
        explanation: proposal.explanation,
    };
    validate_bounds(&draft)?;
    Ok(draft)
}

fn validate_bounds(draft: &Draft) -> Result<(), String> {
    if draft.publish_pull_request {
        return Err(
            "外部への公開は成果物を確認してから個別に承認してください。設定案では許可できません"
                .into(),
        );
    }
    if draft.goal.len() > 8_000 {
        return Err("目的は8000バイト以内で入力してください".into());
    }
    if draft.root.len() > 4096 || draft.root.chars().any(char::is_control) {
        return Err("対象フォルダの指定が不正です".into());
    }
    if draft.allowed_operations.len() > 3
        || draft
            .allowed_operations
            .iter()
            .any(|op| !["write", "move", "trash"].contains(&op.as_str()))
        || draft
            .allowed_operations
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != draft.allowed_operations.len()
    {
        return Err("設定案で指定できる操作は write・move・trash です。外部送信やコマンド実行は指定できません".into());
    }
    if !(5..=1440).contains(&draft.interval_minutes) {
        return Err("実行間隔は5〜1440分です".into());
    }
    super::validate_run_budget(draft.max_runs_per_day)
}

fn preserve_saved_permission(proposal: &mut AutonomyProposal, contract: Option<&Contract>) {
    // With no process-local draft, the saved scope is the setup baseline.
    // Omission preserves that choice; it must not silently become a revocation.
    // An existing shared draft and an explicit conversational change take priority.
    if proposal.base_draft_id.is_none() && proposal.automatic_action_approval.is_none() {
        proposal.automatic_action_approval = contract.map(|scope| scope.automatic_action_approval);
    }
}

pub fn propose(
    state: &AutonomyState,
    mut proposal: AutonomyProposal,
) -> Result<ProposalReceipt, String> {
    let runtime = super::lock(state)?;
    preserve_saved_permission(&mut proposal, runtime.status.contract.as_ref());
    DRAFT.propose(proposal)
}

pub(super) fn publish_consultation(
    base: &DraftSnapshot,
    mut proposal: AutonomyProposal,
    current_contract: Option<&Contract>,
) -> Result<DraftEditResult, String> {
    proposal.base_draft_id = base.draft.as_ref().map(|draft| draft.id.clone());
    preserve_saved_permission(&mut proposal, current_contract);
    DRAFT.replace(proposal, Some(base.revision))
}

pub fn setup_context(state: &AutonomyState) -> Result<SetupContext, String> {
    // Read saved scope and bounded host-owned progress under one runtime lock.
    // No artifact bodies, action bodies, filesystem reads or credentials.
    let runtime = super::lock(state)?;
    let current_contract = runtime.status.contract.clone();
    let work_status = super::work_status_context(&runtime);
    let snapshot = DRAFT.snapshot()?;
    Ok(SetupContext {
        current_contract,
        draft: snapshot.draft,
        draft_revision: snapshot.revision,
        work_status,
        guidance: GUIDANCE,
    })
}

#[tauri::command]
pub fn autonomy_draft_get(window: tauri::WebviewWindow) -> Result<Option<Draft>, String> {
    super::main_window(&window)?;
    DRAFT.get()
}

#[tauri::command]
pub fn autonomy_draft_snapshot(window: tauri::WebviewWindow) -> Result<DraftSnapshot, String> {
    super::main_window(&window)?;
    DRAFT.snapshot()
}

#[tauri::command]
pub fn autonomy_draft_edit(
    window: tauri::WebviewWindow,
    base_id: Option<String>,
    patch: DraftPatch,
) -> Result<DraftEditResult, String> {
    super::main_window(&window)?;
    let result = DRAFT.edit(base_id.as_deref(), patch)?;
    if !result.conflict {
        // Delivery may be reordered across concurrent callers. Consumers must
        // only accept increasing revisions; the snapshot command repairs a miss.
        let _ = window.emit("autonomy:draft-changed", &result.snapshot);
    }
    Ok(result)
}

/// Compare the displayed ID so acknowledging an older proposal never discards
/// a newer one that arrived while the user was reviewing it.
#[tauri::command]
pub fn autonomy_draft_dismiss(window: tauri::WebviewWindow, id: String) -> Result<bool, String> {
    super::main_window(&window)?;
    let snapshot = DRAFT.dismiss(&id)?;
    if let Some(snapshot) = &snapshot {
        let _ = window.emit("autonomy:draft-changed", snapshot);
    }
    Ok(snapshot.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn proposal() -> AutonomyProposal {
        AutonomyProposal {
            base_draft_id: None,
            goal: "下書きを整理し、読みやすくする".into(),
            root: String::new(),
            allowed_operations: vec!["write".into()],
            interval_minutes: 30,
            max_runs_per_day: 4,
            review_mode: ReviewMode::Daily,
            automatic_action_approval: None,
            explanation: "既存の文書を対象に、毎日の相談で決めた仕事を進めます。".into(),
        }
    }

    #[test]
    fn large_run_budgets_round_trip_through_proposals_and_manual_edits() {
        for maximum in [49, 100, 1_000, super::super::MAX_RUNS_PER_DAY] {
            let store = DraftStore::default();
            let mut proposed = proposal();
            proposed.max_runs_per_day = maximum;
            store.propose(proposed).unwrap();
            assert_eq!(store.get().unwrap().unwrap().max_runs_per_day, maximum);

            let store = DraftStore::default();
            let result = store
                .edit(
                    None,
                    DraftPatch {
                        max_runs_per_day: Some(maximum),
                        ..DraftPatch::default()
                    },
                )
                .unwrap();
            assert_eq!(result.snapshot.draft.unwrap().max_runs_per_day, maximum);
        }
        let schema = serde_json::to_value(schemars::schema_for!(AutonomyProposal)).unwrap();
        assert_eq!(schema["properties"]["maxRunsPerDay"]["minimum"], 1);
        assert_eq!(
            schema["properties"]["maxRunsPerDay"]["maximum"],
            super::super::MAX_RUNS_PER_DAY
        );
    }

    #[test]
    fn draft_without_folder_is_inactive_and_cannot_carry_execution_authority() {
        let store = DraftStore::default();
        let receipt = store.propose(proposal()).unwrap();
        let draft = store.get().unwrap().unwrap();
        assert_eq!(draft.work_mode, WorkMode::Auto);
        assert!(!draft.publish_pull_request);
        assert!(!draft.automatic_action_approval);
        assert_eq!(draft.goal, "下書きを整理し、読みやすくする");
        assert!(draft.root.is_empty());
        assert!(!receipt.applied);
        assert!(receipt.requires_review);
        assert_eq!(receipt.status, "proposal-only");
        assert_eq!(draft.id, receipt.draft_id);
        let mut encoded = serde_json::to_value(proposal()).unwrap();
        encoded["enabled"] = json!(true);
        assert!(serde_json::from_value::<AutonomyProposal>(encoded).is_err());
        let mut encoded = serde_json::to_value(proposal()).unwrap();
        encoded["dailyApproved"] = json!(true);
        assert!(serde_json::from_value::<AutonomyProposal>(encoded).is_err());
    }

    #[test]
    fn purpose_permission_is_inactive_until_save_and_preserves_manual_choice() {
        let store = DraftStore::default();
        let first = store.propose(proposal()).unwrap();
        let manual = store
            .edit(
                Some(&first.draft_id),
                DraftPatch {
                    automatic_action_approval: Some(true),
                    ..DraftPatch::default()
                },
            )
            .unwrap();
        assert!(
            manual
                .snapshot
                .draft
                .as_ref()
                .unwrap()
                .automatic_action_approval
        );
        let mut unrelated = proposal();
        unrelated.base_draft_id = Some(manual.snapshot.draft.unwrap().id);
        unrelated.interval_minutes = 60;
        let receipt = store.propose(unrelated).unwrap();
        assert!(!receipt.applied);
        assert!(receipt.requires_review);
        assert!(receipt.snapshot.draft.unwrap().automatic_action_approval);
        let mut revoke = proposal();
        revoke.base_draft_id = Some(receipt.draft_id);
        revoke.automatic_action_approval = Some(false);
        assert!(
            !store
                .propose(revoke)
                .unwrap()
                .snapshot
                .draft
                .unwrap()
                .automatic_action_approval
        );
    }

    fn saved_contract(automatic: bool) -> Contract {
        serde_json::from_value(json!({
            "goal": "Improve the selected project",
            "root": "/chosen/project",
            "allowedOperations": ["write", "move", "trash"],
            "intervalMinutes": 30,
            "maxRunsPerDay": 4,
            "enabled": true,
            "reviewMode": "automatic",
            "automaticActionApproval": automatic
        }))
        .unwrap()
    }

    #[test]
    fn first_conversation_draft_preserves_saved_permission_unless_explicitly_changed() {
        for saved in [false, true] {
            for change in [None, Some(false), Some(true)] {
                let store = DraftStore::default();
                let mut proposed = proposal();
                proposed.automatic_action_approval = change;
                preserve_saved_permission(&mut proposed, Some(&saved_contract(saved)));
                let receipt = store.propose(proposed).unwrap();
                assert_eq!(
                    receipt.snapshot.draft.unwrap().automatic_action_approval,
                    change.unwrap_or(saved)
                );
                assert!(!receipt.applied);
                assert!(receipt.requires_review);
            }
        }
    }

    #[test]
    fn existing_draft_choice_overrides_saved_contract_when_proposal_omits_permission() {
        for saved in [false, true] {
            let store = DraftStore::default();
            let mut initial = proposal();
            initial.automatic_action_approval = Some(!saved);
            let first = store.propose(initial).unwrap();
            let mut unrelated = proposal();
            unrelated.base_draft_id = Some(first.draft_id);
            unrelated.interval_minutes = 60;
            preserve_saved_permission(&mut unrelated, Some(&saved_contract(saved)));
            let receipt = store.propose(unrelated).unwrap();
            assert_eq!(
                receipt.snapshot.draft.unwrap().automatic_action_approval,
                !saved
            );
        }
    }

    #[test]
    fn model_cannot_select_execution_mode_or_grant_publication() {
        for (key, value) in [
            ("workMode", json!("development")),
            ("publishPullRequest", json!(true)),
        ] {
            let mut encoded = serde_json::to_value(proposal()).unwrap();
            encoded[key] = value;
            assert!(serde_json::from_value::<AutonomyProposal>(encoded).is_err());
        }
        let store = DraftStore::default();
        let first = store
            .edit(
                None,
                DraftPatch {
                    work_mode: Some(WorkMode::Documents),
                    ..DraftPatch::default()
                },
            )
            .unwrap();
        let id = first.snapshot.draft.unwrap().id;
        let mut candidate = proposal();
        candidate.base_draft_id = Some(id.clone());
        let revised = store.propose(candidate).unwrap();
        assert_eq!(
            revised.snapshot.draft.unwrap().work_mode,
            WorkMode::Documents
        );
        let result = store.edit(
            Some(&revised.draft_id),
            DraftPatch {
                publish_pull_request: Some(true),
                ..DraftPatch::default()
            },
        );
        assert!(result.is_err());
    }

    #[test]
    fn new_proposals_default_to_automatic_and_preserve_explicit_daily_review() {
        let mut encoded = serde_json::to_value(proposal()).unwrap();
        encoded.as_object_mut().unwrap().remove("reviewMode");
        assert_eq!(
            serde_json::from_value::<AutonomyProposal>(encoded.clone())
                .unwrap()
                .review_mode,
            ReviewMode::Automatic
        );
        encoded["reviewMode"] = json!("daily");
        assert_eq!(
            serde_json::from_value::<AutonomyProposal>(encoded.clone())
                .unwrap()
                .review_mode,
            ReviewMode::Daily
        );
        encoded["reviewMode"] = json!("bypass");
        assert!(serde_json::from_value::<AutonomyProposal>(encoded).is_err());
    }

    #[test]
    fn dangerous_operations_and_invalid_bounds_preserve_previous_draft() {
        let store = DraftStore::default();
        store.propose(proposal()).unwrap();
        let before = store.get().unwrap();
        for invalid in ["send_email", "shell", "delete", "Write"] {
            let mut candidate = proposal();
            candidate.allowed_operations = vec![invalid.into()];
            assert!(store.propose(candidate).is_err());
        }
        let mut invalid = proposal();
        invalid.allowed_operations = vec!["write".into(), "write".into()];
        assert!(store.propose(invalid).is_err());
        for interval in [0, 4, 1441, u64::MAX] {
            let mut invalid = proposal();
            invalid.interval_minutes = interval;
            assert!(store.propose(invalid).is_err());
        }
        for budget in [0, super::super::MAX_RUNS_PER_DAY + 1, usize::MAX] {
            let mut invalid = proposal();
            invalid.max_runs_per_day = budget;
            assert!(store.propose(invalid).is_err());
        }
        let mut invalid = proposal();
        invalid.goal = "x".repeat(8_001);
        assert!(store.propose(invalid).is_err());
        let mut invalid = proposal();
        invalid.explanation = "x".repeat(4_001);
        assert!(store.propose(invalid).is_err());
        assert_eq!(store.get().unwrap(), before);
    }

    #[test]
    fn incomplete_proposal_preserves_manual_text_without_writing_any_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let store = DraftStore::default();
        let mut candidate = proposal();
        candidate.root = root.join("missing").to_string_lossy().into_owned();
        candidate.goal = String::new();
        let receipt = store.propose(candidate.clone()).unwrap();
        assert_eq!(store.get().unwrap().unwrap().root, candidate.root);
        assert!(store.get().unwrap().unwrap().goal.is_empty());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        for invalid in ["Documents\n".to_owned(), "x".repeat(4097)] {
            let mut candidate = proposal();
            candidate.base_draft_id = Some(receipt.draft_id.clone());
            candidate.root = invalid;
            assert!(store.propose(candidate).is_err());
        }
        assert!(!root.join("missing").exists());
    }

    #[test]
    fn acknowledging_an_old_proposal_never_discards_a_new_one() {
        let store = DraftStore::default();
        let first = store.propose(proposal()).unwrap();
        let mut update = proposal();
        update.base_draft_id = Some(first.draft_id.clone());
        let second = store.propose(update).unwrap();
        assert_ne!(first.draft_id, second.draft_id);
        assert!(store.dismiss(&first.draft_id).unwrap().is_none());
        assert_eq!(store.get().unwrap().unwrap().id, second.draft_id);
        let dismissed = store.dismiss(&second.draft_id).unwrap().unwrap();
        assert_eq!(dismissed.revision, 3);
        assert!(store.get().unwrap().is_none());
        assert!(store.dismiss(&second.draft_id).unwrap().is_none());
        assert_eq!(store.snapshot().unwrap().revision, 3);
        let third = store.propose(proposal()).unwrap();
        assert_eq!(third.snapshot.revision, 4);
    }

    #[test]
    fn stale_ai_proposals_never_overwrite_manual_edits() {
        let store = DraftStore::default();
        let first = store.propose(proposal()).unwrap();
        let manual = store
            .edit(
                Some(&first.draft_id),
                DraftPatch {
                    goal: Some("User's exact wording  ".into()),
                    ..DraftPatch::default()
                },
            )
            .unwrap();
        assert!(!manual.conflict);
        assert_eq!(manual.snapshot.revision, 2);
        let mut stale = proposal();
        stale.base_draft_id = Some(first.draft_id);
        assert!(store
            .propose(stale)
            .unwrap_err()
            .contains("autonomy_setup_context"));
        assert!(store.propose(proposal()).is_err());
        assert_eq!(store.snapshot().unwrap(), manual.snapshot);
        let mut reconciled = proposal();
        let draft = manual.snapshot.draft.unwrap();
        reconciled.base_draft_id = Some(draft.id);
        reconciled.goal = draft.goal.clone();
        reconciled.interval_minutes = 60;
        let receipt = store.propose(reconciled).unwrap();
        assert_eq!(receipt.snapshot.revision, 3);
        assert_eq!(receipt.snapshot.draft.unwrap().goal, draft.goal);
    }

    #[test]
    fn manual_edits_are_cas_and_preserve_unrelated_fields() {
        let store = DraftStore::default();
        let first = store.propose(proposal()).unwrap();
        let edited = store
            .edit(
                Some(&first.draft_id),
                DraftPatch {
                    root: Some("unfinished relative/".into()),
                    goal: Some(String::new()),
                    ..DraftPatch::default()
                },
            )
            .unwrap();
        let draft = edited.snapshot.draft.as_ref().unwrap();
        assert!(draft.goal.is_empty());
        assert_eq!(draft.root, "unfinished relative/");
        assert_eq!(draft.allowed_operations, ["write"]);
        assert_ne!(draft.id, first.draft_id);
        for stale in [None, Some(first.draft_id.as_str())] {
            let result = store
                .edit(
                    stale,
                    DraftPatch {
                        goal: Some("stale".into()),
                        ..DraftPatch::default()
                    },
                )
                .unwrap();
            assert!(result.conflict);
            assert_eq!(result.snapshot, edited.snapshot);
        }
        assert_eq!(store.snapshot().unwrap(), edited.snapshot);
    }

    #[test]
    fn manual_partial_drafts_reject_authority_and_invalid_bounds() {
        let store = DraftStore::default();
        let initial = store.edit(None, DraftPatch::default()).unwrap();
        let draft = initial.snapshot.draft.as_ref().unwrap();
        assert!(draft.goal.is_empty());
        assert!(draft.root.is_empty());
        assert!(draft.allowed_operations.is_empty());
        assert_eq!(draft.review_mode, ReviewMode::Automatic);
        assert!(!draft.automatic_action_approval);
        for value in [
            json!({"enabled":true}),
            json!({"explanation":"changed"}),
            json!({"reviewMode":"bypass"}),
        ] {
            assert!(serde_json::from_value::<DraftPatch>(value).is_err());
        }
        for patch in [
            json!({"goal":"x".repeat(8001)}),
            json!({"root":"a\nb"}),
            json!({"root":"x".repeat(4097)}),
            json!({"allowedOperations":["send_email"]}),
            json!({"allowedOperations":["write","write"]}),
            json!({"intervalMinutes":4}),
            json!({"maxRunsPerDay":0}),
            json!({"maxRunsPerDay":super::super::MAX_RUNS_PER_DAY + 1}),
        ] {
            assert!(store
                .edit(Some(&draft.id), serde_json::from_value(patch).unwrap())
                .is_err());
            assert_eq!(store.snapshot().unwrap(), initial.snapshot);
        }
    }

    #[test]
    fn concurrent_edits_with_one_base_have_exactly_one_winner() {
        let store = std::sync::Arc::new(DraftStore::default());
        let first = store.propose(proposal()).unwrap();
        let handles: Vec<_> = (0..8)
            .map(|index| {
                let store = store.clone();
                let base = first.draft_id.clone();
                std::thread::spawn(move || {
                    store
                        .edit(
                            Some(&base),
                            DraftPatch {
                                goal: Some(format!("edit {index}")),
                                ..DraftPatch::default()
                            },
                        )
                        .unwrap()
                })
            })
            .collect();
        let results: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().unwrap())
            .collect();
        assert_eq!(results.iter().filter(|result| !result.conflict).count(), 1);
        assert_eq!(store.snapshot().unwrap().revision, 2);
    }

    fn reviewed_contract(draft: &Draft) -> Contract {
        let mut value = serde_json::to_value(draft).unwrap();
        let fields = value.as_object_mut().unwrap();
        fields.remove("id");
        fields.remove("explanation");
        fields.insert("enabled".into(), json!(true));
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn reviewed_activation_holds_the_draft_until_save_and_rejects_changed_payload() {
        let store = DraftStore::default();
        let first = store.propose(proposal()).unwrap();
        let draft = first.snapshot.draft.unwrap();
        let contract = reviewed_contract(&draft);
        let mut saved = false;
        store
            .with_reviewed_contract(&draft.id, &contract, || {
                assert!(store.0.try_lock().is_err());
                saved = true;
                Ok(())
            })
            .unwrap();
        assert!(saved);
        for patch in [
            json!({"goal":"An unseen new goal"}),
            json!({"root":"/another/folder"}),
            json!({"allowedOperations":["write","move","trash"]}),
            json!({"intervalMinutes":60}),
            json!({"maxRunsPerDay":100}),
            json!({"reviewMode":"automatic"}),
            json!({"workMode":"documents"}),
            json!({"automaticActionApproval":true}),
            json!({"publishPullRequest":true}),
        ] {
            let mut value = serde_json::to_value(&contract).unwrap();
            value
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            let changed = serde_json::from_value::<Contract>(value).unwrap();
            assert!(store
                .with_reviewed_contract(&draft.id, &changed, || {
                    panic!("an unreviewed payload must not reach save")
                })
                .is_err());
        }
        assert_eq!(store.get().unwrap(), Some(draft));
    }

    #[test]
    fn reviewed_activation_rejects_a_newer_or_dismissed_draft_without_running_save() {
        let store = DraftStore::default();
        let first = store.propose(proposal()).unwrap();
        let draft = first.snapshot.draft.unwrap();
        let contract = reviewed_contract(&draft);
        let edited = store
            .edit(
                Some(&draft.id),
                DraftPatch {
                    goal: Some("The user's newer request".into()),
                    ..DraftPatch::default()
                },
            )
            .unwrap();
        assert!(store
            .with_reviewed_contract(&draft.id, &contract, || {
                panic!("a stale reviewed draft must not reach save")
            })
            .is_err());
        let latest = edited.snapshot.draft.unwrap();
        store.dismiss(&latest.id).unwrap();
        assert!(store
            .with_reviewed_contract(&latest.id, &reviewed_contract(&latest), || {
                panic!("a dismissed draft must not reach save")
            })
            .is_err());
    }

    #[test]
    fn consultation_revision_cas_detects_empty_draft_aba_and_preserves_newer_edits() {
        let store = DraftStore::default();
        let initial = store.snapshot().unwrap();
        let first = store.propose(proposal()).unwrap();
        store.dismiss(&first.draft_id).unwrap();
        let stale = store.replace(proposal(), Some(initial.revision)).unwrap();
        assert!(stale.conflict);
        assert!(stale.snapshot.draft.is_none());
        assert_eq!(stale.snapshot.revision, 2);
        let published = store
            .replace(proposal(), Some(stale.snapshot.revision))
            .unwrap();
        assert!(!published.conflict);
        assert_eq!(published.snapshot.revision, 3);
        let id = published.snapshot.draft.unwrap().id;
        let manual = store
            .edit(
                Some(&id),
                DraftPatch {
                    goal: Some("new manual goal".into()),
                    ..DraftPatch::default()
                },
            )
            .unwrap();
        let mut candidate = proposal();
        candidate.base_draft_id = Some(id);
        let stale = store.replace(candidate, Some(3)).unwrap();
        assert!(stale.conflict);
        assert_eq!(stale.snapshot, manual.snapshot);
        assert_eq!(store.snapshot().unwrap(), manual.snapshot);
    }

    #[test]
    fn conversation_proposal_does_not_replace_active_scope_or_cancel_running_work() {
        use super::super::Runtime;
        use std::sync::Arc;
        use tokio_util::sync::CancellationToken;
        let cancel = CancellationToken::new();
        let mut runtime = Runtime {
            loaded: true,
            revision: 7,
            cancel: Some(cancel.clone()),
            active_run_id: Some("existing-run".into()),
            ..Runtime::default()
        };
        runtime.status.contract = Some(
            serde_json::from_value(json!({
                "goal": "Existing user-approved scope",
                "root": "/chosen/documents",
                "allowedOperations": ["write"],
                "intervalMinutes": 60,
                "maxRunsPerDay": 2,
                "enabled": true,
                "reviewMode": "automatic",
                "automaticActionApproval": true
            }))
            .unwrap(),
        );
        runtime.status.phase = "thinking".into();
        let before = serde_json::to_value(&runtime.status).unwrap();
        let state = AutonomyState(Arc::new(Mutex::new(runtime)));
        let receipt = propose(&state, proposal()).unwrap();
        let context = setup_context(&state).unwrap();
        assert_eq!(
            context.current_contract.unwrap().goal,
            "Existing user-approved scope"
        );
        let proposed = context.draft.unwrap();
        assert_eq!(proposed.id, receipt.draft_id);
        assert!(proposed.automatic_action_approval);
        let edited = DRAFT
            .edit(
                Some(&receipt.draft_id),
                DraftPatch {
                    goal: Some("User manually revised the goal".into()),
                    ..DraftPatch::default()
                },
            )
            .unwrap();
        let context = setup_context(&state).unwrap();
        assert_eq!(context.draft_revision, edited.snapshot.revision);
        assert_eq!(
            context.draft.as_ref().unwrap().goal,
            "User manually revised the goal"
        );
        let runtime = state.0.lock().unwrap();
        assert_eq!(serde_json::to_value(&runtime.status).unwrap(), before);
        assert_eq!(runtime.revision, 7);
        assert_eq!(runtime.active_run_id.as_deref(), Some("existing-run"));
        assert!(!cancel.is_cancelled());
        DRAFT.dismiss(&context.draft.unwrap().id).unwrap();
    }
}
