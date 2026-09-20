use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager};

use crate::chat_approvals::{
    ChatApprovalBroker, ChatApprovalChoice, ChatApprovalDecision, ChatApprovalLabel,
    ChatApprovalRequest,
};
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

fn build_permission_hook_stdin_command(port: u16, endpoint: &str, windows: bool) -> String {
    let url = format!("http://127.0.0.1:{port}{endpoint}&approval=1");
    if windows {
        format!(
            "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command \"$body = [Console]::In.ReadToEnd(); try {{ (Invoke-WebRequest -UseBasicParsing -TimeoutSec 310 -Method Post -ContentType 'application/json' -Uri {} -Body $body).Content }} catch {{ Write-Output '{{}}' }}\"",
            powershell_single_quote(&url),
        )
    } else {
        format!(
            "curl -sf --connect-timeout 1 -m 310 -X POST -H 'Content-Type: application/json' --data-binary @- {} || printf '{{}}'",
            sh_single_quote(&url),
        )
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
    let permission_command = build_permission_hook_stdin_command(
        port,
        &scoped_hook_endpoint(
            "/hook/permission-request",
            host_session_id,
            agent,
            token,
            hook_launch_id,
        ),
        windows,
    );

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
                "hooks": [{ "type": "command", "command": permission_command, "timeout": 320 }]
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
    let mut approval_payload = None;
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
                    if path == "/hook/session-end" && agent.as_deref() == Some("claude") {
                        if let (Some(broker), Some(session_id), Some(conversation_id)) = (
                            app.try_state::<ChatApprovalBroker>(),
                            session_id.as_deref(),
                            parsed_body
                                .as_ref()
                                .ok()
                                .and_then(|payload| payload.get("session_id"))
                                .and_then(serde_json::Value::as_str),
                        ) {
                            broker.cancel_conversation(session_id, conversation_id.trim());
                        }
                    }
                    // 古い起動設定の 1 秒通知を保留しない。応答対応を宣言した接続だけを所有する。
                    if negotiated_claude_approval(path, query, agent.as_deref()) {
                        if let (Some(session_id), Some(launch_id), Ok(payload)) = (
                            session_id.as_deref(),
                            hook_launch_id.as_deref(),
                            parsed_body.as_ref(),
                        ) {
                            approval_payload = Some((
                                session_id.to_string(),
                                launch_id.to_string(),
                                payload.clone(),
                            ));
                        }
                    }
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
    let body = approval_payload
        .map(|(session_id, launch_id, payload)| {
            wait_for_claude_approval(&app, &stream, &session_id, &launch_id, &payload)
        })
        .unwrap_or_else(|| "{}".to_string());
    let resp = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(), body,
    );
    let _ = stream.set_nonblocking(false);
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.write_all(resp.as_bytes());
}

fn negotiated_claude_approval(path: &str, query: Option<&str>, agent: Option<&str>) -> bool {
    path == "/hook/permission-request"
        && agent == Some("claude")
        && query_param(query, "approval").as_deref() == Some("1")
}

fn approval_connection_open(stream: &TcpStream) -> bool {
    let mut byte = [0_u8; 1];
    match stream.peek(&mut byte) {
        Err(error) => matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
        ),
        // 要求 body は読み切っている。EOF や追加の別要求には回答を付けない。
        Ok(_) => false,
    }
}

struct ClaudeApproval {
    request: ChatApprovalRequest,
    responses: HashMap<ChatApprovalDecision, serde_json::Value>,
}

const MAX_CLAUDE_APPROVAL_SUGGESTIONS: usize = 12;
const MAX_CLAUDE_PERMISSION_DETAIL_BYTES: usize = 16 * 1024;

fn claude_permission_suggestion(
    suggestion: &serde_json::Value,
) -> Option<(ChatApprovalLabel, String)> {
    let update = suggestion.as_object()?;
    let destination = update.get("destination")?.as_str()?;
    let (label, scope) = match destination {
        "session" => (
            ChatApprovalLabel::AllowSession,
            "This session only (not saved)",
        ),
        "localSettings" => (
            ChatApprovalLabel::AllowRule,
            "Saved to project-local settings: .claude/settings.local.json",
        ),
        "projectSettings" => (
            ChatApprovalLabel::AllowRule,
            "Saved to shared project settings: .claude/settings.json",
        ),
        "userSettings" => (
            ChatApprovalLabel::AllowRule,
            "Saved to user settings for all projects: ~/.claude/settings.json",
        ),
        _ => return None,
    };
    match update.get("type")?.as_str()? {
        "addRules" => {
            if update
                .keys()
                .any(|key| !["type", "rules", "behavior", "destination"].contains(&key.as_str()))
                || update.get("behavior")?.as_str()? != "allow"
            {
                return None;
            }
            let rules = update.get("rules")?.as_array()?;
            if rules.is_empty()
                || rules.iter().any(|rule| {
                    let Some(rule) = rule.as_object() else {
                        return true;
                    };
                    rule.keys()
                        .any(|key| !["toolName", "ruleContent"].contains(&key.as_str()))
                        || rule
                            .get("toolName")
                            .and_then(serde_json::Value::as_str)
                            .is_none_or(|name| name.trim().is_empty())
                        || rule
                            .get("ruleContent")
                            .is_some_and(|content| !content.is_string())
                })
            {
                return None;
            }
        }
        "addDirectories" => {
            if update
                .keys()
                .any(|key| !["type", "directories", "destination"].contains(&key.as_str()))
            {
                return None;
            }
            let directories = update.get("directories")?.as_array()?;
            if directories.is_empty()
                || directories
                    .iter()
                    .any(|path| path.as_str().is_none_or(|path| path.trim().is_empty()))
            {
                return None;
            }
        }
        // mode 変更や既存規則の置換・削除を継続許可と取り違えない。
        _ => return None,
    }
    let detail = format!(
        "{scope}\n\n{}",
        serde_json::to_string_pretty(suggestion).ok()?
    );
    // 省略表示した規則を承認させず、大きすぎる更新は元の Terminal で確認する。
    if detail.len() > MAX_CLAUDE_PERMISSION_DETAIL_BYTES {
        return None;
    }
    Some((label, detail))
}

fn claude_approval_request(
    session_id: &str,
    payload: &serde_json::Value,
) -> Option<ClaudeApproval> {
    if payload.get("hook_event_name")?.as_str()? != "PermissionRequest" {
        return None;
    }
    let conversation_id = payload.get("session_id")?.as_str()?.trim();
    let tool_name = payload.get("tool_name")?.as_str()?.trim();
    let tool_input = payload.get("tool_input")?.as_object()?;
    if conversation_id.is_empty() || tool_name.is_empty() {
        return None;
    }
    let cwd = payload.get("cwd").and_then(serde_json::Value::as_str);
    let detail = serde_json::to_string_pretty(&serde_json::json!({
        "cwd": cwd,
        "tool_input": tool_input,
    }))
    .ok()?;
    let mut choices = vec![ChatApprovalChoice::allow_once(), ChatApprovalChoice::deny()];
    let mut responses = HashMap::from([
        (
            "allow".to_string(),
            serde_json::json!({"behavior": "allow"}),
        ),
        ("deny".to_string(), serde_json::json!({"behavior": "deny"})),
    ]);
    if let Some(suggestions) = payload
        .get("permission_suggestions")
        .and_then(serde_json::Value::as_array)
    {
        for (index, suggestion) in suggestions.iter().enumerate() {
            if choices.len() >= MAX_CLAUDE_APPROVAL_SUGGESTIONS + 2 {
                break;
            }
            let Some((label, detail)) = claude_permission_suggestion(suggestion) else {
                continue;
            };
            let id = format!("claude-suggestion-{index}");
            choices.push(ChatApprovalChoice {
                id: id.clone(),
                label,
                detail: Some(detail),
            });
            // suggestion は独立した更新。選ばれた元の一件だけを返し、別の規則を合成しない。
            responses.insert(
                id,
                serde_json::json!({"behavior": "allow", "updatedPermissions": [suggestion]}),
            );
        }
    }
    Some(ClaudeApproval {
        request: ChatApprovalRequest {
            id: String::new(),
            session_id: session_id.to_string(),
            agent: "claude".to_string(),
            conversation_id: Some(conversation_id.to_string()),
            title: tool_name.to_string(),
            detail,
            choices,
        },
        responses,
    })
}

fn claude_approval_response(
    responses: &HashMap<ChatApprovalDecision, serde_json::Value>,
    choice_id: &str,
) -> String {
    let Some(decision) = responses.get(choice_id) else {
        return "{}".to_string();
    };
    serde_json::json!({
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        },
    })
    .to_string()
}

fn wait_for_claude_approval(
    app: &AppHandle,
    stream: &TcpStream,
    session_id: &str,
    launch_id: &str,
    payload: &serde_json::Value,
) -> String {
    let Some(ClaudeApproval { request, responses }) = claude_approval_request(session_id, payload)
    else {
        return "{}".to_string();
    };
    let conversation_id = request.conversation_id.clone().unwrap_or_default();
    let Some(revision) = app.state::<PtyState>().chat_approval_scope_revision(
        session_id,
        launch_id,
        &conversation_id,
    ) else {
        return "{}".to_string();
    };
    let Some(broker) = app.try_state::<ChatApprovalBroker>() else {
        return "{}".to_string();
    };
    let Ok(connection) = stream.try_clone() else {
        return "{}".to_string();
    };
    if connection.set_nonblocking(true).is_err() {
        return "{}".to_string();
    }
    let current_app = app.clone();
    let session_id = session_id.to_string();
    let launch_id = launch_id.to_string();
    let scope = move || {
        approval_connection_open(&connection)
            && current_app
                .state::<PtyState>()
                .chat_approval_scope_revision(&session_id, &launch_id, &conversation_id)
                == Some(revision)
    };
    let scope = Arc::new(scope);
    let pending_scope = Arc::clone(&scope);
    let Some(waiter) = broker.register(request, move || pending_scope()) else {
        return "{}".to_string();
    };
    loop {
        broker.maintain();
        match waiter.recv_timeout(Duration::from_millis(100)) {
            Ok(decision) if scope() => return claude_approval_response(&responses, &decision),
            Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                broker.cancel(waiter.id());
                return "{}".to_string();
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
        }
    }
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

    /// launch と会話の revision を回答直前にも照合し、A → B → A の古い要求を復活させない。
    fn chat_approval_scope_revision(
        &self,
        session_id: &str,
        launch_id: &str,
        provider_session_id: &str,
    ) -> Option<u64> {
        if self.registry.get_lifecycle(session_id)
            != Some(crate::sessions::types::SessionLifecycle::Running)
        {
            return None;
        }
        let session = self.session_or_default(session_id)?;
        if !session.matches_hook_launch(launch_id) {
            return None;
        }
        let selection = session.realtime_selected_thread()?;
        (selection.confirmed && selection.session_id == provider_session_id)
            .then_some(selection.revision)
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
        assert_eq!(hooks["PermissionRequest"][0]["hooks"][0]["timeout"], 320);
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
    fn approval_command_negotiates_wait_and_forwards_json_on_both_platforms() {
        let endpoint =
            "/hook/permission-request?sessionId=main&agent=claude&token=token&launch=launch";
        let unix = build_permission_hook_stdin_command(19001, endpoint, false);
        assert!(unix.contains("&approval=1"));
        assert!(unix.contains("--data-binary @-"));
        assert!(unix.contains("-m 310"));
        assert!(!unix.contains(">/dev/null"));
        let windows = build_permission_hook_stdin_command(19001, endpoint, true);
        assert!(windows.contains("-TimeoutSec 310"));
        assert!(windows.contains(").Content"));
        assert!(!windows.contains("Out-Null"));
    }

    #[test]
    fn old_configs_and_other_agent_hooks_never_create_native_approval_cards() {
        let path = "/hook/permission-request";
        assert!(!negotiated_claude_approval(path, None, Some("claude")));
        assert!(!negotiated_claude_approval(
            path,
            Some("approval=1"),
            Some("codex")
        ));
        assert!(!negotiated_claude_approval(
            "/hook/notification",
            Some("approval=1"),
            Some("claude")
        ));
        assert!(negotiated_claude_approval(
            path,
            Some("approval=1"),
            Some("claude")
        ));
    }

    #[test]
    fn approval_details_preserve_the_exact_call_without_permission_mutation() {
        let payload = serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "conversation-a",
            "tool_name": "Bash",
            "cwd": "/work/project",
            "tool_input": {"command": "printf 'a\\nb'\ncat file", "nested": [1, true]},
            "permission_suggestions": [{"type":"setMode", "mode":"bypassPermissions"}],
        });
        let ClaudeApproval { request, responses } =
            claude_approval_request("main", &payload).unwrap();
        let detail: serde_json::Value = serde_json::from_str(&request.detail).unwrap();
        assert_eq!(detail["tool_input"], payload["tool_input"]);
        assert_eq!(detail["cwd"], "/work/project");
        assert_eq!(request.conversation_id.as_deref(), Some("conversation-a"));
        assert_eq!(request.choices.len(), 2);
        for decision in ["allow", "deny"] {
            let response: serde_json::Value =
                serde_json::from_str(&claude_approval_response(&responses, decision)).unwrap();
            assert_eq!(
                response,
                serde_json::json!({
                    "hookSpecificOutput": {
                        "hookEventName": "PermissionRequest",
                        "decision": {"behavior": decision},
                    }
                })
            );
        }
        assert!(claude_approval_request("main", &serde_json::json!({})).is_none());
        let mut notification = payload;
        notification["hook_event_name"] = serde_json::json!("Notification");
        assert!(claude_approval_request("main", &notification).is_none());
    }

    fn permission_payload(suggestions: serde_json::Value) -> serde_json::Value {
        serde_json::json!({
            "hook_event_name": "PermissionRequest",
            "session_id": "conversation-a",
            "tool_name": "Bash",
            "cwd": "/work/project",
            "tool_input": {"command": "npm test"},
            "permission_suggestions": suggestions,
        })
    }

    #[test]
    fn approval_choices_distinguish_session_and_each_saved_destination() {
        let destinations = [
            ("session", ChatApprovalLabel::AllowSession, "not saved"),
            (
                "localSettings",
                ChatApprovalLabel::AllowRule,
                ".claude/settings.local.json",
            ),
            (
                "projectSettings",
                ChatApprovalLabel::AllowRule,
                ".claude/settings.json",
            ),
            (
                "userSettings",
                ChatApprovalLabel::AllowRule,
                "~/.claude/settings.json",
            ),
        ];
        let suggestions: Vec<_> = destinations
            .iter()
            .map(|(destination, _, _)| {
                serde_json::json!({
                    "type": "addRules",
                    "rules": [
                        {"toolName": "Bash", "ruleContent": "npm test:*"},
                        {"toolName": "Read", "ruleContent": "/work/project/**"},
                    ],
                    "behavior": "allow",
                    "destination": destination,
                })
            })
            .collect();
        let ClaudeApproval { request, responses } =
            claude_approval_request("main", &permission_payload(serde_json::json!(suggestions)))
                .unwrap();
        assert_eq!(request.choices.len(), 6);
        for (index, ((_, label, scope), suggestion)) in
            destinations.iter().zip(&suggestions).enumerate()
        {
            let choice = &request.choices[index + 2];
            assert_eq!(&choice.label, label);
            let detail = choice.detail.as_ref().unwrap();
            assert!(detail.contains(scope));
            assert!(detail.contains("npm test:*"));
            assert!(detail.contains("/work/project/**"));
            let (_, shown_update) = detail.split_once("\n\n").unwrap();
            assert_eq!(
                serde_json::from_str::<serde_json::Value>(shown_update).unwrap(),
                *suggestion
            );
            let response: serde_json::Value =
                serde_json::from_str(&claude_approval_response(&responses, &choice.id)).unwrap();
            assert_eq!(
                response["hookSpecificOutput"]["decision"],
                serde_json::json!({"behavior": "allow", "updatedPermissions": [suggestion]})
            );
        }
        // 継続許可が提示されても、今回だけの許可と拒否は設定を書き換えない。
        for choice in ["allow", "deny"] {
            let response: serde_json::Value =
                serde_json::from_str(&claude_approval_response(&responses, choice)).unwrap();
            assert_eq!(
                response["hookSpecificOutput"]["decision"],
                serde_json::json!({"behavior": choice})
            );
        }
    }

    #[test]
    fn approval_directory_choice_returns_only_the_original_directory_update() {
        let suggestion = serde_json::json!({
            "type": "addDirectories",
            "directories": ["/work/shared assets", "/work/other"],
            "destination": "session",
        });
        let ClaudeApproval { request, responses } =
            claude_approval_request("main", &permission_payload(serde_json::json!([suggestion])))
                .unwrap();
        let choice = &request.choices[2];
        assert_eq!(choice.label, ChatApprovalLabel::AllowSession);
        assert!(choice
            .detail
            .as_ref()
            .unwrap()
            .contains("/work/shared assets"));
        assert!(choice.detail.as_ref().unwrap().contains("/work/other"));
        let response: serde_json::Value =
            serde_json::from_str(&claude_approval_response(&responses, &choice.id)).unwrap();
        assert_eq!(
            response["hookSpecificOutput"]["decision"],
            serde_json::json!({"behavior": "allow", "updatedPermissions": [suggestion]})
        );
    }

    #[test]
    fn approval_unsupported_or_malformed_updates_never_become_ongoing_choices() {
        let suggestions = serde_json::json!([
            {"type": "setMode", "mode": "bypassPermissions", "destination": "session"},
            {"type": "setMode", "mode": "acceptEdits", "destination": "session"},
            {"type": "replaceRules", "rules": [], "behavior": "allow", "destination": "session"},
            {"type": "removeRules", "rules": [], "behavior": "deny", "destination": "session"},
            {"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "ask", "destination": "session"},
            {"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "allow", "destination": "managedSettings"},
            {"type": "addRules", "rules": [], "behavior": "allow", "destination": "session"},
            {"type": "addRules", "rules": [{"toolName": ""}], "behavior": "allow", "destination": "session"},
            {"type": "addRules", "rules": [{"toolName": "Bash", "ruleContent": null}], "behavior": "allow", "destination": "session"},
            {"type": "addRules", "rules": [{"toolName": "Bash", "futureScope": "all"}], "behavior": "allow", "destination": "session"},
            {"type": "addRules", "rules": [{"toolName": "Bash"}], "behavior": "allow", "destination": "session", "futureScope": "all"},
            {"type": "addDirectories", "directories": [null], "destination": "session"},
            {"type": "addDirectories", "directories": [""], "destination": "session"},
            {"type": "addDirectories", "directories": [], "destination": "session"},
            {"type": "addDirectories", "directories": ["/work"], "destination": "session", "mode": "bypassPermissions"},
            {"type": "removeDirectories", "directories": ["/work"], "destination": "session"},
        ]);
        let ClaudeApproval { request, responses } =
            claude_approval_request("main", &permission_payload(suggestions.clone())).unwrap();
        assert_eq!(
            request.choices,
            vec![ChatApprovalChoice::allow_once(), ChatApprovalChoice::deny()]
        );
        for index in 0..suggestions.as_array().unwrap().len() {
            assert_eq!(
                claude_approval_response(&responses, &format!("claude-suggestion-{index}")),
                "{}"
            );
        }
    }

    #[test]
    fn approval_missing_suggestions_and_forged_choices_cannot_create_policy_updates() {
        let mut payload = permission_payload(serde_json::json!([]));
        payload
            .as_object_mut()
            .unwrap()
            .remove("permission_suggestions");
        let ClaudeApproval { request, responses } =
            claude_approval_request("main", &payload).unwrap();
        assert_eq!(request.choices.len(), 2);
        for choice in [
            "allowSession",
            "claude-suggestion-0",
            "claude-suggestion-999",
            r#"{"behavior":"allow","updatedPermissions":[{"type":"setMode","mode":"bypassPermissions"}]}"#,
        ] {
            assert_eq!(claude_approval_response(&responses, choice), "{}");
        }
    }

    #[test]
    fn approval_oversized_or_excess_choices_are_unavailable_instead_of_truncated() {
        let make_update = |content: String| {
            serde_json::json!({
                "type": "addRules",
                "rules": [{"toolName": "Bash", "ruleContent": content}],
                "behavior": "allow",
                "destination": "session",
            })
        };
        let mut suggestions = vec![make_update("x".repeat(MAX_CLAUDE_PERMISSION_DETAIL_BYTES))];
        suggestions.extend(
            (0..=MAX_CLAUDE_APPROVAL_SUGGESTIONS)
                .map(|index| make_update(format!("npm test {index}:*"))),
        );
        let ClaudeApproval { request, responses } =
            claude_approval_request("main", &permission_payload(serde_json::json!(suggestions)))
                .unwrap();
        assert_eq!(request.choices.len(), MAX_CLAUDE_APPROVAL_SUGGESTIONS + 2);
        assert_eq!(
            claude_approval_response(&responses, "claude-suggestion-0"),
            "{}"
        );
        assert_eq!(
            claude_approval_response(
                &responses,
                &format!("claude-suggestion-{}", MAX_CLAUDE_APPROVAL_SUGGESTIONS + 1)
            ),
            "{}"
        );
        for choice in &request.choices[2..] {
            assert!(choice.detail.as_ref().unwrap().len() <= MAX_CLAUDE_PERMISSION_DETAIL_BYTES);
            assert!(responses.contains_key(&choice.id));
        }
    }

    #[test]
    fn approval_scope_rejects_replaced_launch_and_reselected_conversation() {
        let registry = Arc::new(SessionRegistry::new());
        registry.add(SessionDescriptor {
            id: "main".to_string(),
            profile_id: "claude".to_string(),
            kind: SessionKind::Agent,
            label: "Claude".to_string(),
            cwd: None,
            display_cwd: None,
            started_at: 0,
        });
        let session = Arc::new(PtySession::new("main".to_string(), Arc::clone(&registry)));
        let launch = session.hook_launch_id().to_string();
        registry.attach_pty("main", Arc::clone(&session));
        registry.set_lifecycle("main", crate::sessions::types::SessionLifecycle::Running);
        session.record_hook_selected_conversation(&launch, "conversation-a");
        let state = PtyState::new(Arc::clone(&registry));
        let original = state
            .chat_approval_scope_revision("main", &launch, "conversation-a")
            .unwrap();
        assert!(state
            .chat_approval_scope_revision("main", "wrong-launch", "conversation-a")
            .is_none());
        session.record_hook_selected_conversation(&launch, "conversation-b");
        assert!(state
            .chat_approval_scope_revision("main", &launch, "conversation-a")
            .is_none());
        session.record_hook_selected_conversation(&launch, "conversation-a");
        assert_ne!(
            state.chat_approval_scope_revision("main", &launch, "conversation-a"),
            Some(original)
        );
        registry.set_lifecycle("main", crate::sessions::types::SessionLifecycle::Exited);
        assert!(state
            .chat_approval_scope_revision("main", &launch, "conversation-a")
            .is_none());
        registry.remove("main");
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
