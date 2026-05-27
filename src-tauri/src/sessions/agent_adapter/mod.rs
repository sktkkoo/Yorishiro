//! Terminal agent adapter — trait + registry。
//!
//! 各 agent (Claude Code / Codex / OpenCode / ...) ごとの起動 spec 構築を
//! sub-module (claude.rs / codex.rs / opencode.rs) に閉じ、`pty_session.rs`
//! からは `lookup(&id)?.build_launch_args(&ctx)?` の 1 行で呼ぶ。
//!
//! Internal design-record (非公開): 2026-05-26-terminal-agent-adapter.md.
//! Public decision: `docs/decisions/agent-adapter.md`.

#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

/// Adapter の機能宣言。意味論を揃えるためではなく、ある／ないを declare する。
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCapabilities {
    pub persona_overlay: bool,
    pub mcp_injection: bool,
    pub plugins: bool,
    pub lifecycle_hooks: bool,
    pub session_resume: bool,
}

/// Spawn 時に各 adapter に渡される context。
pub struct LaunchContext<'a> {
    pub cwd: Option<&'a Path>,
    pub system_prompt: Option<&'a str>,
    pub plugin_dir: Option<&'a Path>,
    pub mcp_port: u16,
    pub hook_port: u16,
}

/// Adapter が返す起動 spec。pty_session.rs が CommandBuilder に apply する。
pub struct LaunchArgs {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    /// Session 終了時に削除される temp file。
    pub temp_files: Vec<PathBuf>,
}

pub trait TerminalAgent: Send + Sync + 'static {
    /// stable id (kebab-case)。`terminalAgent` config 値および bundled profile id。
    fn id(&self) -> &'static str;
    /// Health check / UI 表示用の human-readable name。
    fn display_name(&self) -> &'static str;
    /// Default binary 名 (PATH 検索の base)。
    fn binary_name(&self) -> &'static str;
    fn capabilities(&self) -> AgentCapabilities;
    fn build_launch_args(&self, ctx: &LaunchContext<'_>) -> Result<LaunchArgs, String>;
    fn has_existing_session(&self, _cwd: Option<&Path>) -> bool {
        false
    }
}

/// AgentDescriptor — Tauri command 戻り値用 DTO。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentDescriptor {
    pub id: String,
    pub display_name: String,
    pub binary_name: String,
    pub capabilities: AgentCapabilities,
}

impl AgentDescriptor {
    fn from(adapter: &'static dyn TerminalAgent) -> Self {
        Self {
            id: adapter.id().to_string(),
            display_name: adapter.display_name().to_string(),
            binary_name: adapter.binary_name().to_string(),
            capabilities: adapter.capabilities(),
        }
    }
}

pub fn registered_agents() -> &'static [&'static dyn TerminalAgent] {
    static AGENTS: OnceLock<Vec<&'static dyn TerminalAgent>> = OnceLock::new();
    AGENTS
        .get_or_init(|| {
            vec![
                &claude::CLAUDE as &dyn TerminalAgent,
                &codex::CODEX as &dyn TerminalAgent,
                &opencode::OPENCODE as &dyn TerminalAgent,
            ]
        })
        .as_slice()
}

pub fn lookup(id: &str) -> Option<&'static dyn TerminalAgent> {
    registered_agents().iter().copied().find(|a| a.id() == id)
}

pub fn descriptors() -> Vec<AgentDescriptor> {
    registered_agents()
        .iter()
        .copied()
        .map(AgentDescriptor::from)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registered_agents_contains_three_adapters_after_phase_d() {
        let agents = registered_agents();
        assert_eq!(agents.len(), 3);
        assert_eq!(agents[0].id(), "claude");
        assert_eq!(agents[1].id(), "codex");
        assert_eq!(agents[2].id(), "opencode");
    }

    #[test]
    fn lookup_returns_none_for_unknown_id() {
        assert!(lookup("nonexistent-agent-id").is_none());
    }

    #[test]
    fn lookup_returns_claude_adapter() {
        assert_eq!(lookup("claude").map(|agent| agent.id()), Some("claude"));
    }

    #[test]
    fn lookup_returns_codex_adapter() {
        assert_eq!(lookup("codex").map(|agent| agent.id()), Some("codex"));
    }

    #[test]
    fn lookup_returns_opencode_adapter() {
        assert_eq!(lookup("opencode").map(|agent| agent.id()), Some("opencode"));
    }
}

mod claude;
mod codex;
mod opencode;
