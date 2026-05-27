use super::{AgentCapabilities, LaunchArgs, LaunchContext, TerminalAgent};

pub struct OpencodeAgent;
pub static OPENCODE: OpencodeAgent = OpencodeAgent;

impl TerminalAgent for OpencodeAgent {
    fn id(&self) -> &'static str {
        "opencode"
    }

    fn display_name(&self) -> &'static str {
        "OpenCode"
    }

    fn binary_name(&self) -> &'static str {
        "opencode"
    }

    fn capabilities(&self) -> AgentCapabilities {
        AgentCapabilities {
            persona_overlay: true,
            mcp_injection: true,
            plugins: false,
            lifecycle_hooks: false,
            session_resume: false,
        }
    }

    fn build_launch_args(&self, ctx: &LaunchContext<'_>) -> Result<LaunchArgs, String> {
        let mut args = Vec::new();
        let mut env = Vec::new();
        let mut temp_files = Vec::new();

        if let Some(cwd) = ctx.cwd {
            args.push("--dir".to_string());
            args.push(super::utf8_path_for_cli(cwd, "OpenCode cwd")?);
        }

        // OpenCode の session-scoped 注入経路として env var に inline JSON を渡す。
        // project-local opencode.json との deep-merge は v2 scope。
        let mut config_obj = serde_json::json!({
            "$schema": "https://opencode.ai/config.json",
            "mcp": {
                "charminal": {
                    "type": "remote",
                    "url": format!("http://127.0.0.1:{}/mcp", ctx.mcp_port),
                    "enabled": true,
                }
            }
        });

        if let Some(prompt) = ctx.system_prompt {
            let persona_path = super::temp_config_path("opencode-persona", "md");
            let persona_path_arg = super::utf8_path_for_cli(&persona_path, "OpenCode persona")?;
            std::fs::write(&persona_path, prompt)
                .map_err(|e| format!("Failed to write opencode persona: {}", e))?;
            config_obj["instructions"] = serde_json::json!([persona_path_arg]);
            temp_files.push(persona_path);
        }

        env.push((
            "OPENCODE_CONFIG_CONTENT".to_string(),
            config_obj.to_string(),
        ));

        Ok(LaunchArgs {
            args,
            env,
            temp_files,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::Path;

    fn make_ctx<'a>(cwd: Option<&'a Path>, system_prompt: Option<&'a str>) -> LaunchContext<'a> {
        LaunchContext {
            cwd,
            system_prompt,
            plugin_dir: None,
            mcp_port: 18743,
            hook_port: 19001,
        }
    }

    #[test]
    fn opencode_capabilities_declares_no_plugins_no_hooks_no_resume() {
        let caps = OPENCODE.capabilities();
        assert!(caps.persona_overlay);
        assert!(caps.mcp_injection);
        assert!(!caps.plugins);
        assert!(!caps.lifecycle_hooks);
        assert!(!caps.session_resume);
    }

    #[test]
    fn opencode_build_launch_args_includes_dir_when_cwd_set() {
        let cwd = Path::new("/tmp/some-cwd");
        let ctx = make_ctx(Some(cwd), None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        let pair = result
            .args
            .windows(2)
            .find(|w| w[0] == "--dir")
            .expect("--dir present");
        assert_eq!(pair[1], "/tmp/some-cwd");
    }

    #[test]
    fn opencode_omits_dir_when_cwd_missing() {
        let ctx = make_ctx(None, None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        assert!(!result.args.iter().any(|a| a == "--dir"));
    }

    #[cfg(unix)]
    #[test]
    fn opencode_rejects_non_utf8_cwd() {
        use std::ffi::OsStr;
        use std::os::unix::ffi::OsStrExt;

        let cwd = Path::new(OsStr::from_bytes(b"/tmp/charminal-\xFF"));
        let ctx = make_ctx(Some(cwd), None);
        let err = match OPENCODE.build_launch_args(&ctx) {
            Ok(_) => panic!("non-UTF-8 cwd should error"),
            Err(err) => err,
        };
        assert!(err.contains("OpenCode cwd path is not valid UTF-8"));
    }

    #[test]
    fn opencode_injects_mcp_via_opencode_config_content_env() {
        let ctx = make_ctx(None, None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        let (_, json_str) = result
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("OPENCODE_CONFIG_CONTENT env present");
        let parsed: Value = serde_json::from_str(json_str).expect("valid json");
        let charminal_mcp = &parsed["mcp"]["charminal"];
        assert_eq!(charminal_mcp["type"], "remote");
        assert_eq!(charminal_mcp["url"], "http://127.0.0.1:18743/mcp");
        assert_eq!(charminal_mcp["enabled"], true);
    }

    #[test]
    fn opencode_includes_persona_via_instructions_temp_file() {
        let ctx = make_ctx(None, Some("住人としての気質を保つ"));
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");

        let (_, json_str) = result
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("OPENCODE_CONFIG_CONTENT present");
        let parsed: Value = serde_json::from_str(json_str).expect("valid json");

        let instructions = parsed["instructions"]
            .as_array()
            .expect("instructions is array");
        assert_eq!(instructions.len(), 1);
        let persona_path_str = instructions[0].as_str().expect("path is string");
        let persona_path = Path::new(persona_path_str);

        assert!(persona_path.exists(), "persona file should exist");
        let contents = std::fs::read_to_string(persona_path).expect("read persona");
        assert_eq!(contents, "住人としての気質を保つ");

        assert!(result.temp_files.contains(&persona_path.to_path_buf()));

        let _ = std::fs::remove_file(persona_path);
    }

    #[test]
    fn opencode_omits_instructions_when_no_persona() {
        let ctx = make_ctx(None, None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        let (_, json_str) = result
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("env present");
        let parsed: Value = serde_json::from_str(json_str).expect("valid json");
        assert!(parsed.get("instructions").is_none() || parsed["instructions"].is_null());
    }
}
