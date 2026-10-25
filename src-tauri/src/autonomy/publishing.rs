//! Saved scope compatibility only. No publication executor is provided here.
//! Approval decisions are operation-independent and live in actions.rs.
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryScope {
    pub remote_url: String,
    pub github_repo: String,
    pub base_branch: String,
}
