use super::{AgentCapabilities, LaunchArgs, LaunchContext, TerminalAgent};

pub struct ClaudeAgent;
pub static CLAUDE: ClaudeAgent = ClaudeAgent;

impl TerminalAgent for ClaudeAgent {
    fn id(&self) -> &'static str {
        "claude"
    }

    fn display_name(&self) -> &'static str {
        "Claude Code"
    }

    fn binary_name(&self) -> &'static str {
        "claude"
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            persona_overlay: true,
            mcp_injection: true,
            plugins: true,
            lifecycle_hooks: true,
            session_resume: true,
        }
    }

    fn build_launch_args(&self, ctx: &LaunchContext<'_>) -> Result<LaunchArgs, String> {
        let mut args = Vec::new();
        let mut temp_files = Vec::new();

        // 常に -c を渡す。「この cwd に継続対象があるか」は Claude Code 自身が判定し、
        // 無ければ新規セッションとして graceful に起動する（claude 2.1.201 で
        // print / interactive 両モード実測済み）。Charminal 側で ~/.claude/projects/ を
        // 走査して判定すると undocumented 依存 + 二重管理になるため、判定は持たない。
        // 設計: design-record 2026-07-04-main-agent-autolaunch-rethink.md §1.3
        args.push("-c".to_string());

        let hooks_json = crate::pty::build_hooks_json(ctx.hook_port);
        let hooks_path = super::temp_config_path("hooks", "json");
        let hooks_path_arg = super::utf8_path_for_cli(&hooks_path, "Claude hooks settings")?;
        std::fs::write(&hooks_path, &hooks_json)
            .map_err(|e| format!("Failed to write hooks settings: {}", e))?;
        args.push("--settings".to_string());
        args.push(hooks_path_arg);
        temp_files.push(hooks_path);

        // Claude Code plugin 配下の .mcp.json は auto-discover されないため、
        // 起動ごとに実 port を反映した config を session-scoped に生成する。
        let mcp_config_json = claude_charminal_mcp_config_json(ctx.mcp_port);
        let mcp_config_path = super::temp_config_path("mcp", "json");
        let mcp_config_path_arg = super::utf8_path_for_cli(&mcp_config_path, "Claude MCP config")?;
        std::fs::write(&mcp_config_path, &mcp_config_json)
            .map_err(|e| format!("Failed to write MCP config: {}", e))?;
        args.push("--mcp-config".to_string());
        args.push(mcp_config_path_arg);
        temp_files.push(mcp_config_path);

        if let Some(dir) = ctx.plugin_dir {
            if dir.exists() {
                args.push("--plugin-dir".to_string());
                args.push(dir.to_string_lossy().into_owned());
            } else {
                eprintln!(
                    "[agent_adapter.claude] plugin_dir does not exist, skipping: {}",
                    dir.display()
                );
            }
        }

        if let Some(prompt) = ctx.system_prompt {
            args.push("--append-system-prompt".to_string());
            args.push(prompt.to_string());
        }

        Ok(LaunchArgs {
            args,
            env: Vec::new(),
            temp_files,
        })
    }
}

fn claude_charminal_mcp_config_json(port: u16) -> String {
    serde_json::json!({
        "mcpServers": {
            "charminal": {
                "type": "http",
                "url": format!("http://127.0.0.1:{}/mcp", port),
            }
        }
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_charminal_mcp_config_json_points_to_streamable_http_server() {
        let parsed: serde_json::Value =
            serde_json::from_str(&claude_charminal_mcp_config_json(18744)).expect("valid json");
        assert_eq!(
            parsed["mcpServers"]["charminal"]["url"],
            "http://127.0.0.1:18744/mcp"
        );
        assert_eq!(parsed["mcpServers"]["charminal"]["type"], "http");
    }
}
