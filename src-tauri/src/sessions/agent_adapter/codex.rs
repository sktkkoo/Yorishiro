use super::{AgentCapabilities, CommandSyntax, LaunchArgs, LaunchContext, TerminalAgent};

pub struct CodexAgent;
pub static CODEX: CodexAgent = CodexAgent;

impl TerminalAgent for CodexAgent {
    fn id(&self) -> &'static str {
        "codex"
    }

    fn display_name(&self) -> &'static str {
        "Codex"
    }

    fn binary_name(&self) -> &'static str {
        "codex"
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            persona_overlay: true,
            mcp_injection: true,
            plugins: true,
            lifecycle_hooks: false,
            session_resume: true,
        }
    }

    /// Codex は charm command を skill として `$charm-<name>` で呼ぶ。
    fn command_syntax(&self) -> CommandSyntax {
        CommandSyntax {
            prefix: "$",
            separator: "-",
        }
    }

    fn build_launch_args(&self, ctx: &LaunchContext<'_>) -> Result<LaunchArgs, String> {
        // 常に `resume --last` を渡す。--last は cwd スコープで、この cwd に継続対象が
        // 無ければ新規セッションとして graceful に起動する（codex 0.142.5 で、他 cwd の
        // セッションが多数ある環境でも他を拾わず新規になることを実測済み）。
        // ~/.codex/sessions の jsonl を走査する判定は undocumented 依存なので持たない。
        // 設計: design-record 2026-07-04-main-agent-autolaunch-rethink.md §1.3
        let mut args = vec!["resume".to_string(), "--last".to_string()];

        args.push("-c".to_string());
        args.push(codex_charminal_mcp_config_arg(ctx.mcp_port));

        args.push("-c".to_string());
        args.push(codex_charminal_plugin_enable_arg());

        if let Some(prompt) =
            super::merge_system_prompt_and_reminder(ctx.system_prompt, ctx.prompt_reminder)
        {
            args.push("-c".to_string());
            args.push(format!(
                "developer_instructions={}",
                toml_basic_string(&prompt)
            ));
        }

        Ok(LaunchArgs {
            args,
            env: Vec::new(),
            temp_files: Vec::new(),
        })
    }
}

fn toml_basic_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn codex_charminal_mcp_config_arg(port: u16) -> String {
    let url = format!("http://127.0.0.1:{}/mcp", port);
    format!("mcp_servers.charminal.url={}", toml_basic_string(&url))
}

/// Codex の charm プラグイン有効化に必要な -c config override を返す。
/// プラグイン自体は prepare_localized_plugin_dir で Codex のキャッシュに
/// 直接インストール済み。ここでは有効化フラグだけ渡す。
fn codex_charminal_plugin_enable_arg() -> String {
    "plugins.\"charm@charminal-local\".enabled=true".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ctx<'a>(
        system_prompt: Option<&'a str>,
        prompt_reminder: Option<&'a str>,
    ) -> LaunchContext<'a> {
        LaunchContext {
            system_prompt,
            prompt_reminder,
            plugin_dir: None,
            mcp_port: 18743,
            hook_port: 19001,
        }
    }

    #[test]
    fn toml_basic_string_escapes_prompt_for_codex_config() {
        assert_eq!(
            toml_basic_string("a \"quote\"\npath\\tail"),
            "\"a \\\"quote\\\"\\npath\\\\tail\""
        );
    }

    #[test]
    fn codex_charminal_mcp_config_arg_points_to_streamable_http_server() {
        assert_eq!(
            codex_charminal_mcp_config_arg(18743),
            "mcp_servers.charminal.url=\"http://127.0.0.1:18743/mcp\""
        );
    }

    #[test]
    fn codex_charminal_plugin_enable_arg_returns_enable_flag() {
        assert_eq!(
            codex_charminal_plugin_enable_arg(),
            "plugins.\"charm@charminal-local\".enabled=true"
        );
    }

    #[test]
    fn codex_injects_prompt_reminder_as_developer_instructions() {
        let ctx = make_ctx(None, Some("## Charminal reminders\n\n- voice_say"));
        let result = CODEX.build_launch_args(&ctx).expect("build_launch_args");

        assert!(result.args.iter().any(|arg| arg
            .contains("developer_instructions=\"## Charminal reminders\\n\\n- voice_say\"")));
    }

    #[test]
    fn codex_appends_prompt_reminder_after_system_prompt() {
        let ctx = make_ctx(Some("persona prompt"), Some("runtime reminder"));
        let result = CODEX.build_launch_args(&ctx).expect("build_launch_args");

        assert!(result
            .args
            .iter()
            .any(|arg| arg.contains("persona prompt\\n\\n---\\n\\nruntime reminder")));
    }
}
