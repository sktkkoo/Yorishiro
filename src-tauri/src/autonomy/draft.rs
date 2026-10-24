//! Conversation-owned setup proposals, never execution authority.
//!
//! A native conversation agent may propose a delegation after talking with the
//! user. It can only replace this process-local draft. The existing main-window
//! save command remains the sole route to an active contract, and approval of a
//! daily task remains a separate user action.

use super::{files, AutonomyState, Contract};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::sync::{LazyLock, Mutex};

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReviewMode {
    Automatic,
    #[default]
    Daily,
}

/// Proposed enduring scope, not a command to start work or approve today's task.
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutonomyProposal {
    /// The enduring purpose agreed in conversation, 1–8000 UTF-8 bytes. Keep this
    /// separate from the specific task proposed for today.
    pub goal: String,
    /// Exact absolute path of an existing document folder. Use an empty string
    /// if the user has not selected a folder; never infer permission over home.
    #[serde(default)]
    pub root: String,
    /// Only write, move and trash are supported. Empty means read-only. These
    /// are reversible local document operations, never shell/network actions.
    pub allowed_operations: Vec<String>,
    /// Interval between work opportunities, 5–1440 minutes.
    pub interval_minutes: u64,
    /// Maximum work runs in a rolling 24 hours, 1–48.
    pub max_runs_per_day: usize,
    /// daily: discuss today's concrete work and wait for the user's confirmation
    /// before executing. automatic: work within the enduring scope without a
    /// daily gate. Omitting this field proposes daily review.
    #[serde(default)]
    pub review_mode: ReviewMode,
    /// Short user-facing explanation of the scope and remaining choices,
    /// 1–4000 UTF-8 bytes. Do not claim the draft is active or approved.
    pub explanation: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Draft {
    pub id: String,
    pub goal: String,
    pub root: String,
    pub allowed_operations: Vec<String>,
    pub interval_minutes: u64,
    pub max_runs_per_day: usize,
    pub review_mode: ReviewMode,
    pub explanation: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct AutonomySetupContextRequest {}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProposalReceipt {
    pub draft_id: String,
    pub status: &'static str,
    pub applied: bool,
    pub requires_review: bool,
    pub message: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupContext {
    pub current_contract: Option<Contract>,
    pub draft: Option<Draft>,
    pub guidance: &'static str,
}

const GUIDANCE: &str = "Discuss the enduring purpose, one existing document folder, reversible operations, schedule and daily review preference. Keep enduring permission separate from today's concrete work. daily review means the AI asks what to work on today and waits for the user's explicit app confirmation before execution. Use autonomy_propose only to prepare an inactive setup draft for review. If the folder is unknown, leave root empty and let the user select it in the app. No MCP tool can activate a contract, approve today's work or execute file changes. External sends, shell commands and irreversible operations are outside this pilot.";

#[derive(Default)]
struct DraftStore(Mutex<Option<Draft>>);

impl DraftStore {
    fn propose(&self, proposal: AutonomyProposal) -> Result<ProposalReceipt, String> {
        let draft = validate(proposal)?;
        let receipt = ProposalReceipt {
            draft_id: draft.id.clone(),
            status: "proposal-only",
            applied: false,
            requires_review: true,
            message: "Draft prepared. Review it in Yorishiro and confirm in the app before enabling work. This proposal did not change permissions, start work, or approve a daily task.",
        };
        *self.0.lock().map_err(|_| "設定案を保存できません")? = Some(draft);
        Ok(receipt)
    }

    fn get(&self) -> Result<Option<Draft>, String> {
        self.0
            .lock()
            .map(|draft| draft.clone())
            .map_err(|_| "設定案を取得できません".into())
    }

    fn dismiss(&self, id: &str) -> Result<bool, String> {
        let mut draft = self.0.lock().map_err(|_| "設定案を更新できません")?;
        if draft.as_ref().is_some_and(|draft| draft.id == id) {
            *draft = None;
            return Ok(true);
        }
        Ok(false)
    }
}

static DRAFT: LazyLock<DraftStore> = LazyLock::new(DraftStore::default);

fn validate(mut proposal: AutonomyProposal) -> Result<Draft, String> {
    proposal.goal = proposal.goal.trim().to_owned();
    proposal.explanation = proposal.explanation.trim().to_owned();
    proposal.root = proposal.root.trim().to_owned();
    if proposal.goal.is_empty() || proposal.goal.len() > 8_000 {
        return Err("目的は1〜8000バイトで入力してください".into());
    }
    if proposal.explanation.is_empty() || proposal.explanation.len() > 4_000 {
        return Err("設定案の説明は1〜4000バイトで入力してください".into());
    }
    if proposal.root.len() > 4096 || proposal.root.chars().any(char::is_control) {
        return Err("対象フォルダの指定が不正です".into());
    }
    if proposal.allowed_operations.len() > 3
        || proposal
            .allowed_operations
            .iter()
            .any(|op| !["write", "move", "trash"].contains(&op.as_str()))
        || proposal
            .allowed_operations
            .iter()
            .collect::<BTreeSet<_>>()
            .len()
            != proposal.allowed_operations.len()
    {
        return Err("設定案で指定できる操作は write・move・trash です。外部送信やコマンド実行は指定できません".into());
    }
    if !(5..=1440).contains(&proposal.interval_minutes)
        || !(1..=48).contains(&proposal.max_runs_per_day)
    {
        return Err("実行間隔は5〜1440分、24時間の上限は1〜48回です".into());
    }
    if !proposal.root.is_empty() {
        proposal.root = files::validate_root(&proposal.root)?
            .to_string_lossy()
            .into_owned();
    }
    Ok(Draft {
        id: uuid::Uuid::new_v4().to_string(),
        goal: proposal.goal,
        root: proposal.root,
        allowed_operations: proposal.allowed_operations,
        interval_minutes: proposal.interval_minutes,
        max_runs_per_day: proposal.max_runs_per_day,
        review_mode: proposal.review_mode,
        explanation: proposal.explanation,
    })
}

pub fn propose(proposal: AutonomyProposal) -> Result<ProposalReceipt, String> {
    DRAFT.propose(proposal)
}

pub fn setup_context(state: &AutonomyState) -> Result<SetupContext, String> {
    // Clone only the agreed scope; no file contents, run results or credentials
    // are exposed by this conversation setup tool.
    let current_contract = super::lock(state)?.status.contract.clone();
    Ok(SetupContext {
        current_contract,
        draft: DRAFT.get()?,
        guidance: GUIDANCE,
    })
}

#[tauri::command]
pub fn autonomy_draft_get(window: tauri::WebviewWindow) -> Result<Option<Draft>, String> {
    super::main_window(&window)?;
    DRAFT.get()
}

/// Compare the displayed ID so acknowledging an older proposal never discards
/// a newer one that arrived while the user was reviewing it.
#[tauri::command]
pub fn autonomy_draft_dismiss(window: tauri::WebviewWindow, id: String) -> Result<bool, String> {
    super::main_window(&window)?;
    DRAFT.dismiss(&id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn proposal() -> AutonomyProposal {
        AutonomyProposal {
            goal: "  下書きを整理し、読みやすくする  ".into(),
            root: String::new(),
            allowed_operations: vec!["write".into()],
            interval_minutes: 30,
            max_runs_per_day: 4,
            review_mode: ReviewMode::Daily,
            explanation: "既存の文書を対象に、毎日の相談で決めた仕事を進めます。".into(),
        }
    }

    #[test]
    fn draft_without_folder_is_inactive_and_cannot_carry_execution_authority() {
        let store = DraftStore::default();
        let receipt = store.propose(proposal()).unwrap();
        let draft = store.get().unwrap().unwrap();
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
    fn omitted_review_mode_defaults_to_daily_without_changing_requested_mode() {
        let mut encoded = serde_json::to_value(proposal()).unwrap();
        encoded.as_object_mut().unwrap().remove("reviewMode");
        assert_eq!(
            serde_json::from_value::<AutonomyProposal>(encoded.clone())
                .unwrap()
                .review_mode,
            ReviewMode::Daily
        );
        encoded["reviewMode"] = json!("automatic");
        assert_eq!(
            serde_json::from_value::<AutonomyProposal>(encoded.clone())
                .unwrap()
                .review_mode,
            ReviewMode::Automatic
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
        for budget in [0, 49, usize::MAX] {
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
    fn root_must_be_explicit_existing_folder_without_writing_any_files() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let store = DraftStore::default();
        let mut candidate = proposal();
        candidate.root = root.to_string_lossy().into_owned();
        store.propose(candidate).unwrap();
        assert_eq!(store.get().unwrap().unwrap().root, root.to_string_lossy());
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        for invalid in [
            "/".to_owned(),
            "Documents".to_owned(),
            root.join("missing").to_string_lossy().into_owned(),
        ] {
            let mut candidate = proposal();
            candidate.root = invalid;
            assert!(store.propose(candidate).is_err());
        }
        assert!(!root.join("missing").exists());
    }

    #[test]
    fn acknowledging_an_old_proposal_never_discards_a_new_one() {
        let store = DraftStore::default();
        let first = store.propose(proposal()).unwrap();
        let second = store.propose(proposal()).unwrap();
        assert_ne!(first.draft_id, second.draft_id);
        assert!(!store.dismiss(&first.draft_id).unwrap());
        assert_eq!(store.get().unwrap().unwrap().id, second.draft_id);
        assert!(store.dismiss(&second.draft_id).unwrap());
        assert!(store.get().unwrap().is_none());
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
                "reviewMode": "automatic"
            }))
            .unwrap(),
        );
        runtime.status.phase = "thinking".into();
        let before = serde_json::to_value(&runtime.status).unwrap();
        let state = AutonomyState(Arc::new(Mutex::new(runtime)));
        let receipt = propose(proposal()).unwrap();
        let context = setup_context(&state).unwrap();
        assert_eq!(
            context.current_contract.unwrap().goal,
            "Existing user-approved scope"
        );
        assert_eq!(context.draft.unwrap().id, receipt.draft_id);
        let runtime = state.0.lock().unwrap();
        assert_eq!(serde_json::to_value(&runtime.status).unwrap(), before);
        assert_eq!(runtime.revision, 7);
        assert_eq!(runtime.active_run_id.as_deref(), Some("existing-run"));
        assert!(!cancel.is_cancelled());
        DRAFT.dismiss(&receipt.draft_id).unwrap();
    }
}
