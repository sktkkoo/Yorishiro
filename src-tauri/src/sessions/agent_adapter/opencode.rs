use serde_json::{Map, Value};

use super::{AgentCapabilities, AgentThemeRefresh, LaunchArgs, LaunchContext, TerminalAgent};

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
            plugins: true,
            lifecycle_hooks: false,
            session_resume: false,
        }
    }

    fn build_launch_args(&self, ctx: &LaunchContext<'_>) -> Result<LaunchArgs, String> {
        let args = Vec::new();
        let mut env = Vec::new();
        let mut temp_files = Vec::new();
        let commands = opencode_charminal_commands(ctx.plugin_dir)?;

        // OpenCode の runtime config は session-scoped 注入経路として env var に渡す。
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

        if let Some(commands) = commands {
            config_obj["command"] = Value::Object(commands);
        }

        if let Some(prompt) = ctx.system_prompt {
            let persona_path = super::temp_config_path("opencode-persona", "md");
            let persona_path_arg = super::utf8_path_for_cli(&persona_path, "OpenCode persona")?;
            std::fs::write(&persona_path, prompt)
                .map_err(|e| format!("Failed to write opencode persona: {}", e))?;
            let persona_ref = format!("{{file:{}}}", persona_path_arg);
            let agent_prompt = serde_json::json!({ "prompt": persona_ref });
            config_obj["agent"] = serde_json::json!({
                "build": agent_prompt.clone(),
                "plan": agent_prompt,
            });
            temp_files.push(persona_path);
        }

        let tui_config_path = super::temp_config_path("opencode-tui", "json");
        let tui_config_path_arg =
            match super::utf8_path_for_cli(&tui_config_path, "OpenCode TUI config") {
                Ok(path) => path,
                Err(err) => {
                    for path in &temp_files {
                        let _ = std::fs::remove_file(path);
                    }
                    return Err(err);
                }
            };
        let tui_config = serde_json::json!({
            "$schema": "https://opencode.ai/tui.json",
            "theme": "system",
        });
        std::fs::write(&tui_config_path, format!("{}\n", tui_config)).map_err(|e| {
            for path in &temp_files {
                let _ = std::fs::remove_file(path);
            }
            format!("Failed to write opencode TUI config: {}", e)
        })?;
        env.push(("OPENCODE_TUI_CONFIG".to_string(), tui_config_path_arg));
        temp_files.push(tui_config_path);

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

    fn theme_refresh(&self) -> Option<AgentThemeRefresh> {
        Some(AgentThemeRefresh::Sigusr2)
    }
}

fn parse_command_markdown(content: &str) -> (String, String) {
    let mut description = String::new();
    let mut in_frontmatter = false;
    let mut frontmatter_end = 0;

    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if i == 0 && trimmed == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
                frontmatter_end = i;
                continue;
            }
            if let Some(desc) = trimmed.strip_prefix("description:") {
                description = desc.trim().trim_matches('"').to_string();
            }
        }
    }

    let lines_vec: Vec<&str> = content.lines().collect();
    let mut body_start = if frontmatter_end > 0 {
        frontmatter_end + 1
    } else {
        0
    };
    while body_start < lines_vec.len() {
        let trimmed = lines_vec[body_start].trim();
        if trimmed.is_empty() || trimmed == "$ARGUMENTS" || trimmed == "---" {
            body_start += 1;
        } else {
            break;
        }
    }

    (description, lines_vec[body_start..].join("\n"))
}

fn rewrite_charm_slash_commands(input: &str) -> String {
    let mut out = input.to_string();
    for (slash, command) in [
        ("/charm:create", "/charm-create"),
        ("/charm:update", "/charm-update"),
        ("/charm:help", "/charm-help"),
        ("/charm:shortcut", "/charm-shortcut"),
        ("/charm:tutorial", "/charm-tutorial"),
        ("/charm:*", "/charm-*"),
    ] {
        out = out.replace(slash, command);
    }
    out
}

fn opencode_command_config(content: &str, command_name: &str) -> Value {
    let (description, body) = parse_command_markdown(content);
    let body = rewrite_charm_slash_commands(&body);
    let template = format!("$ARGUMENTS\n\n---\n\n{}", body);

    serde_json::json!({
        "template": template,
        "description": if description.is_empty() {
            format!("Charminal {}", command_name)
        } else {
            description
        },
    })
}

fn opencode_charminal_commands(
    plugin_dir: Option<&std::path::Path>,
) -> Result<Option<Map<String, Value>>, String> {
    let Some(plugin_dir) = plugin_dir else {
        return Ok(None);
    };
    let commands_dir = plugin_dir.join("commands");
    if !commands_dir.is_dir() {
        return Ok(None);
    }

    let mut commands = Map::new();
    for entry in std::fs::read_dir(&commands_dir)
        .map_err(|e| format!("read OpenCode command dir failed: {}", e))?
    {
        let path = entry
            .map_err(|e| format!("read OpenCode command dir entry failed: {}", e))?
            .path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let Some(command_name) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read OpenCode command {} failed: {}", path.display(), e))?;
        commands.insert(
            format!("charm-{}", command_name),
            opencode_command_config(&content, command_name),
        );
    }

    if commands.is_empty() {
        Ok(None)
    } else {
        Ok(Some(commands))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::path::{Path, PathBuf};

    fn make_ctx<'a>(
        cwd: Option<&'a Path>,
        system_prompt: Option<&'a str>,
        plugin_dir: Option<&'a Path>,
    ) -> LaunchContext<'a> {
        LaunchContext {
            cwd,
            system_prompt,
            plugin_dir,
            mcp_port: 18743,
            hook_port: 19001,
        }
    }

    fn cleanup_temp_files(result: &LaunchArgs) {
        for path in &result.temp_files {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn opencode_capabilities_declares_plugins_no_hooks_no_resume() {
        let caps = OPENCODE.capabilities();
        assert!(caps.persona_overlay);
        assert!(caps.mcp_injection);
        assert!(caps.plugins);
        assert!(!caps.lifecycle_hooks);
        assert!(!caps.session_resume);
    }

    #[test]
    fn opencode_uses_process_cwd_without_dir_arg() {
        let cwd = Path::new("/tmp/some-cwd");
        let ctx = make_ctx(Some(cwd), None, None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        assert!(!result.args.iter().any(|a| a == "--dir"));
        assert!(!result.args.iter().any(|a| a == "/tmp/some-cwd"));
        cleanup_temp_files(&result);
    }

    #[test]
    fn opencode_sets_system_tui_theme_via_temp_config() {
        let ctx = make_ctx(None, None, None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        let (_, path_str) = result
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_TUI_CONFIG")
            .expect("OPENCODE_TUI_CONFIG env present");
        let tui_path = Path::new(path_str);

        assert!(tui_path.exists(), "TUI config file should exist");
        let contents = std::fs::read_to_string(tui_path).expect("read TUI config");
        let parsed: Value = serde_json::from_str(&contents).expect("valid TUI config json");
        assert_eq!(parsed["$schema"], "https://opencode.ai/tui.json");
        assert_eq!(parsed["theme"], "system");
        assert!(result.temp_files.contains(&tui_path.to_path_buf()));

        cleanup_temp_files(&result);
    }

    #[test]
    fn opencode_omits_dir_when_cwd_missing() {
        let ctx = make_ctx(None, None, None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        assert!(!result.args.iter().any(|a| a == "--dir"));
        cleanup_temp_files(&result);
    }

    #[test]
    fn opencode_injects_mcp_via_opencode_config_content_env() {
        let ctx = make_ctx(None, None, None);
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
        cleanup_temp_files(&result);
    }

    #[test]
    fn opencode_injects_persona_as_primary_agent_prompts() {
        let ctx = make_ctx(None, Some("住人としての気質を保つ"), None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");

        let (_, json_str) = result
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("OPENCODE_CONFIG_CONTENT present");
        let parsed: Value = serde_json::from_str(json_str).expect("valid json");

        let build_prompt = parsed["agent"]["build"]["prompt"]
            .as_str()
            .expect("build prompt is string");
        let plan_prompt = parsed["agent"]["plan"]["prompt"]
            .as_str()
            .expect("plan prompt is string");
        assert_eq!(build_prompt, plan_prompt);

        let persona_path_str = build_prompt
            .strip_prefix("{file:")
            .and_then(|s| s.strip_suffix('}'))
            .expect("prompt uses opencode file reference");
        let persona_path = Path::new(persona_path_str);

        assert!(persona_path.exists(), "persona file should exist");
        let contents = std::fs::read_to_string(persona_path).expect("read persona");
        assert_eq!(contents, "住人としての気質を保つ");

        assert!(result.temp_files.contains(&persona_path.to_path_buf()));
        assert!(parsed.get("instructions").is_none() || parsed["instructions"].is_null());

        cleanup_temp_files(&result);
    }

    #[test]
    fn opencode_omits_agent_prompt_when_no_persona() {
        let ctx = make_ctx(None, None, None);
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        let (_, json_str) = result
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("env present");
        let parsed: Value = serde_json::from_str(json_str).expect("valid json");
        assert!(parsed.get("agent").is_none() || parsed["agent"].is_null());
        cleanup_temp_files(&result);
    }

    fn fresh_plugin_dir(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-opencode-commands-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("commands")).expect("create commands dir");
        tmp
    }

    #[test]
    fn opencode_injects_charminal_commands_via_config_content() {
        let plugin_dir = fresh_plugin_dir("basic");
        std::fs::write(
            plugin_dir.join("commands").join("create.md"),
            "---\ndescription: Create a new pack\n---\n\n$ARGUMENTS\n\n---\n\nCreate the requested pack.",
        )
        .expect("write command");

        let ctx = make_ctx(None, None, Some(&plugin_dir));
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        let (_, json_str) = result
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("env present");
        let parsed: Value = serde_json::from_str(json_str).expect("valid json");
        let command = &parsed["command"]["charm-create"];

        assert_eq!(command["description"], "Create a new pack");
        assert!(command["template"]
            .as_str()
            .unwrap()
            .starts_with("$ARGUMENTS"));
        assert!(command["template"]
            .as_str()
            .unwrap()
            .contains("Create the requested pack."));

        cleanup_temp_files(&result);
        let _ = std::fs::remove_dir_all(&plugin_dir);
    }

    #[test]
    fn opencode_command_templates_rewrite_charm_refs() {
        let plugin_dir = fresh_plugin_dir("rewrite");
        std::fs::write(
            plugin_dir.join("commands").join("help.md"),
            "---\ndescription: Help\n---\n\n$ARGUMENTS\n\n---\n\nUse /charm:create, /charm:update, or /charm:*.",
        )
        .expect("write command");

        let ctx = make_ctx(None, None, Some(&plugin_dir));
        let result = OPENCODE.build_launch_args(&ctx).expect("build_launch_args");
        let (_, json_str) = result
            .env
            .iter()
            .find(|(k, _)| k == "OPENCODE_CONFIG_CONTENT")
            .expect("env present");
        let parsed: Value = serde_json::from_str(json_str).expect("valid json");
        let template = parsed["command"]["charm-help"]["template"]
            .as_str()
            .expect("template string");

        assert!(template.contains("/charm-create"));
        assert!(template.contains("/charm-update"));
        assert!(template.contains("/charm-*"));
        assert!(!template.contains("/charm:create"));

        cleanup_temp_files(&result);
        let _ = std::fs::remove_dir_all(&plugin_dir);
    }
}
