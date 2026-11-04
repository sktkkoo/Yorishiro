use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

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
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub persona_id: String,
    pub revision: u64,
    pub phase: String,
    pub messages: Vec<Message>,
    pub understandings: Vec<Understanding>,
    pub drafts: Vec<Draft>,
    pub reflections: Vec<Reflection>,
    pub error: Option<String>,
    pub last_observed_at: Option<u64>,
    #[serde(default)]
    pub next_step: Option<String>,
}
impl Snapshot {
    pub fn new(persona_id: &str) -> Self {
        Self {
            persona_id: persona_id.into(),
            revision: 0,
            phase: "idle".into(),
            messages: vec![],
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
    pub observed_keys: std::collections::BTreeMap<String, String>,
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

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) enum TerminalStatus {
    Interrupted,
    Failed,
}
impl TerminalStatus {
    pub(super) fn message(&self) -> &'static str {
        match self {
            Self::Interrupted => "Autonomous work was interrupted in Main Agent. Inspect its result before continuing; it will not be repeated automatically.",
            Self::Failed => "Autonomous work failed in Main Agent. Inspect its result before continuing; it will not be repeated automatically.",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ExecutionReceipt {
    pub request_id: String,
    pub target: super::executor::Target,
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
    pub target: super::executor::Target,
    pub context: Context,
    pub prompt: String,
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
#[derive(Debug, Deserialize, Serialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ModelResult {
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
