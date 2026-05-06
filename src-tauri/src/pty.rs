use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::AppHandle;

use crate::sessions::{PtySession, SessionDescriptor, SessionKind, SessionRegistry, SpawnSpec};

/// Queue of hook signals for frontend polling (fallback when Tauri emit doesn't reach webview).
static HOOK_SIGNAL_QUEUE: std::sync::LazyLock<Mutex<Vec<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// Drain all queued hook signals. Called by the poll_hook_signals Tauri command.
pub fn drain_hook_signals() -> Vec<String> {
    if let Ok(mut q) = HOOK_SIGNAL_QUEUE.lock() {
        q.drain(..).collect()
    } else {
        Vec::new()
    }
}

// ─── Hook server ────────────────────────────────────────────────

pub(crate) const HOOK_SERVER_PORT: u16 = 19001;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

pub(crate) fn build_hooks_json(port: u16) -> String {
    // Each hook command: write to debug log AND curl the hook server
    let hook_cmd = |body: &str| -> String {
        format!(
            "echo '$(date +%H:%M:%S) {}' >> /tmp/charminal-hook-test.log; curl -s -m 1 -X POST -d '{}' http://127.0.0.1:{}/hook",
            body, body, port
        )
    };
    let hook_cmd_stdin = |endpoint: &str, label: &str| -> String {
        format!(
            "echo '$(date +%H:%M:%S) {}' >> /tmp/charminal-hook-test.log; cat | curl -s -m 1 -X POST -d @- http://127.0.0.1:{}{}",
            label, port, endpoint
        )
    };
    // UserPromptSubmit: just a generic prompt event for Perception.
    // `/charm` is handled by Claude Code's own custom-command pipeline
    // (bundled-packs/charminal-plugin/commands/charm.md loaded via --plugin-dir)
    // so no special detection or blocking is needed here anymore.
    let user_prompt_cmd = hook_cmd(r#"{\"event\":\"prompt\"}"#);
    format!(
        r#"{{
  "hooks": {{
    "UserPromptSubmit": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}],
    "PreToolUse": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}],
    "PostToolUse": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}],
    "PostToolUseFailure": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}],
    "Stop": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}]
  }}
}}"#,
        user_prompt_cmd,
        hook_cmd_stdin("/hook/pre-tool-use", "pre-tool-use"),
        hook_cmd_stdin("/hook/post-tool-use", "post-tool-use"),
        hook_cmd_stdin("/hook/post-tool-failure", "post-tool-failure"),
        hook_cmd(r#"{\"event\":\"stop\"}"#),
    )
}

/// Start a minimal HTTP server that receives hook signals from Claude Code.
/// Pushes each signal into `HOOK_SIGNAL_QUEUE` for frontend polling.
pub fn start_hook_server(_app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(format!("127.0.0.1:{}", HOOK_SERVER_PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!(
                    "[hook-server] Failed to bind port {}: {}",
                    HOOK_SERVER_PORT, e
                );
                return;
            }
        };
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = Vec::new();
            let mut tmp = [0u8; 8192];
            loop {
                match stream.read(&mut tmp) {
                    Ok(0) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&tmp[..n]);
                        if buf.len() > 512 * 1024 {
                            break;
                        }
                        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                            let hdr = String::from_utf8_lossy(&buf);
                            let content_len = hdr
                                .lines()
                                .find_map(|l| {
                                    let lower = l.to_ascii_lowercase();
                                    lower
                                        .strip_prefix("content-length:")
                                        .and_then(|v| v.trim().parse::<usize>().ok())
                                })
                                .unwrap_or(0);
                            if let Some(body_off) = hdr.find("\r\n\r\n").map(|p| p + 4) {
                                if buf.len() >= body_off + content_len {
                                    break;
                                }
                            }
                        }
                    }
                    Err(_) => break,
                }
            }
            let data = String::from_utf8_lossy(&buf);

            let path = data
                .lines()
                .next()
                .unwrap_or("")
                .split_whitespace()
                .nth(1)
                .unwrap_or("/");

            eprintln!(
                "[hook-server] path={} buf_len={} data_len={}",
                path,
                buf.len(),
                data.len()
            );

            if let Some(body_start) = data.find("\r\n\r\n") {
                let body = data[body_start + 4..].trim();
                eprintln!(
                    "[hook-server] body_len={} body_preview={}",
                    body.len(),
                    &body[..body.len().min(200)]
                );
                if !body.is_empty() {
                    let event_type = match path {
                        "/hook/pre-tool-use" => Some("pre-tool-use"),
                        "/hook/post-tool-use" => Some("post-tool-use"),
                        "/hook/post-tool-failure" => Some("post-tool-failure"),
                        "/hook" => None,
                        _ => None,
                    };

                    let final_body = if let Some(event) = event_type {
                        if let Ok(mut obj) = serde_json::from_str::<serde_json::Value>(body) {
                            if let Some(map) = obj.as_object_mut() {
                                map.insert("event".to_string(), serde_json::json!(event));
                                obj.to_string()
                            } else {
                                body.to_string()
                            }
                        } else {
                            body.to_string()
                        }
                    } else {
                        body.to_string()
                    };

                    // Push to polling queue — frontend drains via poll_hook_signals
                    if let Ok(mut q) = HOOK_SIGNAL_QUEUE.lock() {
                        q.push(final_body);
                    }
                }
            }
            let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
            let _ = stream.write_all(resp.as_bytes());
        }
    });
}

// ─── Session detection ──────────────────────────────────────────

/// Encode a resolved cwd into the project-dir name used by Claude Code.
///
/// Empirically, Claude Code stores per-project session state at
/// `~/.claude/projects/<encoded>/` where `<encoded>` is the canonicalized
/// cwd with `/` replaced by `-` (verified by inspecting actual entries —
/// e.g. a session opened at `/tmp/x` on macOS becomes `-private-tmp-x`,
/// confirming both symlink resolution and `/`→`-` substitution).
///
/// Returns `None` if the path can't be expressed as UTF-8. Windows uses
/// `\` and may also encode `:`; not handled here. The caller treats `None`
/// as "no session" — degraded but safe.
fn encode_project_dir_name(resolved: &std::path::Path) -> Option<String> {
    resolved.to_str().map(|s| s.replace('/', "-"))
}

/// True if Claude Code has an existing session for `cwd` that `-c` can resume.
///
/// Returns `false` on any error (missing HOME, can't canonicalize, non-UTF-8
/// path, etc.). The caller uses this to decide whether to pass `-c` to claude;
/// false → start fresh, which never errors.
pub(crate) fn has_existing_claude_session(cwd: Option<&str>) -> bool {
    let raw = match cwd {
        Some(c) => std::path::PathBuf::from(c),
        None => match std::env::current_dir() {
            Ok(p) => p,
            Err(_) => return false,
        },
    };

    // Claude Code resolves symlinks before deriving the project dir name.
    let Ok(resolved) = std::fs::canonicalize(&raw) else {
        return false;
    };

    let Some(encoded) = encode_project_dir_name(&resolved) else {
        return false;
    };

    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };

    std::path::PathBuf::from(home)
        .join(".claude")
        .join("projects")
        .join(encoded)
        .is_dir()
}

fn codex_session_file_matches_cwd(path: &std::path::Path, resolved_cwd: &std::path::Path) -> bool {
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

fn has_existing_codex_session_in(
    sessions_dir: &std::path::Path,
    resolved_cwd: &std::path::Path,
) -> bool {
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

/// True if Codex has an existing session for `cwd` that `resume --last` can use.
///
/// Codex stores JSONL rollouts under `~/.codex/sessions/YYYY/MM/DD/`. The first
/// line is `session_meta`, including `payload.cwd`; matching that keeps a fresh
/// workspace from failing on `codex resume --last`.
pub(crate) fn has_existing_codex_session(cwd: Option<&str>) -> bool {
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

    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };

    has_existing_codex_session_in(
        &std::path::PathBuf::from(home)
            .join(".codex")
            .join("sessions"),
        &resolved,
    )
}

pub(crate) fn toml_basic_string(value: &str) -> String {
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

// ─── PTY state (facade) ─────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct PtyExit {
    pub session_id: String,
    pub code: i32,
}

/// PtyState — `~/.charminal/` 1 つの window 全体の PTY ops を束ねる thin facade。
/// 内部状態は SessionRegistry に持たせ、ここでは default-session への delegation
/// だけを行う。Phase C で session 単位の操作が必要になった時点で legacy command
/// は削除し、`session_*` Tauri command に集約する。
pub struct PtyState {
    registry: Arc<SessionRegistry>,
}

impl PtyState {
    pub fn new(registry: Arc<SessionRegistry>) -> Self {
        Self { registry }
    }

    fn session_or_default(&self, id: &str) -> Option<Arc<PtySession>> {
        self.registry.get_pty_session(id)
    }

    /// 任意 session id で spawn する。同 id の既存 session があれば先に kill +
    /// remove する（replace semantics）。session_id = DEFAULT_SESSION_ID なら
    /// 従来の default-session 起動と同じ。
    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: AppHandle,
        session_id: &str,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        spec: &SpawnSpec,
        on_output: Channel,
    ) -> Result<(), String> {
        // 既存同 id session があれば kill + remove して replace。
        if let Some(existing) = self.session_or_default(session_id) {
            let _ = existing.kill();
        }
        self.registry.remove(session_id);

        let (profile_id, kind) = match spec {
            SpawnSpec::Agent { agent, .. } => match agent {
                AgentKind::Claude => ("claude", SessionKind::Agent),
                AgentKind::Codex => ("codex", SessionKind::Agent),
            },
            SpawnSpec::Shell { .. } => ("shell", SessionKind::Shell),
        };
        self.registry.add(SessionDescriptor {
            id: session_id.to_string(),
            profile_id: profile_id.to_string(),
            kind,
            label: profile_id.to_string(),
            cwd: cwd.clone(),
            started_at: now_millis(),
        });

        let session = Arc::new(PtySession::new(
            session_id.to_string(),
            Arc::clone(&self.registry),
        ));
        if let Err(e) = session.spawn(app, cols, rows, cwd, spec, on_output) {
            self.registry.remove(session_id);
            return Err(e);
        }
        self.registry.attach_pty(session_id, session);
        Ok(())
    }

    pub fn attach(&self, session_id: &str, cwd: Option<String>, on_output: Channel) -> bool {
        let Some(session) = self.session_or_default(session_id) else {
            return false;
        };
        session.attach(cwd, on_output)
    }

    pub fn detach(&self, session_id: &str) {
        if let Some(session) = self.session_or_default(session_id) {
            session.detach();
        }
    }

    pub fn write_data(&self, session_id: &str, data: &str) -> Result<(), String> {
        let Some(session) = self.session_or_default(session_id) else {
            return Ok(());
        };
        session.write_data(data)
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let Some(session) = self.session_or_default(session_id) else {
            return Ok(());
        };
        session.resize(cols, rows)
    }

    pub fn kill(&self, session_id: &str) -> Result<(), String> {
        if let Some(session) = self.session_or_default(session_id) {
            let _ = session.kill();
        }
        self.registry.remove(session_id);
        Ok(())
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_project_dir_name_basic() {
        assert_eq!(
            encode_project_dir_name(std::path::Path::new("/Users/foo/Charminal")),
            Some("-Users-foo-Charminal".to_string())
        );
    }

    #[test]
    fn encode_project_dir_name_preserves_dots() {
        // Claude Code does not escape `.`; verified against actual entries.
        assert_eq!(
            encode_project_dir_name(std::path::Path::new("/Users/foo/.config/app")),
            Some("-Users-foo-.config-app".to_string())
        );
    }

    #[test]
    fn encode_project_dir_name_root() {
        assert_eq!(
            encode_project_dir_name(std::path::Path::new("/")),
            Some("-".to_string())
        );
    }

    #[test]
    fn has_existing_claude_session_false_for_nonexistent_cwd() {
        // canonicalize fails on a path that doesn't exist → safe default.
        assert!(!has_existing_claude_session(Some(
            "/charminal/definitely/not/a/real/path/xyz"
        )));
    }

    #[test]
    fn has_existing_claude_session_false_for_unrelated_tmp_dir() {
        // A freshly-created tempdir has no Claude Code session, so even
        // though canonicalize succeeds, the lookup must return false.
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
    fn codex_session_file_matches_cwd_from_session_meta() {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-codex-session-test-{}-{}",
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
            "charminal-codex-session-tree-test-{}-{}",
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
    fn build_hooks_json_valid() {
        let json = build_hooks_json(19001);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("should be valid JSON");
        let hooks = parsed["hooks"].as_object().expect("should have hooks");
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(hooks.contains_key("PreToolUse"));
        assert!(hooks.contains_key("PostToolUseFailure"));
        assert!(hooks.contains_key("Stop"));
    }
}
