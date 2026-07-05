//! Terminal agent adapter — trait + registry。
//!
//! 各 agent (Claude Code / Codex / OpenCode / ...) ごとの起動 spec 構築を
//! sub-module (claude.rs / codex.rs / opencode.rs) に閉じ、`pty_session.rs`
//! からは `lookup(&id)?.build_launch_args(&ctx)?` の 1 行で呼ぶ。
//!
//! Internal design-record (非公開): 2026-05-26-terminal-agent-adapter.md.
//! Public decision: `docs/decisions/agent-adapter.md`.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::Serialize;

fn temp_config_path(prefix: &str, extension: &str) -> PathBuf {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!(
        "charminal-{}-{}-{}.{}",
        prefix,
        std::process::id(),
        stamp,
        extension
    ))
}

fn utf8_path_for_cli(path: &Path, label: &str) -> Result<String, String> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("{} path is not valid UTF-8: {}", label, path.display()))
}

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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentThemeRefresh {
    Sigusr2,
}

/// charm コマンドの記法。`<prefix>charm<separator><name>` で 1 命令になる。
/// Claude: `/charm:create`、Codex: `$charm-create`、OpenCode: `/charm-create`。
/// prefill (TS strings.ts) / template 生成 (opencode.rs) はこの宣言を正本にする。
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandSyntax {
    pub prefix: &'static str,
    pub separator: &'static str,
}

/// Spawn 時に各 adapter に渡される context。
pub struct LaunchContext<'a> {
    pub cwd: Option<&'a Path>,
    pub system_prompt: Option<&'a str>,
    pub prompt_reminder: Option<&'a str>,
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
    /// charm コマンドの記法。default は Claude (`/charm:<name>`)。
    fn command_syntax(&self) -> CommandSyntax {
        CommandSyntax {
            prefix: "/",
            separator: ":",
        }
    }
    fn build_launch_args(&self, ctx: &LaunchContext<'_>) -> Result<LaunchArgs, String>;
    fn theme_refresh(&self) -> Option<AgentThemeRefresh> {
        None
    }
    fn has_existing_session(&self, _cwd: Option<&Path>) -> bool {
        false
    }
    /// この agent 固有の install dir。PATH 検索の base に前置される。
    /// generic 層（`build_path_env` / `resolve_agent_binary`）は agent 固有の
    /// install location を直書きせず、ここを参照する。
    fn extra_path_dirs(&self) -> Vec<PathBuf> {
        Vec::new()
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
    pub command_syntax: CommandSyntax,
}

impl AgentDescriptor {
    fn from(adapter: &'static dyn TerminalAgent) -> Self {
        Self {
            id: adapter.id().to_string(),
            display_name: adapter.display_name().to_string(),
            binary_name: adapter.binary_name().to_string(),
            capabilities: adapter.capabilities(),
            command_syntax: adapter.command_syntax(),
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

/// 登録済み全 adapter が宣言する install dir を集めて返す（PATH 前置用）。
pub(crate) fn all_extra_path_dirs() -> Vec<PathBuf> {
    registered_agents()
        .iter()
        .flat_map(|agent| agent.extra_path_dirs())
        .collect()
}

/// Claude の UserPromptSubmit reminder と同じ active 設定を、hook を持たない
/// adapter 用の prompt overlay として組み立てる。
pub(crate) fn build_prompt_reminder_from_config() -> Option<String> {
    let config = crate::yorishiro_home_path()
        .ok()
        .and_then(|home| std::fs::read_to_string(home.join("config.json")).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok());
    build_prompt_reminder_from_config_value(config.as_ref())
}

pub(crate) fn merge_system_prompt_and_reminder(
    system_prompt: Option<&str>,
    prompt_reminder: Option<&str>,
) -> Option<String> {
    let system = system_prompt.and_then(non_empty_trimmed);
    let reminder = prompt_reminder.and_then(non_empty_trimmed);
    match (system, reminder) {
        (Some(system), Some(reminder)) => Some(format!("{}\n\n---\n\n{}", system, reminder)),
        (Some(system), None) => Some(system.to_string()),
        (None, Some(reminder)) => Some(reminder.to_string()),
        (None, None) => None,
    }
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

fn build_prompt_reminder_from_config_value(config: Option<&serde_json::Value>) -> Option<String> {
    let mut reminders = Vec::new();
    if !config_field_is_any(config, "journalReminder", &["off"]) {
        reminders.push("印象があれば journal_write。[感触/記憶/物語]");
    }
    if !config_field_is_any(config, "voiceFrequency", &["off", "none"]) {
        reminders.push("応答の要点を voice_say で声に出す。声が先。");
    }
    if reminders.is_empty() {
        return None;
    }

    let bullets = reminders
        .into_iter()
        .map(|line| format!("- {}", line))
        .collect::<Vec<_>>()
        .join("\n");
    Some(format!(
        "## Charminal reminders\n\nBefore each response, check these active reminders:\n\n{}",
        bullets
    ))
}

fn config_field_is_any(config: Option<&serde_json::Value>, field: &str, values: &[&str]) -> bool {
    let Some(actual) = config
        .and_then(|value| value.get(field))
        .and_then(|value| value.as_str())
    else {
        return false;
    };
    values.contains(&actual)
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

    #[test]
    fn command_syntax_declared_per_adapter() {
        assert_eq!(
            lookup("claude").map(|a| a.command_syntax()),
            Some(CommandSyntax {
                prefix: "/",
                separator: ":"
            })
        );
        assert_eq!(
            lookup("codex").map(|a| a.command_syntax()),
            Some(CommandSyntax {
                prefix: "$",
                separator: "-"
            })
        );
        assert_eq!(
            lookup("opencode").map(|a| a.command_syntax()),
            Some(CommandSyntax {
                prefix: "/",
                separator: "-"
            })
        );
    }

    #[test]
    fn only_opencode_declares_theme_refresh_signal() {
        assert_eq!(
            lookup("claude").and_then(|agent| agent.theme_refresh()),
            None
        );
        assert_eq!(
            lookup("codex").and_then(|agent| agent.theme_refresh()),
            None
        );
        assert_eq!(
            lookup("opencode").and_then(|agent| agent.theme_refresh()),
            Some(AgentThemeRefresh::Sigusr2)
        );
    }

    #[test]
    fn prompt_reminder_defaults_to_journal_and_voice() {
        let reminder = build_prompt_reminder_from_config_value(None).expect("reminder");
        assert!(reminder.contains("journal_write"));
        assert!(reminder.contains("voice_say"));
    }

    #[test]
    fn prompt_reminder_respects_disabled_config_flags() {
        let config = serde_json::json!({
            "journalReminder": "off",
            "voiceFrequency": "off",
        });
        assert!(build_prompt_reminder_from_config_value(Some(&config)).is_none());
    }

    #[test]
    fn prompt_reminder_treats_legacy_none_voice_frequency_as_off() {
        let config = serde_json::json!({
            "voiceFrequency": "none",
        });
        let reminder = build_prompt_reminder_from_config_value(Some(&config)).expect("reminder");
        assert!(reminder.contains("journal_write"));
        assert!(!reminder.contains("voice_say"));
    }

    #[test]
    fn merge_system_prompt_and_reminder_appends_reminder() {
        assert_eq!(
            merge_system_prompt_and_reminder(Some("persona"), Some("reminder")),
            Some("persona\n\n---\n\nreminder".to_string())
        );
        assert_eq!(
            merge_system_prompt_and_reminder(Some("  persona  "), None),
            Some("persona".to_string())
        );
        assert_eq!(
            merge_system_prompt_and_reminder(None, Some("  reminder  ")),
            Some("reminder".to_string())
        );
    }
}

mod claude;
mod codex;
mod opencode;
