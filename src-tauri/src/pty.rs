use serde::Serialize;
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

fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn build_hook_command(port: u16, body: &str, windows: bool) -> String {
    if windows {
        format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Method Post -Uri {} -Body {} | Out-Null\"",
            powershell_single_quote(&format!("http://127.0.0.1:{}/hook", port)),
            powershell_single_quote(body),
        )
    } else {
        format!(
            "curl -s -m 1 -X POST -d {} {}",
            sh_single_quote(body),
            sh_single_quote(&format!("http://127.0.0.1:{}/hook", port)),
        )
    }
}

fn build_hook_stdin_command(port: u16, endpoint: &str, windows: bool) -> String {
    let url = format!("http://127.0.0.1:{}{}", port, endpoint);
    if windows {
        format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"$body = [Console]::In.ReadToEnd(); Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 -Method Post -Uri {} -Body $body | Out-Null\"",
            powershell_single_quote(&url),
        )
    } else {
        format!("cat | curl -s -m 1 -X POST -d @- {}", sh_single_quote(&url),)
    }
}

pub(crate) fn build_hooks_json(port: u16) -> String {
    let windows = cfg!(windows);

    let reminder_script = build_reminder_script_path();
    let python = if windows { "python" } else { "python3" };
    let reminder_cmd = if windows {
        format!("{} \"{}\"", python, reminder_script.replace('\\', "\\\\"))
    } else {
        format!("{} {}", python, sh_single_quote(&reminder_script))
    };

    serde_json::json!({
        "hooks": {
            "UserPromptSubmit": [{
                "matcher": "",
                "hooks": [
                    { "type": "command", "command": build_hook_command(port, r#"{"event":"prompt"}"#, windows) },
                    { "type": "command", "command": reminder_cmd }
                ]
            }],
            "PreToolUse": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/pre-tool-use", windows) }]
            }],
            "PostToolUse": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/post-tool-use", windows) }]
            }],
            "PostToolUseFailure": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/post-tool-failure", windows) }]
            }],
            "Stop": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_command(port, r#"{"event":"stop"}"#, windows) }]
            }],
        }
    })
    .to_string()
}

/// Reminder script のパスを返す。script は ensure_reminder_script() で配置。
fn build_reminder_script_path() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    home.join(".charminal")
        .join("shell")
        .join("hook-reminder.py")
        .to_string_lossy()
        .to_string()
}

/// Reminder script を ~/.charminal/shell/ に配置する。起動時に呼ぶ。
pub fn ensure_reminder_script() -> Result<(), String> {
    let home = dirs::home_dir().ok_or("home directory not found")?;
    let dir = home.join(".charminal").join("shell");
    std::fs::create_dir_all(&dir).map_err(|e| format!("shell ディレクトリの作成に失敗: {e}"))?;

    let script_path = dir.join("hook-reminder.py");
    let script = r#"import json, os, sys

config_path = os.path.join(os.path.expanduser("~"), ".charminal", "config.json")
reminders = []

try:
    with open(config_path, encoding="utf-8") as f:
        config = json.load(f)
except Exception:
    config = {}

if config.get("journalReminder", "on") != "off":
    reminders.append("印象があれば journal_write。[感触/記憶/物語]")

if config.get("voiceFrequency", "on") != "off":
    reminders.append("応答の要点を voice_say で声に出す。声が先。")

if not reminders:
    sys.exit(0)

ctx = "\\n".join(reminders)
print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ctx}}, ensure_ascii=False))
"#;

    std::fs::write(&script_path, script)
        .map_err(|e| format!("reminder script の書き込みに失敗: {e}"))?;
    Ok(())
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
        // suppress_exit で reader thread の pty-exit emit を抑制し、
        // JS 側の auto-respawn が誤発火しないようにする。
        if let Some(existing) = self.session_or_default(session_id) {
            existing.suppress_exit();
            let _ = existing.kill();
        }
        self.registry.remove(session_id);

        let (profile_id, kind) = match spec {
            SpawnSpec::Agent { agent, .. } => (agent.as_str(), SessionKind::Agent),
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
        let Some(descriptor) = self.registry.get(session_id) else {
            return false;
        };
        if !can_attach_existing_session(&descriptor) {
            return false;
        }
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

    pub fn refresh_theme(&self, session_id: &str) -> Result<(), String> {
        let Some(descriptor) = self.registry.get(session_id) else {
            return Ok(());
        };
        if !matches!(descriptor.kind, SessionKind::Agent) {
            return Ok(());
        }
        let Some(adapter) = crate::sessions::agent_adapter::lookup(&descriptor.profile_id) else {
            return Ok(());
        };
        let Some(refresh) = adapter.theme_refresh() else {
            return Ok(());
        };
        let Some(session) = self.session_or_default(session_id) else {
            return Ok(());
        };
        session.refresh_agent_theme(refresh)
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

fn can_attach_existing_session(descriptor: &SessionDescriptor) -> bool {
    match descriptor.kind {
        SessionKind::Shell => true,
        // WebView reload 後の attach は既存 PTY の画面状態を replay するだけなので、
        // resume 非対応 agent（OpenCode の full-screen TUI など）は fresh spawn に落とす。
        SessionKind::Agent => crate::sessions::agent_adapter::lookup(&descriptor.profile_id)
            .map(|adapter| adapter.capabilities().session_resume)
            .unwrap_or(false),
    }
}

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor(profile_id: &str, kind: SessionKind) -> SessionDescriptor {
        SessionDescriptor {
            id: format!("session-{profile_id}"),
            profile_id: profile_id.to_string(),
            kind,
            label: profile_id.to_string(),
            cwd: None,
            started_at: 0,
        }
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

    #[test]
    fn build_windows_hook_commands_use_powershell() {
        let prompt = build_hook_command(19001, r#"{"event":"prompt"}"#, true);
        assert!(prompt.contains("powershell.exe"));
        assert!(prompt.contains("Invoke-WebRequest"));
        assert!(prompt.contains("http://127.0.0.1:19001/hook"));

        let stdin = build_hook_stdin_command(19001, "/hook/pre-tool-use", true);
        assert!(stdin.contains("[Console]::In.ReadToEnd()"));
        assert!(stdin.contains("http://127.0.0.1:19001/hook/pre-tool-use"));
    }

    #[test]
    fn attach_allowed_for_shell_sessions() {
        assert!(can_attach_existing_session(&descriptor(
            "shell",
            SessionKind::Shell
        )));
    }

    #[test]
    fn attach_allowed_for_resume_capable_agents() {
        assert!(can_attach_existing_session(&descriptor(
            "claude",
            SessionKind::Agent
        )));
        assert!(can_attach_existing_session(&descriptor(
            "codex",
            SessionKind::Agent
        )));
    }

    #[test]
    fn attach_rejected_for_opencode_because_session_resume_is_unsupported() {
        assert!(!can_attach_existing_session(&descriptor(
            "opencode",
            SessionKind::Agent
        )));
    }

    #[test]
    fn attach_rejected_for_unknown_agent_profiles() {
        assert!(!can_attach_existing_session(&descriptor(
            "unknown-agent",
            SessionKind::Agent
        )));
    }
}
