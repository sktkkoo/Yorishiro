use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter};

use crate::sessions::{
    AttachResult, PtySession, SessionDescriptor, SessionKind, SessionRegistry, SpawnSpec,
};

/// Queue of hook signals for frontend polling (fallback when Tauri emit doesn't reach webview).
static HOOK_SIGNAL_QUEUE: std::sync::LazyLock<Mutex<Vec<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// Monotonic id stamped on every hook signal. Frontend dedups by this so the
/// immediate Tauri-event path and the polling fallback never double-process the
/// same signal (which could resurrect already-cleared state).
static HOOK_SEQ: AtomicU64 = AtomicU64::new(1);

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
            "SessionStart": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/session-start", windows) }]
            }],
            "UserPromptSubmit": [{
                "matcher": "",
                "hooks": [
                    { "type": "command", "command": build_hook_stdin_command(port, "/hook/prompt", windows) },
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
            "PostToolBatch": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/post-tool-batch", windows) }]
            }],
            "Stop": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/stop", windows) }]
            }],
            "StopFailure": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/stop-failure", windows) }]
            }],
            "Notification": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/notification", windows) }]
            }],
            "PermissionRequest": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/permission-request", windows) }]
            }],
            "PermissionDenied": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/permission-denied", windows) }]
            }],
            "SubagentStart": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/subagent-start", windows) }]
            }],
            "SubagentStop": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/subagent-stop", windows) }]
            }],
            "TaskCreated": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/task-created", windows) }]
            }],
            "TaskCompleted": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/task-completed", windows) }]
            }],
            "PreCompact": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/pre-compact", windows) }]
            }],
            "PostCompact": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/post-compact", windows) }]
            }],
            "Elicitation": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/elicitation", windows) }]
            }],
            "ElicitationResult": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/elicitation-result", windows) }]
            }],
            "SessionEnd": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": build_hook_stdin_command(port, "/hook/session-end", windows) }]
            }],
        }
    })
    .to_string()
}

/// Reminder script のパスを返す。script は ensure_reminder_script() で配置。
fn build_reminder_script_path() -> String {
    crate::yorishiro_home_path()
        .unwrap_or_default()
        .join("shell")
        .join("hook-reminder.py")
        .to_string_lossy()
        .to_string()
}

/// Reminder script を ~/.yorishiro/shell/ に配置する。起動時に呼ぶ。
pub fn ensure_reminder_script() -> Result<(), String> {
    let dir = crate::yorishiro_home_path()?.join("shell");
    std::fs::create_dir_all(&dir).map_err(|e| format!("shell ディレクトリの作成に失敗: {e}"))?;

    let script_path = dir.join("hook-reminder.py");
    let script = r#"import json, os, sys

config_path = os.path.join(os.path.expanduser("~"), ".yorishiro", "config.json")
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
/// Emits each signal to the WebView immediately and also pushes it into
/// `HOOK_SIGNAL_QUEUE` as polling fallback.
pub fn start_hook_server(app: AppHandle) {
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
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            std::thread::spawn(move || handle_hook_stream(app, stream));
        }
    });
}

fn split_path_query(raw_path: &str) -> (&str, Option<&str>) {
    match raw_path.split_once('?') {
        Some((path, query)) => (path, Some(query)),
        None => (raw_path, None),
    }
}

fn query_param(query: Option<&str>, key: &str) -> Option<String> {
    let query = query?;
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            let decoded = percent_decode_query(v);
            if !decoded.is_empty() {
                return Some(decoded);
            }
        }
    }
    None
}

fn percent_decode_query(value: &str) -> String {
    let mut out = Vec::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let h1 = (bytes[i + 1] as char).to_digit(16);
                let h2 = (bytes[i + 2] as char).to_digit(16);
                if let (Some(h1), Some(h2)) = (h1, h2) {
                    out.push(((h1 << 4) | h2) as u8);
                    i += 3;
                } else {
                    out.push(bytes[i]);
                    i += 1;
                }
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn handle_hook_stream(app: AppHandle, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
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

    let raw_path = data
        .lines()
        .next()
        .unwrap_or("")
        .split_whitespace()
        .nth(1)
        .unwrap_or("/");
    let (path, query) = split_path_query(raw_path);
    let session_id = query_param(query, "sessionId");
    let agent = query_param(query, "agent");

    if let Some(body_start) = data.find("\r\n\r\n") {
        let body = data[body_start + 4..].trim();
        if !body.is_empty() {
            let event_type = match path {
                "/hook/prompt" => Some("prompt"),
                "/hook/stop" => Some("stop"),
                "/hook/stop-failure" => Some("stop-failure"),
                "/hook/session-start" => Some("session-start"),
                "/hook/session-end" => Some("session-end"),
                "/hook/pre-tool-use" => Some("pre-tool-use"),
                "/hook/post-tool-use" => Some("post-tool-use"),
                "/hook/post-tool-failure" => Some("post-tool-failure"),
                "/hook/post-tool-batch" => Some("post-tool-batch"),
                "/hook/notification" => Some("notification"),
                "/hook/permission-request" => Some("permission-request"),
                "/hook/permission-denied" => Some("permission-denied"),
                "/hook/subagent-start" => Some("subagent-start"),
                "/hook/subagent-stop" => Some("subagent-stop"),
                "/hook/task-created" => Some("task-created"),
                "/hook/task-completed" => Some("task-completed"),
                "/hook/pre-compact" => Some("pre-compact"),
                "/hook/post-compact" => Some("post-compact"),
                "/hook/elicitation" => Some("elicitation"),
                "/hook/elicitation-result" => Some("elicitation-result"),
                "/hook" => None,
                _ => None,
            };

            // 同一 signal を immediate event と polling fallback の両方で配るので、
            // monotonic な _yorishiro_seq を必ず載せて frontend が 1 回だけ処理できるようにする。
            let seq = HOOK_SEQ.fetch_add(1, Ordering::Relaxed);
            let final_body = match serde_json::from_str::<serde_json::Value>(body) {
                Ok(mut obj) if obj.is_object() => {
                    let map = obj.as_object_mut().expect("checked is_object");
                    if let Some(event) = event_type {
                        map.insert("event".to_string(), serde_json::json!(event));
                    }
                    if let Some(session_id) = &session_id {
                        map.insert("sessionId".to_string(), serde_json::json!(session_id));
                    }
                    if let Some(agent) = &agent {
                        map.insert("agent".to_string(), serde_json::json!(agent));
                    }
                    map.insert("_yorishiro_seq".to_string(), serde_json::json!(seq));
                    obj.to_string()
                }
                _ => {
                    // 非 JSON object の body は dedup 不能だが、現状の hook は全て
                    // JSON object なので実害はない。raw のまま渡す。
                    body.to_string()
                }
            };

            // Immediate path: WebView receives without waiting for polling.
            let _ = app.emit("hook-signal", final_body.clone());
            // Fallback path: frontend drains via poll_hook_signals if event delivery misses.
            if let Ok(mut q) = HOOK_SIGNAL_QUEUE.lock() {
                q.push(final_body);
            }
        }
    }
    let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
    let _ = stream.write_all(resp.as_bytes());
}

// ─── PTY state (facade) ─────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct PtyExit {
    pub session_id: String,
    pub code: i32,
}

/// PtyState — `~/.yorishiro/` 1 つの window 全体の PTY ops を束ねる thin facade。
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
            display_cwd: None,
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

    pub fn attach(
        &self,
        session_id: &str,
        cwd: Option<String>,
        on_output: Channel,
    ) -> AttachResult {
        let Some(session) = self.session_or_default(session_id) else {
            return AttachResult {
                attached: false,
                replay: Vec::new(),
            };
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

// ─── Tests ──────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_hooks_json_valid() {
        let json = build_hooks_json(19001);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("should be valid JSON");
        let hooks = parsed["hooks"].as_object().expect("should have hooks");
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(hooks.contains_key("SessionStart"));
        assert!(hooks.contains_key("PreToolUse"));
        assert!(hooks.contains_key("PostToolUse"));
        assert!(hooks.contains_key("PostToolUseFailure"));
        assert!(hooks.contains_key("PostToolBatch"));
        assert!(hooks.contains_key("Stop"));
        assert!(hooks.contains_key("StopFailure"));
        assert!(hooks.contains_key("Notification"));
        assert!(hooks.contains_key("PermissionRequest"));
        assert!(hooks.contains_key("PermissionDenied"));
        assert!(hooks.contains_key("SubagentStart"));
        assert!(hooks.contains_key("SubagentStop"));
        assert!(hooks.contains_key("TaskCreated"));
        assert!(hooks.contains_key("TaskCompleted"));
        assert!(hooks.contains_key("PreCompact"));
        assert!(hooks.contains_key("PostCompact"));
        assert!(hooks.contains_key("Elicitation"));
        assert!(hooks.contains_key("ElicitationResult"));
        assert!(hooks.contains_key("SessionEnd"));
        let notification = hooks["Notification"][0]["hooks"].as_array().unwrap();
        assert_eq!(notification.len(), 1);
        assert!(notification[0]["command"]
            .as_str()
            .unwrap()
            .contains("/hook/notification"));
        assert!(hooks["PermissionRequest"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("/hook/permission-request"));
    }

    #[test]
    fn build_windows_hook_commands_use_powershell() {
        let stdin = build_hook_stdin_command(19001, "/hook/pre-tool-use", true);
        assert!(stdin.contains("powershell.exe"));
        assert!(stdin.contains("Invoke-WebRequest"));
        assert!(stdin.contains("[Console]::In.ReadToEnd()"));
        assert!(stdin.contains("http://127.0.0.1:19001/hook/pre-tool-use"));
    }

    #[test]
    fn hook_path_query_extracts_session_and_agent() {
        let (path, query) = split_path_query("/hook/notification?sessionId=shell-1&agent=codex");
        assert_eq!(path, "/hook/notification");
        assert_eq!(query_param(query, "sessionId"), Some("shell-1".to_string()));
        assert_eq!(query_param(query, "agent"), Some("codex".to_string()));
    }

    #[test]
    fn hook_query_percent_decodes_values() {
        let (_, query) = split_path_query("/hook/prompt?sessionId=shell%3A1+copy");
        assert_eq!(
            query_param(query, "sessionId"),
            Some("shell:1 copy".to_string())
        );
    }
}
