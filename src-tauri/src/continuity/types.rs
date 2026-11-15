use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionBackend {
    Codex,
    Pi,
    Text,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Context {
    pub persona_id: String,
    pub persona_name: String,
    pub persona_prompt: String,
    pub language: String,
    pub cwd: Option<String>,
    #[serde(default)]
    pub execution_session_id: Option<String>,
    /// Backend selection survives the Main Agent's transient startup absence.
    #[serde(default)]
    pub execution_backend: Option<ExecutionBackend>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ReplyKind {
    Report,
    AwaitingReply,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub role: String,
    pub content: String,
    pub created_at: u64,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reply_kind: Option<ReplyKind>,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Certainty {
    Confirmed,
    Inferred,
    Unverified,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Revision {
    pub value: String,
    pub reason: String,
    pub source_ids: Vec<String>,
    pub created_at: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Understanding {
    pub id: String,
    pub title: String,
    pub value: String,
    pub certainty: Certainty,
    pub source_ids: Vec<String>,
    pub updated_at: u64,
    pub revisions: Vec<Revision>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reflection {
    pub id: String,
    pub content: String,
    pub source_ids: Vec<String>,
    pub understanding_ids: Vec<String>,
    pub created_at: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub title: String,
    pub content: String,
    pub reason: String,
    pub status: String,
    pub source_ids: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
}
/// 明示的な記憶依頼の原文と、その場の会話を保持する参照。推測した事実ではない。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ExplicitMemory {
    pub request_message_id: String,
    pub source_ids: Vec<String>,
}
/// 忘れたメモリーを同じ根拠から自動再生成しないための記録。本文は保持しない。
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ForgottenUnderstanding {
    pub understanding_id: String,
    pub source_ids: Vec<String>,
    pub forgotten_at: u64,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub persona_id: String,
    pub revision: u64,
    #[serde(default)]
    pub auto_enabled: bool,
    pub phase: String,
    pub messages: Vec<Message>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub explicit_memories: Vec<ExplicitMemory>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub forgotten_understandings: Vec<ForgottenUnderstanding>,
    pub understandings: Vec<Understanding>,
    pub drafts: Vec<Draft>,
    pub reflections: Vec<Reflection>,
    pub error: Option<String>,
    pub last_observed_at: Option<u64>,
    #[serde(default)]
    pub next_step: Option<String>,
}
/// アプリへの応答専用。保存データとモデルへ渡す Snapshot には実行時の表示情報を含めない。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UiSnapshot {
    #[serde(flatten)]
    pub snapshot: Snapshot,
    /// 自動再確認が可能になる最も早い時刻。実際の開始時刻は保証しない。
    pub automatic_retry_at: Option<u64>,
    /// 同じ保存 revision 内の応答順序。保存せず、プロセス内の persona ごとに増やす。
    pub publication_sequence: u64,
}
impl Snapshot {
    pub fn new(persona_id: &str) -> Self {
        Self {
            persona_id: persona_id.into(),
            revision: 0,
            auto_enabled: true,
            phase: "idle".into(),
            messages: vec![],
            explicit_memories: vec![],
            forgotten_understandings: vec![],
            understandings: vec![],
            drafts: vec![],
            reflections: vec![],
            error: None,
            last_observed_at: None,
            next_step: None,
        }
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Saved {
    pub version: u32,
    pub snapshot: Snapshot,
    #[serde(default)]
    pub auto_enabled: bool,
    #[serde(default)]
    pub auto_context: Option<Context>,
    /// Actual native worker observations, committed with the resulting state.
    /// Quiet model checks and tool progress remain distinguishable.
    #[serde(default)]
    pub work_runs: Vec<WorkRun>,
    /// Persisted automatic failure backoff survives process restarts.
    #[serde(default)]
    pub(super) failure_streak: u32,
    /// 未完了作業があるまま成果を得られなかった連続回数。
    #[serde(default)]
    pub(super) stagnation_streak: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) stagnation_pause: Option<String>,
    #[serde(default)]
    pub(super) retry_not_before: Option<u64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) context_handoffs: Vec<ContextHandoff>,
    #[serde(default)]
    pub observed_keys: std::collections::BTreeMap<String, String>,
    /// 読み終えた通常会話の整理候補。参照中・未処理の情報は別途保護する。
    #[serde(default, skip_serializing_if = "std::collections::BTreeSet::is_empty")]
    pub(super) retired_message_ids: std::collections::BTreeSet<String>,
    #[serde(default)]
    pub pending_correction_ids: Vec<String>,
    #[serde(default)]
    pub pending_trigger: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(super) pending_execution: Option<PendingExecution>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub(super) terminal_receipts: Vec<ExecutionReceipt>,
    #[serde(default)]
    pub(super) execution_blocked: bool,
    #[serde(default)]
    pub(super) resume_after_recovery: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ContextHandoff {
    pub from_request_id: Option<String>,
    pub to_request_id: String,
    pub at: u64,
    pub reason: String,
    pub from_session_dir: Option<String>,
    pub to_session_dir: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkRun {
    pub request_id: String,
    /// Original request creation, distinct from this recovery observation.
    /// Unknown for requests saved before this evidence was collected.
    #[serde(default)]
    pub request_created_at: Option<u64>,
    pub started_at: u64,
    pub finished_at: u64,
    pub trigger: String,
    pub executor: String,
    pub outcome: String,
    pub progressed: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum TerminalStatus {
    Interrupted,
    Failed,
    CompletedWithoutReport,
}
impl TerminalStatus {
    pub(super) fn message(&self) -> &'static str {
        match self {
            Self::Interrupted => "Autonomous work was interrupted in Main Agent. Inspect its result before continuing; it will not be repeated automatically.",
            Self::Failed => "Autonomous work failed in Main Agent. Inspect its result before continuing; it will not be repeated automatically.",
            Self::CompletedWithoutReport => "Main Agent finished without a readable work report. Inspect its completed turn and current workspace before continuing; its operations will not be repeated automatically.",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExecutionReceipt {
    pub request_id: String,
    pub target: super::execution_target::ExecutionTarget,
    pub turn_id: String,
    pub status: TerminalStatus,
    pub observed_at: u64,
    #[serde(default)]
    pub previous_step: Option<String>,
    pub evidence: Vec<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PendingExecution {
    pub request_id: String,
    #[serde(default)]
    pub created_at: Option<u64>,
    pub target: super::execution_target::ExecutionTarget,
    pub context: Context,
    pub prompt: String,
    /// Exact original message/schema envelope. Legacy requests without it may
    /// recover receipts but cannot authorize a managed same-ID admission retry.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_payload: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_budget: Option<super::execution_context::BudgetReport>,
    pub trigger: String,
    pub correction_ids: Vec<String>,
    #[serde(default)]
    pub previous_step: Option<String>,
    #[serde(default)]
    pub message_count: usize,
    #[serde(default)]
    pub dispatch_attempted: bool,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UnderstandingUpdate {
    pub id: String,
    pub title: String,
    pub value: String,
    pub certainty: Certainty,
    pub source_ids: Vec<String>,
    pub reason: String,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DraftUpdate {
    pub id: Option<String>,
    pub title: String,
    pub content: String,
    pub reason: String,
    pub source_ids: Vec<String>,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedReply {
    pub message_id: String,
    pub kind: ReplyKind,
}
#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WorkStatus {
    Idle,
    InProgress,
    Blocked,
}
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelResult {
    /// 内容を確認済みで、未完了の依頼・制約を含まない通常会話の ID。
    #[serde(default)]
    #[schemars(length(max = 32))]
    pub retired_message_ids: Vec<String>,
    #[serde(default)]
    pub work_status: Option<WorkStatus>,
    #[serde(default)]
    pub blocked_reason: Option<String>,
    #[serde(default)]
    pub observed_reply: Option<ObservedReply>,
    pub reply: String,
    #[serde(default)]
    pub reply_kind: Option<ReplyKind>,
    pub understandings: Vec<UnderstandingUpdate>,
    pub drafts: Vec<DraftUpdate>,
    pub reflection: String,
    #[serde(default)]
    pub next_step: Option<String>,
}
