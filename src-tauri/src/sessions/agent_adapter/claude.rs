use std::path::Path;

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

        if self.has_existing_session(ctx.cwd) {
            args.push("-c".to_string());
        }

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

    fn has_existing_session(&self, cwd: Option<&Path>) -> bool {
        has_existing_claude_session(cwd.and_then(|p| p.to_str()))
    }
}

fn claude_charminal_mcp_config_json(port: u16) -> String {
    serde_json::json!({
        "mcpServers": {
            "yorishiro": {
                "type": "http",
                "url": format!("http://127.0.0.1:{}/mcp", port),
            }
        }
    })
    .to_string()
}

/// Claude Code が project dir 名に使う形式へ、canonicalize 済み cwd を encode する。
///
/// 実測では Claude Code は per-project session state を
/// `~/.claude/projects/<encoded>/` に置く。`<encoded>` は canonicalize 済み
/// cwd の path separator を `-` に置換したもの。Windows drive separator も
/// 置換し、`Path::join` に absolute path と解釈されないようにする。
fn encode_project_dir_name(resolved: &Path) -> Option<String> {
    let mut path = resolved.to_str()?.to_string();
    if let Some(stripped) = path.strip_prefix(r"\\?\UNC\") {
        path = format!(r"\\{}", stripped);
    } else if let Some(stripped) = path.strip_prefix(r"\\?\") {
        path = stripped.to_string();
    }
    Some(path.replace(['/', '\\', ':'], "-"))
}

/// `cwd` に対応する Claude Code 既存 session があり、`-c` で resume できるなら true。
///
/// HOME 不在、canonicalize 失敗、非 UTF-8 path などの error はすべて false。
/// 呼び出し側は false の場合 fresh session を起動するので、degraded だが安全。
fn has_existing_claude_session(cwd: Option<&str>) -> bool {
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

    let Some(encoded) = encode_project_dir_name(&resolved) else {
        return false;
    };

    let Some(home) = dirs::home_dir() else {
        return false;
    };

    home.join(".claude").join("projects").join(encoded).is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_project_dir_name_basic() {
        assert_eq!(
            encode_project_dir_name(Path::new("/Users/foo/Charminal")),
            Some("-Users-foo-Charminal".to_string())
        );
    }

    #[test]
    fn encode_project_dir_name_preserves_dots() {
        // Claude Code は `.` を escape しない。実際の entries に合わせる。
        assert_eq!(
            encode_project_dir_name(Path::new("/Users/foo/.config/app")),
            Some("-Users-foo-.config-app".to_string())
        );
    }

    #[test]
    fn encode_project_dir_name_root() {
        assert_eq!(
            encode_project_dir_name(Path::new("/")),
            Some("-".to_string())
        );
    }

    #[test]
    fn encode_project_dir_name_windows_path_is_relative_safe() {
        assert_eq!(
            encode_project_dir_name(Path::new(r"C:\Users\foo\Charminal")),
            Some("C--Users-foo-Charminal".to_string())
        );
    }

    #[test]
    fn encode_project_dir_name_strips_windows_verbatim_prefix() {
        assert_eq!(
            encode_project_dir_name(Path::new(r"\\?\C:\Users\foo\Charminal")),
            Some("C--Users-foo-Charminal".to_string())
        );
    }

    #[test]
    fn has_existing_claude_session_false_for_nonexistent_cwd() {
        // 存在しない path は canonicalize に失敗するため safe default。
        assert!(!has_existing_claude_session(Some(
            "/charminal/definitely/not/a/real/path/xyz"
        )));
    }

    #[test]
    fn has_existing_claude_session_false_for_unrelated_tmp_dir() {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-session-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).expect("create tempdir");
        let path_str = tmp.to_str().expect("tmp path utf8").to_string();
        let result = has_existing_claude_session(Some(&path_str));
        let _ = std::fs::remove_dir(&tmp);
        assert!(!result, "fresh tempdir should not have a Claude session");
    }

    #[test]
    fn claude_charminal_mcp_config_json_points_to_streamable_http_server() {
        let parsed: serde_json::Value =
            serde_json::from_str(&claude_charminal_mcp_config_json(18744)).expect("valid json");
        assert_eq!(
            parsed["mcpServers"]["yorishiro"]["url"],
            "http://127.0.0.1:18744/mcp"
        );
        assert_eq!(parsed["mcpServers"]["yorishiro"]["type"], "http");
    }
}
