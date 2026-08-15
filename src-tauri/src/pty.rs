use serde::Serialize;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

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

#[derive(Clone, Debug)]
pub struct HookServerEndpoint {
    pub port: u16,
    token: String,
}

impl HookServerEndpoint {
    pub fn unavailable() -> Self {
        Self {
            port: 0,
            token: String::new(),
        }
    }

    pub fn is_available(&self) -> bool {
        self.port != 0 && !self.token.is_empty()
    }

    pub fn token(&self) -> &str {
        &self.token
    }
}

pub struct PendingHookServer {
    listener: TcpListener,
    endpoint: HookServerEndpoint,
}

impl PendingHookServer {
    pub fn endpoint(&self) -> HookServerEndpoint {
        self.endpoint.clone()
    }
}

pub fn bind_hook_server() -> Result<PendingHookServer, String> {
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|error| format!("Failed to bind Claude hook server: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("Failed to inspect Claude hook server address: {error}"))?
        .port();
    Ok(PendingHookServer {
        listener,
        endpoint: HookServerEndpoint {
            port,
            token: uuid::Uuid::new_v4().to_string(),
        },
    })
}

fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn powershell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}

fn percent_encode_query_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'.' | b'_' | b'~') {
            encoded.push(byte as char);
        } else {
            use std::fmt::Write as _;
            let _ = write!(encoded, "%{byte:02X}");
        }
    }
    encoded
}

fn scoped_hook_endpoint(
    path: &str,
    host_session_id: &str,
    agent: &str,
    token: &str,
    hook_launch_id: &str,
) -> String {
    format!(
        "{}?sessionId={}&agent={}&token={}&launch={}",
        path,
        percent_encode_query_component(host_session_id),
        percent_encode_query_component(agent),
        percent_encode_query_component(token),
        percent_encode_query_component(hook_launch_id),
    )
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

pub(crate) fn build_hooks_json(
    port: u16,
    host_session_id: &str,
    agent: &str,
    token: &str,
    hook_launch_id: &str,
) -> String {
    let windows = cfg!(windows);
    let hook_command = |path: &str| {
        build_hook_stdin_command(
            port,
            &scoped_hook_endpoint(path, host_session_id, agent, token, hook_launch_id),
            windows,
        )
    };

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
                "hooks": [{ "type": "command", "command": hook_command("/hook/session-start") }]
            }],
            "UserPromptSubmit": [{
                "matcher": "",
                "hooks": [
                    { "type": "command", "command": hook_command("/hook/prompt") },
                    { "type": "command", "command": reminder_cmd }
                ]
            }],
            "PreToolUse": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/pre-tool-use") }]
            }],
            "PostToolUse": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/post-tool-use") }]
            }],
            "PostToolUseFailure": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/post-tool-failure") }]
            }],
            "PostToolBatch": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/post-tool-batch") }]
            }],
            "Stop": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/stop") }]
            }],
            "StopFailure": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/stop-failure") }]
            }],
            "Notification": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/notification") }]
            }],
            "PermissionRequest": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/permission-request") }]
            }],
            "PermissionDenied": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/permission-denied") }]
            }],
            "SubagentStart": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/subagent-start") }]
            }],
            "SubagentStop": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/subagent-stop") }]
            }],
            "TaskCreated": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/task-created") }]
            }],
            "TaskCompleted": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/task-completed") }]
            }],
            "PreCompact": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/pre-compact") }]
            }],
            "PostCompact": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/post-compact") }]
            }],
            "Elicitation": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/elicitation") }]
            }],
            "ElicitationResult": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/elicitation-result") }]
            }],
            "SessionEnd": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": hook_command("/hook/session-end") }]
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
    reminders.append("印象に残った出来事があれば journal_write。出来事と、そこから感じたこと・気づいたことを、嘘や演出を交えず短く残す。")

if config.get("voiceFrequency", "on") != "off":
    reminders.append("応答の要点を voice_say で声に出す。声が先。")

# journal callback のワンショット消費。Rust が agent spawn 時に発火判定して pending を
# 書き、ここで一度だけ読み、口にするかは住人の判断に委ねる。消費後は削除する。
pending_path = os.path.join(os.path.expanduser("~"), ".yorishiro", "journal", "callback-pending.txt")
try:
    with open(pending_path, encoding="utf-8") as f:
        pending = f.read().strip()
    os.remove(pending_path)
    if pending:
        reminders.append(pending)
except Exception:
    pass

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
pub fn start_hook_server(app: AppHandle, server: PendingHookServer) {
    std::thread::spawn(move || {
        let token = Arc::new(server.endpoint.token);
        for stream in server.listener.incoming() {
            let Ok(stream) = stream else { continue };
            let app = app.clone();
            let token = Arc::clone(&token);
            std::thread::spawn(move || handle_hook_stream(app, stream, &token));
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

fn hook_token_matches(query: Option<&str>, expected_token: &str) -> bool {
    !expected_token.is_empty() && query_param(query, "token").as_deref() == Some(expected_token)
}

fn claude_session_start_id<'a>(
    path: &str,
    agent: Option<&str>,
    payload: &'a serde_json::Value,
) -> Option<&'a str> {
    if path != "/hook/session-start" || agent != Some("claude") {
        return None;
    }
    payload
        .get("session_id")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
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

fn handle_hook_stream(app: AppHandle, mut stream: TcpStream, expected_token: &str) {
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
    let hook_launch_id = query_param(query, "launch");
    let token_matches = hook_token_matches(query, expected_token);
    if token_matches {
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

                let parsed_body = serde_json::from_str::<serde_json::Value>(body);
                let provider_session_id = parsed_body
                    .as_ref()
                    .ok()
                    .and_then(|obj| claude_session_start_id(path, agent.as_deref(), obj));
                // Hook acceptance and SessionStart recording share the same registry lock as
                // PTY replacement detach/snapshot. A signal is therefore either included in the
                // outgoing snapshot or rejected as stale; it cannot fall between both operations.
                let launch_accepted = match (session_id.as_deref(), hook_launch_id.as_deref()) {
                    (Some(session_id), Some(hook_launch_id)) => app
                        .state::<PtyState>()
                        .accept_hook_signal(session_id, hook_launch_id, provider_session_id),
                    _ => false,
                };
                if launch_accepted {
                    // 同一 signal を immediate event と polling fallback の両方で配るので、
                    // monotonic な _yorishiro_seq を必ず載せて frontend が 1 回だけ処理できるようにする。
                    let seq = HOOK_SEQ.fetch_add(1, Ordering::Relaxed);
                    let final_body = match parsed_body {
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

pub struct PtySpawnError {
    pub message: String,
    pub replaced_confirmed_session_id: Option<String>,
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
    ) -> Result<Option<String>, PtySpawnError> {
        // 既存同 id session はまずregistryからdetachし、同じlock境界でselectionを
        // snapshotする。以後そのlaunchのhookはstaleとして拒否される。
        // suppress_exit で reader thread の pty-exit emit を抑制し、
        // JS 側の auto-respawn が誤発火しないようにする。
        let (existing, replaced_confirmed_session_id) = self
            .registry
            .detach_pty_with_selected_conversation(session_id)
            .map(|(session, selection)| {
                let confirmed_session_id = selection
                    .filter(|selected| selected.confirmed)
                    .map(|selected| selected.session_id);
                (Some(session), confirmed_session_id)
            })
            .unwrap_or((None, None));
        if let Some(existing) = existing {
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
        // SessionStart hook は child spawn 直後に届き得るため、spawn 前に registry へ
        // publishする。spawn失敗時は下のremoveでrollbackする。
        self.registry.attach_pty(session_id, Arc::clone(&session));
        if let Err(e) = session.spawn(app, cols, rows, cwd, spec, on_output) {
            self.registry.remove(session_id);
            return Err(PtySpawnError {
                message: e,
                replaced_confirmed_session_id,
            });
        }
        Ok(replaced_confirmed_session_id)
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

    pub fn realtime_endpoint(&self, session_id: &str) -> Option<String> {
        self.session_or_default(session_id)
            .and_then(|session| session.realtime_endpoint())
    }

    pub fn realtime_capabilities(
        &self,
        session_id: &str,
    ) -> Option<crate::sessions::pty_session::CodexRealtimeCapabilities> {
        self.session_or_default(session_id)
            .and_then(|session| session.realtime_capabilities())
    }

    pub fn realtime_selected_thread_id(&self, session_id: &str) -> Option<String> {
        self.session_or_default(session_id)
            .and_then(|session| session.realtime_selected_thread_id())
    }

    pub fn realtime_selected_thread(
        &self,
        session_id: &str,
    ) -> Option<crate::sessions::pty_session::AgentSelectedConversation> {
        self.session_or_default(session_id)
            .and_then(|session| session.realtime_selected_thread())
    }

    pub fn accept_hook_signal(
        &self,
        session_id: &str,
        hook_launch_id: &str,
        provider_session_id: Option<&str>,
    ) -> bool {
        self.registry
            .accept_hook_signal(session_id, hook_launch_id, provider_session_id)
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
        let json = build_hooks_json(
            19001,
            "main session",
            "claude",
            "instance-token",
            "launch-token",
        );
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
        assert!(notification[0]["command"].as_str().unwrap().contains(
            "sessionId=main%20session&agent=claude&token=instance-token&launch=launch-token"
        ));
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
        let (path, query) = split_path_query(
            "/hook/notification?sessionId=shell-1&agent=codex&token=instance-token",
        );
        assert_eq!(path, "/hook/notification");
        assert_eq!(query_param(query, "sessionId"), Some("shell-1".to_string()));
        assert_eq!(query_param(query, "agent"), Some("codex".to_string()));
        assert_eq!(
            query_param(query, "token"),
            Some("instance-token".to_string())
        );
    }

    #[test]
    fn hook_query_percent_decodes_values() {
        let (_, query) = split_path_query("/hook/prompt?sessionId=shell%3A1+copy");
        assert_eq!(
            query_param(query, "sessionId"),
            Some("shell:1 copy".to_string())
        );
    }

    #[test]
    fn hook_token_rejects_missing_or_cross_instance_requests() {
        assert!(!hook_token_matches(
            Some("sessionId=main&agent=claude"),
            "instance-a"
        ));
        assert!(!hook_token_matches(
            Some("sessionId=main&agent=claude&token=instance-b"),
            "instance-a"
        ));
        assert!(hook_token_matches(
            Some("sessionId=main&agent=claude&token=instance-a"),
            "instance-a"
        ));
    }

    #[test]
    fn claude_session_start_extracts_only_the_provider_conversation_id() {
        let payload = serde_json::json!({
            "session_id": " provider-session-id ",
            "transcript_path": "/private/conversation.jsonl",
        });
        assert_eq!(
            claude_session_start_id("/hook/session-start", Some("claude"), &payload),
            Some("provider-session-id")
        );
        assert_eq!(
            claude_session_start_id("/hook/prompt", Some("claude"), &payload),
            None
        );
        assert_eq!(
            claude_session_start_id("/hook/session-start", Some("codex"), &payload),
            None
        );
    }

    #[test]
    fn hook_server_bind_uses_per_instance_dynamic_ports_and_tokens() {
        let first = bind_hook_server().expect("first hook server");
        let second = bind_hook_server().expect("second hook server");
        let first_endpoint = first.endpoint();
        let second_endpoint = second.endpoint();
        assert!(first_endpoint.is_available());
        assert!(second_endpoint.is_available());
        assert_ne!(first_endpoint.port, second_endpoint.port);
        assert_ne!(first_endpoint.token(), second_endpoint.token());
    }
}
