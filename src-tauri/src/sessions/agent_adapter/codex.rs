use std::path::Path;

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

    /// Codex は yori command を skill として `$yori-<name>` で呼ぶ。
    fn command_syntax(&self) -> CommandSyntax {
        CommandSyntax {
            prefix: "$",
            separator: "-",
        }
    }

    fn build_launch_args(&self, ctx: &LaunchContext<'_>) -> Result<LaunchArgs, String> {
        let mut args = Vec::new();

        if ctx.resume && self.has_existing_session(ctx.cwd) {
            args.push("resume".to_string());
            args.push("--last".to_string());
        }

        args.push("-c".to_string());
        args.push(codex_yorishiro_mcp_config_arg(ctx.mcp_port));

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

    fn has_existing_session(&self, cwd: Option<&Path>) -> bool {
        has_existing_codex_session(cwd.and_then(|p| p.to_str()))
    }
}

fn codex_session_file_matches_cwd(path: &Path, resolved_cwd: &Path) -> bool {
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut reader = std::io::BufReader::new(file);
    let mut first_line = String::new();
    if std::io::BufRead::read_line(&mut reader, &mut first_line).is_err() {
        return false;
    }

    let Ok(value) = serde_json::from_str::<serde_json::Value>(&first_line) else {
        return false;
    };
    let Some(cwd) = value
        .get("payload")
        .and_then(|payload| payload.get("cwd"))
        .and_then(|cwd| cwd.as_str())
    else {
        return false;
    };

    std::fs::canonicalize(cwd)
        .map(|session_cwd| session_cwd == resolved_cwd)
        .unwrap_or(false)
}

fn has_existing_codex_session_in(sessions_dir: &Path, resolved_cwd: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(sessions_dir) else {
        return false;
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if has_existing_codex_session_in(&path, resolved_cwd) {
                return true;
            }
        } else if path.extension().and_then(|ext| ext.to_str()) == Some("jsonl")
            && codex_session_file_matches_cwd(&path, resolved_cwd)
        {
            return true;
        }
    }

    false
}

/// `cwd` に対応する Codex 既存 session があり、`resume --last` で使えるなら true。
///
/// Codex は JSONL rollout を `~/.codex/sessions/YYYY/MM/DD/` に保存する。
/// 先頭行の `session_meta.payload.cwd` を canonicalize 後の cwd と照合し、
/// 別 workspace の `resume --last` 誤爆を避ける。
fn has_existing_codex_session(cwd: Option<&str>) -> bool {
    let raw = match cwd {
        Some(c) => std::path::PathBuf::from(c),
        None => match std::env::current_dir() {
            Ok(p) => p,
            Err(_) => return false,
        },
    };

    let Ok(resolved) = std::fs::canonicalize(&raw) else {
        return false;
    };

    let Some(home) = dirs::home_dir() else {
        return false;
    };

    has_existing_codex_session_in(&home.join(".codex").join("sessions"), &resolved)
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

fn codex_yorishiro_mcp_config_arg(port: u16) -> String {
    let url = format!("http://127.0.0.1:{}/mcp", port);
    format!("mcp_servers.yorishiro.url={}", toml_basic_string(&url))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_ctx<'a>(
        cwd: Option<&'a Path>,
        system_prompt: Option<&'a str>,
        prompt_reminder: Option<&'a str>,
    ) -> LaunchContext<'a> {
        LaunchContext {
            cwd,
            system_prompt,
            prompt_reminder,
            plugin_dir: None,
            mcp_port: 18743,
            hook_port: 19001,
            resume: true,
        }
    }

    fn make_ctx_with_resume<'a>(
        cwd: Option<&'a Path>,
        system_prompt: Option<&'a str>,
        prompt_reminder: Option<&'a str>,
        resume: bool,
    ) -> LaunchContext<'a> {
        LaunchContext {
            cwd,
            system_prompt,
            prompt_reminder,
            plugin_dir: None,
            mcp_port: 18743,
            hook_port: 19001,
            resume,
        }
    }

    #[test]
    fn codex_session_file_matches_cwd_from_session_meta() {
        let tmp = std::env::temp_dir().join(format!(
            "yorishiro-codex-session-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let workspace = tmp.join("workspace");
        let session = tmp.join("session.jsonl");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::write(
            &session,
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{}\"}}}}\n",
                workspace.to_str().expect("workspace path utf8")
            ),
        )
        .expect("write session");

        let resolved = std::fs::canonicalize(&workspace).expect("canonicalize workspace");
        assert!(codex_session_file_matches_cwd(&session, &resolved));

        let _ = std::fs::remove_file(&session);
        let _ = std::fs::remove_dir(&workspace);
        let _ = std::fs::remove_dir(&tmp);
    }

    #[test]
    fn has_existing_codex_session_in_finds_nested_jsonl_for_cwd() {
        let tmp = std::env::temp_dir().join(format!(
            "yorishiro-codex-session-tree-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let sessions_dir = tmp.join("sessions");
        let nested = sessions_dir.join("2026").join("04").join("23");
        let workspace = tmp.join("workspace");
        std::fs::create_dir_all(&nested).expect("create nested sessions dir");
        std::fs::create_dir_all(&workspace).expect("create workspace");
        std::fs::write(
            nested.join("rollout.jsonl"),
            format!(
                "{{\"type\":\"session_meta\",\"payload\":{{\"cwd\":\"{}\"}}}}\n",
                workspace.to_str().expect("workspace path utf8")
            ),
        )
        .expect("write session");

        let resolved = std::fs::canonicalize(&workspace).expect("canonicalize workspace");
        assert!(has_existing_codex_session_in(&sessions_dir, &resolved));

        let _ = std::fs::remove_file(nested.join("rollout.jsonl"));
        let _ = std::fs::remove_dir(&nested);
        let _ = std::fs::remove_dir(sessions_dir.join("2026").join("04"));
        let _ = std::fs::remove_dir(sessions_dir.join("2026"));
        let _ = std::fs::remove_dir(&sessions_dir);
        let _ = std::fs::remove_dir(&workspace);
        let _ = std::fs::remove_dir(&tmp);
    }

    #[test]
    fn toml_basic_string_escapes_prompt_for_codex_config() {
        assert_eq!(
            toml_basic_string("a \"quote\"\npath\\tail"),
            "\"a \\\"quote\\\"\\npath\\\\tail\""
        );
    }

    #[test]
    fn codex_yorishiro_mcp_config_arg_points_to_streamable_http_server() {
        assert_eq!(
            codex_yorishiro_mcp_config_arg(18743),
            "mcp_servers.yorishiro.url=\"http://127.0.0.1:18743/mcp\""
        );
    }

    #[test]
    fn codex_injects_prompt_reminder_as_developer_instructions() {
        let ctx = make_ctx(None, None, Some("## Yorishiro reminders\n\n- voice_say"));
        let result = CODEX.build_launch_args(&ctx).expect("build_launch_args");

        assert!(result.args.iter().any(|arg| arg
            .contains("developer_instructions=\"## Yorishiro reminders\\n\\n- voice_say\"")));
        assert!(!result.args.iter().any(|arg| arg.starts_with("plugins.")));
    }

    #[test]
    fn codex_resume_false_does_not_emit_resume_command() {
        let ctx = make_ctx_with_resume(None, None, None, false);
        let result = CODEX.build_launch_args(&ctx).expect("build_launch_args");

        assert!(!result.args.iter().any(|arg| arg == "resume"));
        assert!(!result.args.iter().any(|arg| arg == "--last"));
        assert!(result
            .args
            .iter()
            .any(|arg| arg == &codex_yorishiro_mcp_config_arg(18743)));
    }

    #[test]
    fn codex_appends_prompt_reminder_after_system_prompt() {
        let ctx = make_ctx(None, Some("persona prompt"), Some("runtime reminder"));
        let result = CODEX.build_launch_args(&ctx).expect("build_launch_args");

        assert!(result
            .args
            .iter()
            .any(|arg| arg.contains("persona prompt\\n\\n---\\n\\nruntime reminder")));
    }
}
