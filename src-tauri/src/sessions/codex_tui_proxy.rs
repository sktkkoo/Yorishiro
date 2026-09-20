use crate::chat_approvals::{
    ChatApprovalChoice, ChatApprovalDecision, ChatApprovalLabel, ChatApprovalRequest,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    handshake::server::{Callback, ErrorResponse, Request, Response},
    http::StatusCode,
    Message,
};

/// Codex TUI の transport を中継し、選択状態と未解決の承認だけをメモリに保持する。
pub(super) struct CodexTuiProxy {
    endpoint: String,
    selected_thread: Arc<Mutex<Option<SelectedThread>>>,
    approvals: CodexChatApprovals,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

struct ApprovalCommand {
    token: String,
    decision: ChatApprovalDecision,
    reply: oneshot::Sender<Result<(), String>>,
}

struct PendingApproval {
    connection_id: String,
    request_id: Value,
    thread_id: String,
    turn_id: String,
    item_id: String,
    revision: u64,
    title: String,
    detail: String,
    choices: Vec<CodexApprovalChoice>,
    sender: mpsc::UnboundedSender<ApprovalCommand>,
}

/// 応答 payload は要求元の値を保持し、WebView からは選択肢 ID だけを受け取る。
struct CodexApprovalChoice {
    display: ChatApprovalChoice,
    decision: Value,
}

/// WebView には opaque token と表示内容だけを渡し、元の RPC ID と接続は host が所有する。
#[derive(Clone, Default)]
pub(super) struct CodexChatApprovals {
    pending: Arc<Mutex<HashMap<String, PendingApproval>>>,
    selected_thread: Arc<Mutex<Option<SelectedThread>>>,
}

impl CodexChatApprovals {
    fn list(&self, session_id: &str) -> Vec<ChatApprovalRequest> {
        let selected = self
            .selected_thread
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        let mut requests: Vec<_> = pending
            .iter()
            .filter_map(|(id, approval)| {
                let selected = selected.as_ref()?;
                if selected.id != approval.thread_id || selected.revision != approval.revision {
                    return None;
                }
                let choices = approval
                    .choices
                    .iter()
                    .map(|choice| choice.display.clone())
                    .collect();
                Some(ChatApprovalRequest {
                    id: id.clone(),
                    session_id: session_id.to_string(),
                    agent: "codex".to_string(),
                    conversation_id: Some(approval.thread_id.clone()),
                    title: approval.title.clone(),
                    detail: approval.detail.clone(),
                    choices,
                })
            })
            .collect();
        requests.sort_by(|left, right| left.id.cmp(&right.id));
        requests
    }

    pub(super) async fn respond(
        &self,
        id: &str,
        decision: ChatApprovalDecision,
    ) -> Result<(), String> {
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .get(id)
            .map(|pending| pending.sender.clone())
            .ok_or_else(|| "This approval is no longer pending".to_string())?;
        let (reply, receiver) = oneshot::channel();
        sender
            .send(ApprovalCommand {
                token: id.to_string(),
                decision,
                reply,
            })
            .map_err(|_| "The approval connection has closed".to_string())?;
        receiver
            .await
            .map_err(|_| "The approval connection has closed".to_string())?
    }

    fn invalidate_connection(&self, connection_id: &str) {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, pending| pending.connection_id != connection_id);
    }

    fn remove_rpc(&self, connection_id: &str, id: &Value) {
        self.pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, pending| {
                pending.connection_id != connection_id || pending.request_id != *id
            });
    }

    fn take_response(
        &self,
        command: &ApprovalCommand,
        connection_id: &str,
    ) -> Result<(Value, String), String> {
        let selected = self
            .selected_thread
            .lock()
            .unwrap_or_else(|p| p.into_inner());
        let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
        let approval = pending
            .get(&command.token)
            .ok_or_else(|| "This approval is no longer pending".to_string())?;
        if approval.connection_id != connection_id
            || !selected.as_ref().is_some_and(|selected| {
                selected.id == approval.thread_id && selected.revision == approval.revision
            })
        {
            return Err("The approval belongs to an earlier conversation selection".to_string());
        }
        let decision = approval
            .choices
            .iter()
            .find(|choice| choice.display.id == command.decision)
            .map(|choice| choice.decision.clone())
            .ok_or_else(|| "This decision is not offered for the approval".to_string())?;
        let id = approval.request_id.clone();
        let thread_id = approval.thread_id.clone();
        pending.remove(&command.token);
        Ok((
            serde_json::json!({ "id": id, "result": { "decision": decision } }),
            thread_id,
        ))
    }
}

struct ApprovalConnectionGuard {
    approvals: CodexChatApprovals,
    connection_id: String,
}

impl Drop for ApprovalConnectionGuard {
    fn drop(&mut self) {
        self.approvals.invalidate_connection(&self.connection_id);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct SelectedThread {
    pub(super) id: String,
    /// resume / fork response、または最初の turn/start 済みなら true。
    /// thread/start response だけなら未確定。
    pub(super) confirmed: bool,
    /// proxy が観測した top-level selection / turn-start ごとに増える。
    pub(super) revision: u64,
}

impl CodexTuiProxy {
    pub(super) fn spawn(upstream_endpoint: String) -> Result<Self, String> {
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|error| format!("Codex TUI proxy port allocation failed: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("Codex TUI proxy address lookup failed: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("Codex TUI proxy nonblocking setup failed: {error}"))?;
        let endpoint = format!("ws://{address}");
        let selected_thread = Arc::new(Mutex::new(None));
        let approvals = CodexChatApprovals {
            selected_thread: Arc::clone(&selected_thread),
            ..Default::default()
        };
        let task_approvals = approvals.clone();
        let task_selected_thread = Arc::clone(&selected_thread);
        let (shutdown, mut shutdown_rx) = oneshot::channel();

        let thread = std::thread::Builder::new()
            .name("codex-tui-proxy".to_string())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        eprintln!("[codex-tui-proxy] runtime creation failed: {error}");
                        return;
                    }
                };
                runtime.block_on(async move {
                    let listener = match tokio::net::TcpListener::from_std(listener) {
                        Ok(listener) => listener,
                        Err(error) => {
                            eprintln!("[codex-tui-proxy] listener setup failed: {error}");
                            return;
                        }
                    };
                    loop {
                        tokio::select! {
                            _ = &mut shutdown_rx => break,
                            accepted = listener.accept() => {
                                let Ok((stream, _)) = accepted else { continue };
                                let upstream = upstream_endpoint.clone();
                                let selected = Arc::clone(&task_selected_thread);
                                let approvals = task_approvals.clone();
                                tokio::spawn(async move {
                                    if let Err(error) = proxy_connection(stream, upstream, selected, approvals).await {
                                        eprintln!("[codex-tui-proxy] connection ended: {error}");
                                    }
                                });
                            }
                        }
                    }
                });
            })
            .map_err(|error| format!("Codex TUI proxy thread spawn failed: {error}"))?;

        Ok(Self {
            endpoint,
            selected_thread,
            approvals,
            shutdown: Some(shutdown),
            thread: Some(thread),
        })
    }

    pub(super) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(super) fn selected_thread_id(&self) -> Option<String> {
        self.selected_thread
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .map(|selected| selected.id.clone())
    }

    pub(super) fn selected_thread(&self) -> Option<SelectedThread> {
        self.selected_thread
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(super) fn chat_approvals(&self, session_id: &str) -> Vec<ChatApprovalRequest> {
        self.approvals.list(session_id)
    }

    pub(super) fn chat_approval_handle(&self) -> CodexChatApprovals {
        self.approvals.clone()
    }
}

impl Drop for CodexTuiProxy {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct RejectBrowserOrigin;

impl Callback for RejectBrowserOrigin {
    fn on_request(self, request: &Request, response: Response) -> Result<Response, ErrorResponse> {
        if request.headers().contains_key("origin") {
            return Err(Response::builder()
                .status(StatusCode::FORBIDDEN)
                .body(Some("Origin header is not allowed".to_string()))
                .expect("static WebSocket rejection response should be valid"));
        }
        Ok(response)
    }
}

async fn proxy_connection(
    client_stream: tokio::net::TcpStream,
    upstream_endpoint: String,
    selected_thread: Arc<Mutex<Option<SelectedThread>>>,
    approvals: CodexChatApprovals,
) -> Result<(), String> {
    let client = tokio_tungstenite::accept_hdr_async(client_stream, RejectBrowserOrigin)
        .await
        .map_err(|error| format!("TUI handshake failed: {error}"))?;
    let (upstream, _) = tokio_tungstenite::connect_async(&upstream_endpoint)
        .await
        .map_err(|error| format!("upstream connection failed: {error}"))?;
    let (mut client_sink, mut client_stream) = client.split();
    let (mut upstream_sink, mut upstream_stream) = upstream.split();
    let mut thread_selection_requests = HashMap::new();
    let mut resume_fallback_requests = HashMap::new();
    let mut fresh_start_fallback_requests = HashMap::new();
    let mut fresh_fallback_threads = HashSet::new();
    let mut turn_start_requests = HashMap::new();
    let connection_id = uuid::Uuid::new_v4().to_string();
    let _approval_guard = ApprovalConnectionGuard {
        approvals: approvals.clone(),
        connection_id: connection_id.clone(),
    };
    let (approval_sender, mut approval_receiver) = mpsc::unbounded_channel::<ApprovalCommand>();
    let mut consumed_approval_ids = HashSet::new();
    let mut file_changes = HashMap::new();
    let mut owned_selection_revision = None;

    loop {
        tokio::select! {
            Some(command) = approval_receiver.recv() => {
                let response = approvals.take_response(&command, &connection_id);
                let (response, thread_id) = match response {
                    Ok(response) => response,
                    Err(error) => { let _ = command.reply.send(Err(error)); continue; }
                };
                let id = response.get("id").expect("host response ID");
                consumed_approval_ids.insert(request_id_key(id).expect("serializable ID"));
                if let Err(error) = upstream_sink.send(Message::Text(response.to_string().into())).await {
                    let message = format!("Approval response send failed: {error}");
                    let _ = command.reply.send(Err(message.clone()));
                    return Err(message);
                }
                // 同じ TUI 接続から応答したため、TUI 自身には送信結果が見えない。
                // 既存 protocol の resolved 通知で表示を閉じ、後着の二重応答も抑止する。
                let resolved = serde_json::json!({ "method": "serverRequest/resolved", "params": { "threadId": thread_id, "requestId": id } });
                let _ = command.reply.send(Ok(()));
                client_sink.send(Message::Text(resolved.to_string().into())).await
                    .map_err(|error| format!("TUI approval resolution send failed: {error}"))?;
            }
            message = client_stream.next() => {
                let Some(message) = message else { break };
                let message = message.map_err(|error| format!("TUI receive failed: {error}"))?;
                if let Message::Text(text) = &message {
                    if let Ok(value) = serde_json::from_str::<Value>(text) {
                        if is_rpc_response(&value) {
                            if let Some(id) = value.get("id") {
                                if request_id_key(id).is_some_and(|key| consumed_approval_ids.contains(&key)) { continue; }
                                approvals.remove_rpc(&connection_id, id);
                            }
                        }
                    }
                    if let Some(response) = empty_unmaterialized_history_response(
                        text.as_ref(),
                        &fresh_fallback_threads,
                    ) {
                        client_sink.send(response).await
                            .map_err(|error| format!("TUI history fallback send failed: {error}"))?;
                        continue;
                    }
                    track_thread_selection_request(text.as_ref(), &mut thread_selection_requests);
                    let mut selection_request = HashMap::new();
                    track_thread_selection_request(text.as_ref(), &mut selection_request);
                    if !selection_request.is_empty() {
                        approvals.invalidate_connection(&connection_id);
                        owned_selection_revision = None;
                        file_changes.clear();
                    }
                    track_resume_fallback_request(text.as_ref(), &mut resume_fallback_requests);
                    track_turn_start_request(text.as_ref(), &mut turn_start_requests);
                }
                upstream_sink.send(message).await
                    .map_err(|error| format!("upstream send failed: {error}"))?;
            }
            message = upstream_stream.next() => {
                let Some(message) = message else { break };
                let message = message.map_err(|error| format!("upstream receive failed: {error}"))?;
                if let Message::Text(text) = &message {
                    if let Ok(value) = serde_json::from_str::<Value>(text) {
                        observe_approval_lifecycle(&value, &approvals, &connection_id, &mut file_changes);
                        if let Some(id) = value.get("id").filter(|_| value.get("method").is_some()) {
                            if let Some(key) = request_id_key(id) { consumed_approval_ids.remove(&key); }
                        }
                        capture_chat_approval(&value, &approvals, &connection_id, owned_selection_revision, &approval_sender, &file_changes);
                    }
                    if let Some(thread_id) = take_successful_turn_start_response(
                        text.as_ref(),
                        &mut turn_start_requests,
                    ) {
                        let previous_revision = owned_selection_revision;
                        let confirmed_revision = mark_selected_thread_confirmed(&thread_id, &selected_thread);
                        // タイトル生成など別会話の内部 turn は、この接続の所有権を変更しない。
                        if let Some(current) = confirmed_revision {
                            owned_selection_revision = Some(current);
                        }
                        // turn/start の返答より先に届いた、その turn 自身の承認だけを引き継ぐ。
                        // 会話切替や過去 turn の承認は新しい revision へ移さない。
                        if let (Some(previous), Some(current), Ok(value)) =
                            (previous_revision, confirmed_revision, serde_json::from_str::<Value>(text)) {
                            if let Some(turn_id) = value.pointer("/result/turn/id").and_then(Value::as_str) {
                                let mut pending = approvals.pending.lock().unwrap_or_else(|p| p.into_inner());
                                for approval in pending.values_mut().filter(|approval|
                                    approval.connection_id == connection_id && approval.thread_id == thread_id
                                        && approval.turn_id == turn_id && approval.revision == previous) {
                                    approval.revision = current;
                                }
                            }
                        }
                        fresh_fallback_threads.remove(&thread_id);
                    }
                    if let Some((key, fork, fresh_start)) = take_active_writer_fallback_request(
                        text.as_ref(),
                        &mut resume_fallback_requests,
                    ) {
                        eprintln!(
                            "[codex-tui-proxy] resume target has an active writer; forking it instead"
                        );
                        upstream_sink
                            .send(Message::Text(fork.to_string().into()))
                            .await
                            .map_err(|error| format!("upstream fallback send failed: {error}"))?;
                        fresh_start_fallback_requests.insert(key, fresh_start);
                        continue;
                    }
                    if let Some((key, fresh_start)) = take_failed_fork_start_fallback_request(
                        text.as_ref(),
                        &mut fresh_start_fallback_requests,
                    ) {
                        eprintln!(
                            "[codex-tui-proxy] resume fork failed; starting a fresh thread instead"
                        );
                        // The original resume request registered this ID as a confirmed
                        // selection. A fresh thread/start is provisional until its first
                        // turn succeeds.
                        thread_selection_requests.insert(key, false);
                        upstream_sink
                            .send(Message::Text(fresh_start.to_string().into()))
                            .await
                            .map_err(|error| format!("upstream fresh-start send failed: {error}"))?;
                        continue;
                    }
                    if let Some(mut selection) = take_selected_thread_response(
                        text.as_ref(),
                        &mut thread_selection_requests,
                    ) {
                        if !selection.confirmed {
                            fresh_fallback_threads.insert(selection.id.clone());
                        }
                        let mut selected = selected_thread
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner());
                        selection.revision = selected
                            .as_ref()
                            .map_or(1, |current| current.revision.saturating_add(1));
                        owned_selection_revision = Some(selection.revision);
                        *selected = Some(selection);
                    }
                }
                client_sink.send(message).await
                    .map_err(|error| format!("TUI send failed: {error}"))?;
            }
        }
    }
    Ok(())
}

fn is_rpc_response(value: &Value) -> bool {
    value.get("method").is_none()
        && value.get("id").is_some()
        && (value.get("result").is_some() != value.get("error").is_some())
}

fn approval_item_key(thread_id: &str, turn_id: &str, item_id: &str) -> String {
    serde_json::json!([thread_id, turn_id, item_id]).to_string()
}

fn observe_approval_lifecycle(
    value: &Value,
    approvals: &CodexChatApprovals,
    connection_id: &str,
    file_changes: &mut HashMap<String, String>,
) {
    let Some(params) = value.get("params") else {
        return;
    };
    let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
        return;
    };
    let method = value.get("method").and_then(Value::as_str);
    if method == Some("serverRequest/resolved") {
        if let Some(id) = params.get("requestId") {
            approvals
                .pending
                .lock()
                .unwrap_or_else(|p| p.into_inner())
                .retain(|_, pending| {
                    pending.connection_id != connection_id
                        || pending.thread_id != thread_id
                        || pending.request_id != *id
                });
        }
        return;
    }
    let turn_id = params
        .get("turnId")
        .or_else(|| params.get("turn").and_then(|turn| turn.get("id")))
        .and_then(Value::as_str);
    let item = params.get("item");
    let item_id = params
        .get("itemId")
        .or_else(|| item.and_then(|item| item.get("id")))
        .and_then(Value::as_str);
    if matches!(
        method,
        Some("turn/completed" | "thread/closed" | "thread/deleted" | "item/completed")
    ) {
        approvals
            .pending
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .retain(|_, pending| {
                if pending.connection_id != connection_id || pending.thread_id != thread_id {
                    return true;
                }
                match method {
                    Some("turn/completed") => turn_id != Some(pending.turn_id.as_str()),
                    Some("item/completed") => {
                        turn_id != Some(pending.turn_id.as_str())
                            || item_id != Some(pending.item_id.as_str())
                    }
                    _ => false,
                }
            });
        // 完了済みの差分を次の承認へ再利用しない。
        if method != Some("item/completed") {
            file_changes.clear();
        }
    }
    let Some(turn_id) = turn_id else { return };
    let Some(item_id) = item_id else { return };
    let key = approval_item_key(thread_id, turn_id, item_id);
    if method == Some("item/completed") {
        file_changes.remove(&key);
        return;
    }
    let changes = match method {
        Some("item/started")
            if item
                .and_then(|item| item.get("type"))
                .and_then(Value::as_str)
                == Some("fileChange") =>
        {
            item.and_then(|item| item.get("changes"))
        }
        Some("item/fileChange/patchUpdated") => params.get("changes"),
        _ => return,
    };
    // 表示後に差分が変わった要求は古いボタンから回答させない。
    approvals
        .pending
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .retain(|_, pending| {
            pending.connection_id != connection_id
                || pending.thread_id != thread_id
                || pending.turn_id != turn_id
                || pending.item_id != item_id
        });
    file_changes.remove(&key);
    let Some(changes) = changes
        .and_then(Value::as_array)
        .filter(|changes| !changes.is_empty())
    else {
        return;
    };
    let mut detail = String::new();
    for change in changes {
        let Some(path) = change
            .get("path")
            .and_then(Value::as_str)
            .filter(|path| !path.is_empty())
        else {
            return;
        };
        let Some(diff) = change
            .get("diff")
            .and_then(Value::as_str)
            .filter(|diff| !diff.is_empty())
        else {
            return;
        };
        let Some(kind) = change.get("kind") else {
            return;
        };
        detail.push_str(&format!("{path}\n{}\n{diff}\n\n", kind));
        // 巨大な変更は内容を切り詰めて承認させず、通常の Terminal View に委ねる。
        if detail.len() > 256 * 1024 {
            return;
        }
    }
    if file_changes.len() >= 64 {
        file_changes.clear();
    }
    file_changes.insert(key, detail);
}

fn simple_approval_choice(display: ChatApprovalChoice, decision: &str) -> CodexApprovalChoice {
    CodexApprovalChoice {
        display,
        decision: Value::String(decision.to_string()),
    }
}

fn session_approval_choice() -> CodexApprovalChoice {
    simple_approval_choice(
        ChatApprovalChoice {
            id: "session".into(),
            label: ChatApprovalLabel::AllowSession,
            detail: None,
        },
        "acceptForSession",
    )
}

/// 明示された選択肢がある場合はそれだけを表示する。古い server は protocol の既定値を使う。
fn command_approval_choices(
    params: &Value,
    complete: bool,
    network: bool,
) -> Vec<CodexApprovalChoice> {
    let offered = match params
        .get("availableDecisions")
        .filter(|value| !value.is_null())
    {
        Some(Value::Array(decisions)) => decisions.clone(),
        Some(_) => return Vec::new(),
        None => {
            let mut decisions = vec![serde_json::json!("accept")];
            if network {
                decisions.push(serde_json::json!("acceptForSession"));
                if let Some(amendment) = params
                    .get("proposedNetworkPolicyAmendments")
                    .and_then(Value::as_array)
                    .and_then(|items| {
                        items.iter().find(|item| {
                            item.get("action").and_then(Value::as_str) == Some("allow")
                        })
                    })
                {
                    decisions.push(serde_json::json!({"applyNetworkPolicyAmendment":{"network_policy_amendment":amendment}}));
                }
            } else if params
                .get("additionalPermissions")
                .is_none_or(Value::is_null)
            {
                if let Some(amendment) = params
                    .get("proposedExecpolicyAmendment")
                    .filter(|value| !value.is_null())
                {
                    decisions.push(serde_json::json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":amendment}}));
                }
            }
            decisions.push(serde_json::json!("cancel"));
            decisions
        }
    };
    let mut choices = Vec::new();
    let mut seen = HashSet::new();
    let mut detail_bytes = 0;
    for decision in offered.into_iter().take(32) {
        if !seen.insert(decision.to_string()) {
            continue;
        }
        let display = match decision.as_str() {
            Some("accept") if complete => ChatApprovalChoice::allow_once(),
            Some("acceptForSession") if complete => session_approval_choice().display,
            Some("decline" | "cancel") => {
                if choices
                    .iter()
                    .any(|choice: &CodexApprovalChoice| choice.display.id == "deny")
                {
                    continue;
                }
                ChatApprovalChoice::deny()
            }
            Some(_) => continue,
            None if complete => {
                let Some(object) = decision.as_object().filter(|object| object.len() == 1) else {
                    continue;
                };
                let (label, detail) = if let Some(update) = object
                    .get("acceptWithExecpolicyAmendment")
                    .and_then(Value::as_object)
                    .filter(|update| update.len() == 1)
                {
                    let Some(prefix) = update
                        .get("execpolicy_amendment")
                        .and_then(Value::as_array)
                        .filter(|prefix| {
                            !prefix.is_empty()
                                && prefix
                                    .iter()
                                    .all(|part| part.as_str().is_some_and(|s| !s.is_empty()))
                        })
                    else {
                        continue;
                    };
                    if network {
                        continue;
                    }
                    (
                        ChatApprovalLabel::AllowRule,
                        format!(
                            "Saved command prefix rule / 保存するコマンド先頭の規則:\n{}",
                            serde_json::to_string_pretty(prefix).unwrap_or_default()
                        ),
                    )
                } else if let Some(update) = object
                    .get("applyNetworkPolicyAmendment")
                    .and_then(Value::as_object)
                    .filter(|update| update.len() == 1)
                {
                    let Some(rule) = update
                        .get("network_policy_amendment")
                        .and_then(Value::as_object)
                    else {
                        continue;
                    };
                    if !network
                        || rule.len() != 2
                        || rule
                            .get("host")
                            .and_then(Value::as_str)
                            .is_none_or(|host| host.is_empty())
                    {
                        continue;
                    }
                    let label = match rule.get("action").and_then(Value::as_str) {
                        Some("allow") => ChatApprovalLabel::AllowNetwork,
                        Some("deny") => ChatApprovalLabel::DenyNetwork,
                        _ => continue,
                    };
                    (
                        label,
                        format!(
                            "Saved network rule / 保存する接続先の規則:\n{}",
                            serde_json::to_string_pretty(rule).unwrap_or_default()
                        ),
                    )
                } else {
                    continue;
                };
                detail_bytes += detail.len();
                if detail_bytes > 256 * 1024 {
                    continue;
                }
                ChatApprovalChoice {
                    id: uuid::Uuid::new_v4().to_string(),
                    label,
                    detail: Some(detail),
                }
            }
            _ => continue,
        };
        choices.push(CodexApprovalChoice { display, decision });
    }
    choices
}

fn capture_chat_approval(
    value: &Value,
    approvals: &CodexChatApprovals,
    connection_id: &str,
    owned_revision: Option<u64>,
    sender: &mpsc::UnboundedSender<ApprovalCommand>,
    file_changes: &HashMap<String, String>,
) {
    let Some(method) = value.get("method").and_then(Value::as_str) else {
        return;
    };
    let Some(id) = value
        .get("id")
        .filter(|id| id.is_string() || id.is_i64() || id.is_u64())
    else {
        return;
    };
    // 同じ RPC ID の新要求は、未対応・不正な内容でも旧カードを先に失効させる。
    approvals.remove_rpc(connection_id, id);
    if !matches!(
        method,
        "item/commandExecution/requestApproval" | "item/fileChange/requestApproval"
    ) {
        return;
    }
    let Some(params) = value.get("params") else {
        return;
    };
    let Some(thread_id) = params
        .get("threadId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let Some(turn_id) = params
        .get("turnId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let Some(item_id) = params
        .get("itemId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let selected = approvals
        .selected_thread
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let Some(selected) = selected
        .as_ref()
        .filter(|selected| selected.id == thread_id && Some(selected.revision) == owned_revision)
    else {
        return;
    };
    let (title, mut detail, choices) = if method == "item/commandExecution/requestApproval" {
        if params
            .get("kind")
            .is_some_and(|kind| kind.as_str() != Some("command"))
        {
            return;
        }
        let command = params
            .get("command")
            .and_then(Value::as_str)
            .filter(|command| !command.trim().is_empty());
        let mut detail = command
            .unwrap_or("Command details are unavailable.")
            .to_string();
        if let Some(cwd) = params.get("cwd").and_then(Value::as_str) {
            detail.push_str(&format!("\n\nWorking directory: {cwd}"));
        }
        for (key, label) in [
            ("environmentId", "Environment"),
            ("additionalPermissions", "Requested permissions"),
            ("networkApprovalContext", "Network access"),
        ] {
            if let Some(value) = params.get(key).filter(|value| !value.is_null()) {
                detail.push_str(&format!("\n\n{label}: {value}"));
            }
        }
        let network = params
            .get("networkApprovalContext")
            .filter(|value| !value.is_null());
        let complete = network.map_or(command.is_some(), |context| {
            context
                .get("host")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.trim().is_empty())
                && matches!(
                    context.get("protocol").and_then(Value::as_str),
                    Some("http" | "https" | "socks5Tcp" | "socks5Udp")
                )
        });
        (
            if network.is_some() {
                "Network access"
            } else {
                "Run command"
            }
            .to_string(),
            detail,
            command_approval_choices(params, complete, network.is_some()),
        )
    } else {
        let detail = file_changes
            .get(&approval_item_key(thread_id, turn_id, item_id))
            .cloned();
        let mut choices = Vec::new();
        if detail.is_some() {
            choices.push(simple_approval_choice(
                ChatApprovalChoice::allow_once(),
                "accept",
            ));
            choices.push(session_approval_choice());
        }
        choices.push(simple_approval_choice(
            ChatApprovalChoice::deny(),
            "decline",
        ));
        let mut detail = detail.unwrap_or_else(|| "The complete file changes are unavailable. Review them in Terminal View before allowing.".to_string());
        if let Some(root) = params.get("grantRoot").and_then(Value::as_str) {
            detail.push_str(&format!("\nRequested write root: {root}"));
        }
        ("Change files".to_string(), detail, choices)
    };
    if choices.is_empty() {
        return;
    }
    if let Some(reason) = params.get("reason").and_then(Value::as_str) {
        detail.push_str(&format!("\n\nReason: {reason}"));
    }
    if detail.len() > 256 * 1024 {
        return;
    }
    let mut pending = approvals.pending.lock().unwrap_or_else(|p| p.into_inner());
    if pending.len() >= 128 {
        return;
    }
    pending.insert(
        uuid::Uuid::new_v4().to_string(),
        PendingApproval {
            connection_id: connection_id.to_string(),
            request_id: id.clone(),
            thread_id: thread_id.to_string(),
            turn_id: turn_id.to_string(),
            item_id: item_id.to_string(),
            revision: selected.revision,
            title,
            detail,
            choices,
            sender: sender.clone(),
        },
    );
}

/// A newly started paginated thread is usable immediately, but Codex does not
/// materialize its persisted history until the first user turn. The TUI always
/// hydrates a selection with bounded turn and item requests, so answer those
/// requests as the empty history that the fresh thread actually has.
fn empty_unmaterialized_history_response(
    raw: &str,
    fresh_threads: &HashSet<String>,
) -> Option<Message> {
    let message = serde_json::from_str::<Value>(raw).ok()?;
    let method = message.get("method").and_then(Value::as_str)?;
    if !matches!(method, "thread/turns/list" | "thread/items/list") {
        return None;
    }
    let thread_id = message
        .get("params")
        .and_then(|params| params.get("threadId"))
        .and_then(Value::as_str)?;
    if !fresh_threads.contains(thread_id) {
        return None;
    }
    let id = message.get("id")?.clone();
    Some(Message::Text(
        serde_json::json!({
            "id": id,
            "result": {
                "data": [],
                "nextCursor": null,
                "backwardsCursor": null
            }
        })
        .to_string()
        .into(),
    ))
}

fn request_id_key(value: &Value) -> Option<String> {
    serde_json::to_string(value).ok()
}

fn track_thread_selection_request(raw: &str, pending: &mut HashMap<String, bool>) {
    let Ok(message) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let method = message.get("method").and_then(Value::as_str);
    let ephemeral = message
        .get("params")
        .and_then(|params| params.get("ephemeral"))
        .and_then(Value::as_bool)
        == Some(true);
    let confirmed = match method {
        // Codex creates ephemeral low-effort threads for internal work such as task-title
        // generation. Those requests share the TUI transport but never represent a user
        // workspace selection, so they must not replace the backing thread used by GPT Live.
        Some("thread/start") if !ephemeral => Some(false),
        Some("thread/resume") => Some(true),
        Some("thread/fork") if !ephemeral => (message
            .get("params")
            .and_then(|params| params.get("excludeTurns"))
            .and_then(Value::as_bool)
            != Some(true))
        .then_some(true),
        _ => None,
    };
    if let (Some(key), Some(confirmed)) = (message.get("id").and_then(request_id_key), confirmed) {
        pending.insert(key, confirmed);
    }
}

fn track_turn_start_request(raw: &str, pending: &mut HashMap<String, String>) {
    let Ok(message) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    if message.get("method").and_then(Value::as_str) != Some("turn/start") {
        return;
    }
    let Some(thread_id) = message
        .get("params")
        .and_then(|params| params.get("threadId"))
        .and_then(Value::as_str)
    else {
        return;
    };
    if let Some(key) = message.get("id").and_then(request_id_key) {
        pending.insert(key, thread_id.to_string());
    }
}

fn take_successful_turn_start_response(
    raw: &str,
    pending: &mut HashMap<String, String>,
) -> Option<String> {
    let message = serde_json::from_str::<Value>(raw).ok()?;
    let object = message.as_object()?;
    if object.contains_key("method") {
        return None;
    }
    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    if has_result == has_error {
        return None;
    }
    let key = message.get("id").and_then(request_id_key)?;
    let thread_id = pending.remove(&key)?;
    has_result.then_some(thread_id)
}

fn mark_selected_thread_confirmed(
    thread_id: &str,
    selected_thread: &Arc<Mutex<Option<SelectedThread>>>,
) -> Option<u64> {
    let mut selected = selected_thread
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(selected) = selected
        .as_mut()
        .filter(|selected| selected.id == thread_id)
    {
        selected.confirmed = true;
        selected.revision = selected.revision.saturating_add(1);
        return Some(selected.revision);
    }
    None
}

/// Keep a `thread/fork` equivalent of each resume request until its response arrives.
/// If Codex rejects the resume because another process still owns the thread writer
/// lock, the proxy can retry the same selection as a fork without restarting the TUI.
#[derive(Clone, Debug, PartialEq)]
struct ResumeFallback {
    fork: Value,
    fresh_start: Value,
}

fn track_resume_fallback_request(raw: &str, pending: &mut HashMap<String, ResumeFallback>) {
    const FORK_COMPATIBLE_RESUME_FIELDS: &[&str] = &[
        "approvalPolicy",
        "approvalsReviewer",
        "baseInstructions",
        "config",
        "cwd",
        "developerInstructions",
        "excludeTurns",
        "model",
        "modelProvider",
        "permissions",
        "runtimeWorkspaceRoots",
        "sandbox",
        "serviceTier",
        "threadId",
    ];

    let Ok(message) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    if message.get("method").and_then(Value::as_str) != Some("thread/resume") {
        return;
    }
    let Some(key) = message.get("id").and_then(request_id_key) else {
        return;
    };

    let mut fork = message.clone();
    fork["method"] = Value::String("thread/fork".to_string());
    if let Some(params) = fork.get_mut("params").and_then(Value::as_object_mut) {
        // Forward only fields accepted by both ThreadResumeParams and
        // ThreadForkParams. A future resume-only field must not make the fallback
        // fail with invalid params merely because the proxy did not know to drop it.
        //
        // In particular, do not forward `path`: Codex gives a non-empty rollout
        // path precedence over `threadId` for fork. The resume target's rollout is
        // still owned by the active writer, so retrying by path can hit the same
        // writer lock instead of creating an independent fork. Forking by thread ID
        // reads the persisted history without contending for that live rollout.
        params.retain(|key, _| FORK_COMPATIBLE_RESUME_FIELDS.contains(&key.as_str()));
    }

    const START_COMPATIBLE_RESUME_FIELDS: &[&str] = &[
        "approvalPolicy",
        "approvalsReviewer",
        "baseInstructions",
        "config",
        "cwd",
        "developerInstructions",
        "model",
        "modelProvider",
        "permissions",
        "runtimeWorkspaceRoots",
        "sandbox",
        "serviceTier",
    ];
    let mut fresh_start = message;
    fresh_start["method"] = Value::String("thread/start".to_string());
    if let Some(params) = fresh_start.get_mut("params").and_then(Value::as_object_mut) {
        params.retain(|key, _| START_COMPATIBLE_RESUME_FIELDS.contains(&key.as_str()));
        // The TUI requested `excludeTurns` on resume and hydrates turns after the
        // selection response. A legacy blank thread is not materialized until its
        // first user message, so that hydration fails and exits the TUI. Paginated
        // blank threads support an empty turns page immediately.
        params.insert(
            "historyMode".to_string(),
            Value::String("paginated".to_string()),
        );
    }
    pending.insert(key, ResumeFallback { fork, fresh_start });
}

fn take_active_writer_fallback_request(
    raw: &str,
    pending: &mut HashMap<String, ResumeFallback>,
) -> Option<(String, Value, Value)> {
    let message = serde_json::from_str::<Value>(raw).ok()?;
    let object = message.as_object()?;
    if object.contains_key("method") {
        return None;
    }
    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    if has_result == has_error {
        return None;
    }
    let key = message.get("id").and_then(request_id_key)?;
    let fallback = pending.remove(&key)?;
    let error = message.get("error")?;
    let is_active_writer = error.get("code").and_then(Value::as_i64) == Some(-32600)
        && error
            .get("message")
            .and_then(Value::as_str)
            .is_some_and(|message| message.contains("already has an active writer"));
    is_active_writer.then_some((key, fallback.fork, fallback.fresh_start))
}

/// A fork can still fail when the source history is incomplete or corrupt (for
/// example, when Ctrl+C interrupts a paginated writer between projection
/// records). The protected main session must remain recoverable, so use a fresh
/// thread as the final fallback. Successful fork responses merely clear this
/// pending fallback and continue to the TUI unchanged.
fn take_failed_fork_start_fallback_request(
    raw: &str,
    pending: &mut HashMap<String, Value>,
) -> Option<(String, Value)> {
    let message = serde_json::from_str::<Value>(raw).ok()?;
    let object = message.as_object()?;
    if object.contains_key("method") {
        return None;
    }
    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    if has_result == has_error {
        return None;
    }
    let key = message.get("id").and_then(request_id_key)?;
    let fresh_start = pending.remove(&key)?;
    has_error.then_some((key, fresh_start))
}

fn take_selected_thread_response(
    raw: &str,
    pending: &mut HashMap<String, bool>,
) -> Option<SelectedThread> {
    let message = serde_json::from_str::<Value>(raw).ok()?;
    let object = message.as_object()?;
    if object.contains_key("method") {
        return None;
    }
    let has_result = object.contains_key("result");
    let has_error = object.contains_key("error");
    if has_result == has_error {
        return None;
    }
    let key = message.get("id").and_then(request_id_key)?;
    let confirmed = pending.remove(&key)?;
    let id = message
        .get("result")?
        .get("thread")?
        .get("id")?
        .as_str()
        .filter(|thread_id| !thread_id.is_empty())?;
    Some(SelectedThread {
        id: id.to_string(),
        confirmed,
        // proxy_connection が共有 state へ格納するとき単調 revision を割り当てる。
        revision: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::tungstenite::{
        client::IntoClientRequest,
        http::{header::ORIGIN, HeaderValue},
    };

    fn approval_fixture() -> (
        CodexChatApprovals,
        mpsc::UnboundedSender<ApprovalCommand>,
        mpsc::UnboundedReceiver<ApprovalCommand>,
    ) {
        let approvals = CodexChatApprovals::default();
        *approvals.selected_thread.lock().unwrap() = Some(SelectedThread {
            id: "thread".into(),
            confirmed: true,
            revision: 1,
        });
        let (sender, receiver) = mpsc::unbounded_channel();
        (approvals, sender, receiver)
    }

    fn command_approval(id: Value) -> Value {
        serde_json::json!({ "id": id, "method": "item/commandExecution/requestApproval", "params": {
            "threadId": "thread", "turnId": "turn", "itemId": "item", "command": "printf 'hello'", "cwd": "/workspace", "reason": "Run the requested command"
        } })
    }

    fn capture(
        approvals: &CodexChatApprovals,
        sender: &mpsc::UnboundedSender<ApprovalCommand>,
        value: Value,
    ) {
        capture_chat_approval(
            &value,
            approvals,
            "connection",
            Some(1),
            sender,
            &HashMap::new(),
        );
    }

    fn response_command(token: &str, decision: ChatApprovalDecision) -> ApprovalCommand {
        let (reply, _) = oneshot::channel();
        ApprovalCommand {
            token: token.to_string(),
            decision,
            reply,
        }
    }

    #[test]
    fn approval_response_consumes_exact_request_once_without_policy_expansion() {
        let (approvals, sender, _receiver) = approval_fixture();
        capture(&approvals, &sender, command_approval(serde_json::json!(7)));
        let cards = approvals.list("host-session");
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].session_id, "host-session");
        assert!(cards[0].detail.contains("printf 'hello'"));
        assert!(cards[0].detail.contains("/workspace"));
        let command = response_command(&cards[0].id, "allow".to_string());
        let (response, thread_id) = approvals.take_response(&command, "connection").unwrap();
        assert_eq!(
            response,
            serde_json::json!({ "id": 7, "result": { "decision": "accept" } })
        );
        assert_eq!(thread_id, "thread");
        assert!(approvals.take_response(&command, "connection").is_err());
        assert!(approvals.list("host-session").is_empty());
    }

    #[test]
    fn approval_honors_server_decisions_and_rejects_missing_command_or_write_stdin() {
        let (approvals, sender, _receiver) = approval_fixture();
        let mut value = command_approval(serde_json::json!(1));
        value["params"]["availableDecisions"] = serde_json::json!(["acceptForSession", "cancel"]);
        capture(&approvals, &sender, value);
        let card = approvals.list("session").remove(0);
        assert_eq!(card.choices.len(), 2);
        assert!(approvals
            .take_response(
                &response_command(&card.id, "allow".to_string()),
                "connection"
            )
            .is_err());
        let (response, _) = approvals
            .take_response(
                &response_command(&card.id, "deny".to_string()),
                "connection",
            )
            .unwrap();
        assert_eq!(response["result"]["decision"], "cancel");

        let mut value = command_approval(serde_json::json!(2));
        value["params"]["command"] = Value::Null;
        capture(&approvals, &sender, value);
        let card = approvals.list("session").remove(0);
        assert!(approvals
            .take_response(
                &response_command(&card.id, "allow".to_string()),
                "connection"
            )
            .is_err());
        approvals.invalidate_connection("connection");
        let mut value = command_approval(serde_json::json!(3));
        value["params"]["kind"] = serde_json::json!("writeStdin");
        capture(&approvals, &sender, value);
        assert!(approvals.list("session").is_empty());
    }

    #[test]
    fn absent_available_decisions_preserve_provider_defaults_by_request_type() {
        let ordinary = command_approval_choices(&serde_json::json!({}), true, false);
        assert_eq!(
            ordinary
                .iter()
                .map(|choice| choice.display.id.as_str())
                .collect::<Vec<_>>(),
            vec!["allow", "deny"]
        );
        assert_eq!(ordinary[1].decision, serde_json::json!("cancel"));
        let additional = command_approval_choices(
            &serde_json::json!({"additionalPermissions":{},"proposedExecpolicyAmendment":["git"]}),
            true,
            false,
        );
        assert_eq!(additional.len(), 2);
        let network = command_approval_choices(
            &serde_json::json!({"proposedNetworkPolicyAmendments":[
                {"host":"example.com","action":"deny"},
                {"host":"example.com","action":"allow"},
                {"host":"other.example.com","action":"allow"}
            ]}),
            true,
            true,
        );
        assert_eq!(network.len(), 4);
        assert_eq!(network[1].display.label, ChatApprovalLabel::AllowSession);
        assert_eq!(
            network[2].decision["applyNetworkPolicyAmendment"]["network_policy_amendment"]["host"],
            "example.com"
        );
    }

    #[test]
    fn ongoing_approval_returns_only_the_exact_offered_provider_decision() {
        for decision in [
            serde_json::json!("acceptForSession"),
            serde_json::json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","status"]}}),
            serde_json::json!({"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","diff"]}}),
        ] {
            let (approvals, sender, _receiver) = approval_fixture();
            let mut value = command_approval(serde_json::json!(7));
            value["params"]["availableDecisions"] =
                serde_json::json!(["accept", decision, "cancel"]);
            capture(&approvals, &sender, value);
            let card = approvals.list("session").remove(0);
            assert_eq!(card.choices.len(), 3);
            let choice = card
                .choices
                .iter()
                .find(|choice| choice.id != "allow" && choice.id != "deny")
                .unwrap();
            if decision.is_object() {
                assert_eq!(choice.label, ChatApprovalLabel::AllowRule);
                assert!(choice.detail.as_ref().unwrap().contains(
                    decision["acceptWithExecpolicyAmendment"]["execpolicy_amendment"][1]
                        .as_str()
                        .unwrap()
                ));
            } else {
                assert_eq!(choice.label, ChatApprovalLabel::AllowSession);
            }
            assert!(approvals
                .take_response(
                    &response_command(&card.id, "unoffered-policy".into()),
                    "connection"
                )
                .is_err());
            let (response, _) = approvals
                .take_response(&response_command(&card.id, choice.id.clone()), "connection")
                .unwrap();
            assert_eq!(
                response,
                serde_json::json!({"id":7,"result":{"decision":decision}})
            );
            assert!(approvals
                .take_response(&response_command(&card.id, choice.id.clone()), "connection")
                .is_err());
        }
    }

    #[test]
    fn offered_rules_have_distinct_ids_and_unoffered_proposals_stay_hidden() {
        let params = serde_json::json!({"availableDecisions":[
            "accept",
            {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","status"]}},
            {"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","diff"]}},
            "cancel"
        ]});
        let choices = command_approval_choices(&params, true, false);
        assert_eq!(choices.len(), 4);
        assert_ne!(choices[1].display.id, choices[2].display.id);
        let params = serde_json::json!({"availableDecisions":["accept","cancel"],"proposedExecpolicyAmendment":["git","status"]});
        assert_eq!(command_approval_choices(&params, true, false).len(), 2);
        let choices = command_approval_choices(&params, false, false);
        assert_eq!(choices.len(), 1);
        assert_eq!(choices[0].display.id, "deny");
    }

    #[test]
    fn invalid_replacements_revoke_old_rule_choices_before_validation() {
        let mut replacements = Vec::new();
        for decisions in [
            serde_json::json!([]),
            serde_json::json!(["unknown"]),
            serde_json::json!({"invalid":true}),
        ] {
            let mut replacement = command_approval(serde_json::json!(7));
            replacement["params"]["availableDecisions"] = decisions;
            replacements.push(replacement);
        }
        for kind in [
            serde_json::json!("writeStdin"),
            Value::Null,
            serde_json::json!(7),
            serde_json::json!({}),
        ] {
            let mut unsupported = command_approval(serde_json::json!(7));
            unsupported["params"]["kind"] = kind;
            replacements.push(unsupported);
        }
        let mut unsupported = command_approval(serde_json::json!(7));
        unsupported["method"] = serde_json::json!("item/permissions/requestApproval");
        replacements.push(unsupported);
        let mut oversized = command_approval(serde_json::json!(7));
        oversized["params"]["command"] = serde_json::json!("x".repeat(256 * 1024 + 1));
        replacements.push(oversized);
        for replacement in replacements {
            let (approvals, sender, _receiver) = approval_fixture();
            let mut original = command_approval(serde_json::json!(7));
            original["params"]["availableDecisions"] = serde_json::json!([{"acceptWithExecpolicyAmendment":{"execpolicy_amendment":["git","status"]}}]);
            capture(&approvals, &sender, original);
            let old = approvals.list("session").remove(0);
            capture(&approvals, &sender, replacement);
            assert!(approvals.list("session").is_empty());
            assert!(approvals
                .take_response(
                    &response_command(&old.id, old.choices[0].id.clone()),
                    "connection"
                )
                .is_err());
        }
    }

    #[test]
    fn network_rules_preserve_the_exact_destination_and_action() {
        for action in ["allow", "deny"] {
            let (approvals, sender, _receiver) = approval_fixture();
            let decision = serde_json::json!({"applyNetworkPolicyAmendment":{"network_policy_amendment":{"host":"example.com","action":action}}});
            let mut value = command_approval(serde_json::json!(7));
            value["params"]["command"] = Value::Null;
            value["params"]["networkApprovalContext"] =
                serde_json::json!({"host":"example.com","protocol":"https"});
            value["params"]["availableDecisions"] = serde_json::json!([decision, "cancel"]);
            capture(&approvals, &sender, value);
            let card = approvals.list("session").remove(0);
            assert_eq!(card.title, "Network access");
            let choice = card
                .choices
                .iter()
                .find(|choice| choice.id != "deny")
                .unwrap();
            assert!(choice.detail.as_ref().unwrap().contains("example.com"));
            let (response, _) = approvals
                .take_response(&response_command(&card.id, choice.id.clone()), "connection")
                .unwrap();
            assert_eq!(response["result"]["decision"], decision);
        }
    }

    #[test]
    fn stale_selection_and_wrong_connection_cannot_resolve_approval() {
        let (approvals, sender, _receiver) = approval_fixture();
        capture(&approvals, &sender, command_approval(serde_json::json!(1)));
        let card = approvals.list("session").remove(0);
        let command = response_command(&card.id, "allow".to_string());
        assert!(approvals
            .take_response(&command, "another-connection")
            .is_err());
        approvals
            .selected_thread
            .lock()
            .unwrap()
            .as_mut()
            .unwrap()
            .revision = 3;
        assert!(approvals.list("session").is_empty());
        assert!(approvals.take_response(&command, "connection").is_err());
        capture(&approvals, &sender, command_approval(serde_json::json!(2)));
        assert_eq!(approvals.pending.lock().unwrap().len(), 1);
    }

    #[test]
    fn numeric_and_string_rpc_ids_and_connections_are_distinct() {
        let (approvals, sender, _receiver) = approval_fixture();
        capture(&approvals, &sender, command_approval(serde_json::json!(7)));
        capture(
            &approvals,
            &sender,
            command_approval(serde_json::json!("7")),
        );
        capture_chat_approval(
            &command_approval(serde_json::json!(7)),
            &approvals,
            "another",
            Some(1),
            &sender,
            &HashMap::new(),
        );
        assert_eq!(approvals.list("session").len(), 3);
        approvals.remove_rpc("connection", &serde_json::json!(7));
        assert_eq!(approvals.list("session").len(), 2);
        approvals.invalidate_connection("connection");
        assert_eq!(approvals.list("session").len(), 1);
    }

    #[test]
    fn replaced_request_invalidates_previous_display_token() {
        let (approvals, sender, _receiver) = approval_fixture();
        capture(&approvals, &sender, command_approval(serde_json::json!(1)));
        let old = approvals.list("session").remove(0);
        let mut changed = command_approval(serde_json::json!(1));
        changed["params"]["command"] = serde_json::json!("printf 'updated'");
        capture(&approvals, &sender, changed);
        assert!(approvals
            .take_response(
                &response_command(&old.id, "allow".to_string()),
                "connection"
            )
            .is_err());
        let new = approvals.list("session").remove(0);
        assert_ne!(old.id, new.id);
        assert!(new.detail.contains("updated"));
    }

    #[test]
    fn resolved_completed_and_disconnected_requests_are_removed() {
        let (approvals, sender, _receiver) = approval_fixture();
        let mut files = HashMap::new();
        for event in [
            serde_json::json!({"method":"serverRequest/resolved","params":{"threadId":"thread","requestId":1}}),
            serde_json::json!({"method":"turn/completed","params":{"threadId":"thread","turn":{"id":"turn"}}}),
            serde_json::json!({"method":"item/completed","params":{"threadId":"thread","turnId":"turn","item":{"id":"item"}}}),
            serde_json::json!({"method":"thread/closed","params":{"threadId":"thread"}}),
        ] {
            capture(&approvals, &sender, command_approval(serde_json::json!(1)));
            observe_approval_lifecycle(&event, &approvals, "connection", &mut files);
            assert!(approvals.list("session").is_empty());
        }
        capture(&approvals, &sender, command_approval(serde_json::json!(1)));
        drop(ApprovalConnectionGuard {
            approvals: approvals.clone(),
            connection_id: "connection".into(),
        });
        assert!(approvals.list("session").is_empty());
    }

    #[test]
    fn file_approval_requires_complete_exact_diff_and_invalidates_after_patch_update() {
        let (approvals, sender, _receiver) = approval_fixture();
        let value = serde_json::json!({"id":1,"method":"item/fileChange/requestApproval","params":{"threadId":"thread","turnId":"turn","itemId":"patch"}});
        capture(&approvals, &sender, value.clone());
        let card = approvals.list("session").remove(0);
        assert!(approvals
            .take_response(
                &response_command(&card.id, "allow".to_string()),
                "connection"
            )
            .is_err());
        let mut files = HashMap::new();
        let patch = serde_json::json!({"method":"item/fileChange/patchUpdated","params":{"threadId":"thread","turnId":"turn","itemId":"patch","changes":[{"path":"/workspace/file","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1 @@\n-before\n+after"}]}});
        observe_approval_lifecycle(&patch, &approvals, "connection", &mut files);
        capture_chat_approval(&value, &approvals, "connection", Some(1), &sender, &files);
        let card = approvals.list("session").remove(0);
        assert_eq!(card.choices.len(), 3);
        assert!(card.detail.contains("/workspace/file"));
        assert!(card.detail.contains("-before\n+after"));
        observe_approval_lifecycle(&patch, &approvals, "connection", &mut files);
        assert!(approvals
            .take_response(
                &response_command(&card.id, "allow".to_string()),
                "connection"
            )
            .is_err());
    }

    #[tokio::test]
    async fn chat_approval_uses_original_upstream_connection_and_suppresses_late_tui_reply() {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let proxy =
            CodexTuiProxy::spawn(format!("ws://{}", listener.local_addr().unwrap())).unwrap();
        let (mut client, _) = tokio_tungstenite::connect_async(proxy.endpoint())
            .await
            .unwrap();
        let (stream, _) = listener.accept().await.unwrap();
        let mut server = tokio_tungstenite::accept_async(stream).await.unwrap();
        client
            .send(Message::Text(
                serde_json::json!({"method":"thread/resume","id":1,"params":{"threadId":"thread"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        server.next().await.unwrap().unwrap();
        server
            .send(Message::Text(
                serde_json::json!({"id":1,"result":{"thread":{"id":"thread"}}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        client.next().await.unwrap().unwrap();
        client
            .send(Message::Text(
                serde_json::json!({"method":"turn/start","id":3,"params":{"threadId":"thread"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        server.next().await.unwrap().unwrap();
        server
            .send(Message::Text(
                command_approval(serde_json::json!("approval-7"))
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        client.next().await.unwrap().unwrap();
        let card = proxy.chat_approvals("session").remove(0);
        // 承認通知が turn/start response より先着しても、同じ turn の要求を失わない。
        server
            .send(Message::Text(
                serde_json::json!({"id":3,"result":{"turn":{"id":"turn"}}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        client.next().await.unwrap().unwrap();
        assert_eq!(proxy.chat_approvals("session")[0].id, card.id);
        proxy
            .chat_approval_handle()
            .respond(&card.id, "allow".to_string())
            .await
            .unwrap();
        let Message::Text(response) = server.next().await.unwrap().unwrap() else {
            panic!("response text")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&response).unwrap(),
            serde_json::json!({"id":"approval-7","result":{"decision":"accept"}})
        );
        let Message::Text(resolved) = client.next().await.unwrap().unwrap() else {
            panic!("resolved text")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&resolved).unwrap()["method"],
            "serverRequest/resolved"
        );
        assert!(proxy
            .chat_approval_handle()
            .respond(&card.id, "deny".to_string())
            .await
            .is_err());
        client
            .send(Message::Text(
                serde_json::json!({"id":"approval-7","result":{"decision":"decline"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        client
            .send(Message::Text(
                serde_json::json!({"method":"test/sentinel"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let Message::Text(next) = server.next().await.unwrap().unwrap() else {
            panic!("sentinel text")
        };
        assert_eq!(
            serde_json::from_str::<Value>(&next).unwrap()["method"],
            "test/sentinel"
        );
        assert!(proxy.chat_approvals("session").is_empty());

        // 会話タイトル生成の内部 turn が成功しても、その後の本会話の承認を受け取れる。
        for (request, response) in [
            (
                serde_json::json!({"method":"thread/start","id":"title","params":{"ephemeral":true}}),
                serde_json::json!({"id":"title","result":{"thread":{"id":"title-thread"}}}),
            ),
            (
                serde_json::json!({"method":"turn/start","id":"title-turn","params":{"threadId":"title-thread"}}),
                serde_json::json!({"id":"title-turn","result":{"turn":{"id":"generated-title"}}}),
            ),
        ] {
            client
                .send(Message::Text(request.to_string().into()))
                .await
                .unwrap();
            server.next().await.unwrap().unwrap();
            server
                .send(Message::Text(response.to_string().into()))
                .await
                .unwrap();
            client.next().await.unwrap().unwrap();
        }

        // Terminal 側が先に回答した場合、Chat の表示済みボタンは失効する。
        server
            .send(Message::Text(
                command_approval(serde_json::json!(8)).to_string().into(),
            ))
            .await
            .unwrap();
        client.next().await.unwrap().unwrap();
        let card = proxy.chat_approvals("session").remove(0);
        client
            .send(Message::Text(
                serde_json::json!({"id":8,"result":{"decision":"decline"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let Message::Text(response) = server.next().await.unwrap().unwrap() else {
            panic!("native response")
        };
        assert_eq!(serde_json::from_str::<Value>(&response).unwrap()["id"], 8);
        assert!(proxy
            .chat_approval_handle()
            .respond(&card.id, "allow".to_string())
            .await
            .is_err());

        // 会話切替の response を待たず、要求を出した時点で旧カードを無効にする。
        server
            .send(Message::Text(
                command_approval(serde_json::json!(9)).to_string().into(),
            ))
            .await
            .unwrap();
        client.next().await.unwrap().unwrap();
        let card = proxy.chat_approvals("session").remove(0);
        client
            .send(Message::Text(
                serde_json::json!({"method":"thread/resume","id":2,"params":{"threadId":"other"}})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        server.next().await.unwrap().unwrap();
        assert!(proxy.chat_approvals("session").is_empty());
        assert!(proxy
            .chat_approval_handle()
            .respond(&card.id, "allow".to_string())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn forwards_websocket_messages_and_records_the_selected_thread() {
        let upstream_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("upstream listener");
        let upstream_address = upstream_listener.local_addr().expect("upstream address");
        let upstream_task = tokio::spawn(async move {
            let (stream, _) = upstream_listener.accept().await.expect("upstream accept");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("upstream handshake");
            let request = socket
                .next()
                .await
                .expect("request")
                .expect("valid request");
            assert!(matches!(request, Message::Text(_)));
            socket
                .send(Message::Text(
                    r#"{"id":7,"result":{"thread":{"id":"resumed"}}}"#.into(),
                ))
                .await
                .expect("upstream response");
        });

        let proxy =
            CodexTuiProxy::spawn(format!("ws://{upstream_address}")).expect("proxy should start");
        let (mut client, _) = tokio_tungstenite::connect_async(proxy.endpoint())
            .await
            .expect("proxy handshake");
        client
            .send(Message::Text(
                r#"{"method":"thread/resume","id":7,"params":{"threadId":"old"}}"#.into(),
            ))
            .await
            .expect("proxy request");
        let response = client
            .next()
            .await
            .expect("response")
            .expect("valid response");
        assert!(matches!(response, Message::Text(_)));

        for _ in 0..20 {
            if proxy.selected_thread_id().as_deref() == Some("resumed") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(proxy.selected_thread_id().as_deref(), Some("resumed"));
        assert_eq!(
            proxy.selected_thread(),
            Some(SelectedThread {
                id: "resumed".to_string(),
                confirmed: true,
                revision: 1,
            })
        );
        upstream_task.await.expect("upstream task");
    }

    #[tokio::test]
    async fn rejects_websocket_handshakes_with_an_origin_header() {
        let proxy =
            CodexTuiProxy::spawn("ws://127.0.0.1:9".to_string()).expect("proxy should start");
        let mut request = proxy
            .endpoint()
            .into_client_request()
            .expect("valid proxy request");
        request
            .headers_mut()
            .insert(ORIGIN, HeaderValue::from_static("http://tauri.localhost"));

        let error = match tokio_tungstenite::connect_async(request).await {
            Ok(_) => panic!("Origin-bearing handshake must be rejected"),
            Err(error) => error,
        };
        let tokio_tungstenite::tungstenite::Error::Http(response) = error else {
            panic!("expected HTTP handshake rejection, got {error}");
        };
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }

    #[tokio::test]
    async fn retries_active_writer_resume_as_fork_without_forwarding_the_error() {
        let upstream_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("upstream listener");
        let upstream_address = upstream_listener.local_addr().expect("upstream address");
        let upstream_task = tokio::spawn(async move {
            let (stream, _) = upstream_listener.accept().await.expect("upstream accept");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("upstream handshake");

            let resume = socket
                .next()
                .await
                .expect("resume request")
                .expect("valid resume request");
            let Message::Text(resume) = resume else {
                panic!("expected text resume request");
            };
            let resume: Value = serde_json::from_str(resume.as_ref()).expect("resume json");
            assert_eq!(resume["method"], "thread/resume");

            socket
                .send(Message::Text(
                    r#"{"id":7,"error":{"code":-32600,"message":"thread old already has an active writer"}}"#
                        .into(),
                ))
                .await
                .expect("active writer response");

            let fork = socket
                .next()
                .await
                .expect("fork request")
                .expect("valid fork request");
            let Message::Text(fork) = fork else {
                panic!("expected text fork request");
            };
            let fork: Value = serde_json::from_str(fork.as_ref()).expect("fork json");
            assert_eq!(fork["id"], 7);
            assert_eq!(fork["method"], "thread/fork");
            assert_eq!(fork["params"]["threadId"], "old");
            assert_eq!(fork["params"]["cwd"], "/workspace");
            assert!(fork["params"].get("path").is_none());
            assert!(fork["params"].get("history").is_none());
            assert!(fork["params"].get("initialTurnsPage").is_none());
            assert!(fork["params"].get("personality").is_none());

            socket
                .send(Message::Text(
                    r#"{"id":7,"result":{"thread":{"id":"forked"}}}"#.into(),
                ))
                .await
                .expect("fork response");
        });

        let proxy =
            CodexTuiProxy::spawn(format!("ws://{upstream_address}")).expect("proxy should start");
        let (mut client, _) = tokio_tungstenite::connect_async(proxy.endpoint())
            .await
            .expect("proxy handshake");
        client
            .send(Message::Text(
                r#"{"method":"thread/resume","id":7,"params":{"threadId":"old","path":"/workspace/.codex/sessions/old.jsonl","cwd":"/workspace","history":[],"initialTurnsPage":null,"personality":"friendly","futureResumeOnly":true}}"#
                    .into(),
            ))
            .await
            .expect("proxy request");
        let response = client
            .next()
            .await
            .expect("response")
            .expect("valid response");
        let Message::Text(response) = response else {
            panic!("expected text response");
        };
        let response: Value = serde_json::from_str(response.as_ref()).expect("response json");
        assert_eq!(response["result"]["thread"]["id"], "forked");

        for _ in 0..20 {
            if proxy.selected_thread_id().as_deref() == Some("forked") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert_eq!(proxy.selected_thread_id().as_deref(), Some("forked"));
        upstream_task.await.expect("upstream task");
    }

    #[tokio::test]
    async fn starts_fresh_when_active_writer_fork_cannot_read_persisted_history() {
        let upstream_listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("upstream listener");
        let upstream_address = upstream_listener.local_addr().expect("upstream address");
        let upstream_task = tokio::spawn(async move {
            let (stream, _) = upstream_listener.accept().await.expect("upstream accept");
            let mut socket = tokio_tungstenite::accept_async(stream)
                .await
                .expect("upstream handshake");

            let resume = socket.next().await.expect("resume").expect("valid resume");
            let Message::Text(resume) = resume else {
                panic!("expected text resume request");
            };
            assert_eq!(
                serde_json::from_str::<Value>(resume.as_ref()).expect("resume json")["method"],
                "thread/resume"
            );
            socket
                .send(Message::Text(
                    r#"{"id":7,"error":{"code":-32600,"message":"thread old already has an active writer"}}"#
                        .into(),
                ))
                .await
                .expect("active writer response");

            let fork = socket.next().await.expect("fork").expect("valid fork");
            let Message::Text(fork) = fork else {
                panic!("expected text fork request");
            };
            assert_eq!(
                serde_json::from_str::<Value>(fork.as_ref()).expect("fork json")["method"],
                "thread/fork"
            );
            socket
                .send(Message::Text(
                    r#"{"id":7,"error":{"code":-32603,"message":"failed to prepare paginated fork: thread history projection expected ordinal 2324, got 2323"}}"#
                        .into(),
                ))
                .await
                .expect("fork failure");

            let start = socket.next().await.expect("start").expect("valid start");
            let Message::Text(start) = start else {
                panic!("expected text start request");
            };
            let start: Value = serde_json::from_str(start.as_ref()).expect("start json");
            assert_eq!(start["id"], 7);
            assert_eq!(start["method"], "thread/start");
            assert_eq!(start["params"]["cwd"], "/workspace");
            assert_eq!(start["params"]["historyMode"], "paginated");
            assert!(start["params"].get("threadId").is_none());
            assert!(start["params"].get("excludeTurns").is_none());
            assert!(start["params"].get("path").is_none());
            socket
                .send(Message::Text(
                    r#"{"id":7,"result":{"thread":{"id":"fresh"}}}"#.into(),
                ))
                .await
                .expect("fresh start response");
            let turn = socket
                .next()
                .await
                .expect("turn start")
                .expect("valid turn start");
            let Message::Text(turn) = turn else {
                panic!("expected text turn request");
            };
            assert_eq!(
                serde_json::from_str::<Value>(turn.as_ref()).expect("turn json")["method"],
                "turn/start"
            );
            socket
                .send(Message::Text(
                    r#"{"id":10,"result":{"turn":{"id":"turn-1"}}}"#.into(),
                ))
                .await
                .expect("turn response");
            let history = socket
                .next()
                .await
                .expect("materialized history")
                .expect("valid history");
            let Message::Text(history) = history else {
                panic!("expected text materialized history request");
            };
            assert_eq!(
                serde_json::from_str::<Value>(history.as_ref()).expect("history json")["method"],
                "thread/turns/list"
            );
            socket
                .send(Message::Text(
                    r#"{"id":11,"result":{"data":[{"id":"turn-1"}],"nextCursor":null,"backwardsCursor":null}}"#.into(),
                ))
                .await
                .expect("materialized history response");
        });

        let proxy =
            CodexTuiProxy::spawn(format!("ws://{upstream_address}")).expect("proxy should start");
        let (mut client, _) = tokio_tungstenite::connect_async(proxy.endpoint())
            .await
            .expect("proxy handshake");
        client
            .send(Message::Text(
                r#"{"method":"thread/resume","id":7,"params":{"threadId":"old","cwd":"/workspace","excludeTurns":true}}"#
                    .into(),
            ))
            .await
            .expect("proxy request");
        let response = client
            .next()
            .await
            .expect("response")
            .expect("valid response");
        let Message::Text(response) = response else {
            panic!("expected text response");
        };
        let response: Value = serde_json::from_str(response.as_ref()).expect("response json");
        assert_eq!(response["result"]["thread"]["id"], "fresh");
        for (id, method) in [(8, "thread/turns/list"), (9, "thread/items/list")] {
            client
                .send(Message::Text(
                    serde_json::json!({
                        "id": id,
                        "method": method,
                        "params": { "threadId": "fresh" }
                    })
                    .to_string()
                    .into(),
                ))
                .await
                .expect("history hydration request");
            let history = client
                .next()
                .await
                .expect("history response")
                .expect("valid history response");
            let Message::Text(history) = history else {
                panic!("expected text history response");
            };
            let history: Value =
                serde_json::from_str(history.as_ref()).expect("history response json");
            assert_eq!(history["id"], id);
            assert_eq!(history["result"]["data"], serde_json::json!([]));
            assert!(history["result"]["nextCursor"].is_null());
            assert!(history["result"]["backwardsCursor"].is_null());
        }
        client
            .send(Message::Text(
                r#"{"id":10,"method":"turn/start","params":{"threadId":"fresh"}}"#.into(),
            ))
            .await
            .expect("turn start request");
        let _turn = client
            .next()
            .await
            .expect("turn response")
            .expect("valid turn response");
        client
            .send(Message::Text(
                r#"{"id":11,"method":"thread/turns/list","params":{"threadId":"fresh"}}"#.into(),
            ))
            .await
            .expect("materialized history request");
        let history = client
            .next()
            .await
            .expect("materialized history response")
            .expect("valid materialized history response");
        let Message::Text(history) = history else {
            panic!("expected text materialized history response");
        };
        let history: Value = serde_json::from_str(history.as_ref()).expect("history response json");
        assert_eq!(history["result"]["data"][0]["id"], "turn-1");
        assert_eq!(
            proxy.selected_thread(),
            Some(SelectedThread {
                id: "fresh".to_string(),
                confirmed: true,
                revision: 2,
            })
        );
        upstream_task.await.expect("upstream task");
    }

    #[test]
    fn observes_only_successful_thread_selection_responses() {
        let mut pending = HashMap::new();
        track_thread_selection_request(
            r#"{"method":"thread/resume","id":7,"params":{"threadId":"old"}}"#,
            &mut pending,
        );
        assert_eq!(
            take_selected_thread_response(
                r#"{"id":7,"result":{"thread":{"id":"resumed"}}}"#,
                &mut pending,
            ),
            Some(SelectedThread {
                id: "resumed".to_string(),
                confirmed: true,
                revision: 0,
            })
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn marks_thread_start_unconfirmed_until_the_provider_starts_a_turn() {
        let mut pending = HashMap::new();
        track_thread_selection_request(
            r#"{"method":"thread/start","id":8,"params":{}}"#,
            &mut pending,
        );
        assert_eq!(
            take_selected_thread_response(
                r#"{"id":8,"result":{"thread":{"id":"blank"}}}"#,
                &mut pending,
            ),
            Some(SelectedThread {
                id: "blank".to_string(),
                confirmed: false,
                revision: 0,
            })
        );
    }

    #[test]
    fn ignores_ephemeral_internal_threads_as_tui_selections() {
        let selected = Arc::new(Mutex::new(Some(SelectedThread {
            id: "workspace-thread".to_string(),
            confirmed: true,
            revision: 7,
        })));
        let mut selection_pending = HashMap::new();
        track_thread_selection_request(
            r#"{"method":"thread/start","id":"title","params":{"ephemeral":true}}"#,
            &mut selection_pending,
        );
        track_thread_selection_request(
            r#"{"method":"thread/fork","id":"internal-fork","params":{"ephemeral":true}}"#,
            &mut selection_pending,
        );

        assert!(selection_pending.is_empty());
        assert_eq!(
            take_selected_thread_response(
                r#"{"id":"title","result":{"thread":{"id":"title-thread"}}}"#,
                &mut selection_pending,
            ),
            None
        );

        // The title generator immediately starts a turn on its ephemeral thread. Even
        // after that succeeds, it must not confirm or replace the durable workspace
        // selection that GPT Live uses.
        let mut turn_pending = HashMap::new();
        track_turn_start_request(
            r#"{"method":"turn/start","id":"title-turn","params":{"threadId":"title-thread","input":[]}}"#,
            &mut turn_pending,
        );
        let thread_id = take_successful_turn_start_response(
            r#"{"id":"title-turn","result":{"turn":{"id":"generated-title"}}}"#,
            &mut turn_pending,
        )
        .expect("accepted internal title turn");
        mark_selected_thread_confirmed(&thread_id, &selected);

        assert_eq!(
            selected
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone(),
            Some(SelectedThread {
                id: "workspace-thread".to_string(),
                confirmed: true,
                revision: 7,
            })
        );
    }

    #[test]
    fn marks_started_thread_confirmed_when_its_first_turn_starts() {
        let selected = Arc::new(Mutex::new(Some(SelectedThread {
            id: "new-thread".to_string(),
            confirmed: false,
            revision: 1,
        })));
        let mut pending = HashMap::new();
        track_turn_start_request(
            r#"{"method":"turn/start","id":10,"params":{"threadId":"new-thread","input":[]}}"#,
            &mut pending,
        );
        let thread_id = take_successful_turn_start_response(
            r#"{"id":10,"result":{"turn":{"id":"turn-1"}}}"#,
            &mut pending,
        )
        .expect("accepted turn");
        mark_selected_thread_confirmed(&thread_id, &selected);
        assert_eq!(
            selected
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .map(|selected| (selected.confirmed, selected.revision)),
            Some((true, 2))
        );
    }

    #[test]
    fn rejected_turn_start_does_not_confirm_the_selected_thread() {
        let selected = Arc::new(Mutex::new(Some(SelectedThread {
            id: "new-thread".to_string(),
            confirmed: false,
            revision: 1,
        })));
        let mut pending = HashMap::new();
        track_turn_start_request(
            r#"{"method":"turn/start","id":10,"params":{"threadId":"new-thread","input":[]}}"#,
            &mut pending,
        );
        assert_eq!(
            take_successful_turn_start_response(
                r#"{"id":10,"error":{"code":-32600,"message":"rejected"}}"#,
                &mut pending,
            ),
            None
        );
        assert_eq!(
            selected
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .as_ref()
                .map(|selected| (selected.confirmed, selected.revision)),
            Some((false, 1))
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn ignores_unrelated_and_failed_responses() {
        let mut pending = HashMap::new();
        track_thread_selection_request(
            r#"{"method":"thread/read","id":1,"params":{}}"#,
            &mut pending,
        );
        assert!(pending.is_empty());

        track_thread_selection_request(
            r#"{"method":"thread/fork","id":2,"params":{"excludeTurns":true}}"#,
            &mut pending,
        );
        assert!(
            pending.is_empty(),
            "side conversations do not replace the main TUI thread"
        );

        track_thread_selection_request(
            r#"{"method":"thread/start","id":"start-1","params":{}}"#,
            &mut pending,
        );
        assert_eq!(
            take_selected_thread_response(
                r#"{"id":"start-1","error":{"message":"failed"}}"#,
                &mut pending,
            ),
            None
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn does_not_fallback_for_other_resume_failures() {
        let mut pending = HashMap::new();
        track_resume_fallback_request(
            r#"{"method":"thread/resume","id":7,"params":{"threadId":"old"}}"#,
            &mut pending,
        );
        assert_eq!(pending.len(), 1);
        assert_eq!(
            take_active_writer_fallback_request(
                r#"{"id":7,"error":{"code":-32600,"message":"invalid thread"}}"#,
                &mut pending,
            ),
            None
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn malformed_resume_response_does_not_trigger_fallback_or_consume_it() {
        let mut pending = HashMap::new();
        track_resume_fallback_request(
            r#"{"method":"thread/resume","id":7,"params":{"threadId":"old"}}"#,
            &mut pending,
        );
        assert_eq!(
            take_active_writer_fallback_request(
                r#"{"id":7,"result":{},"error":{"code":-32600,"message":"thread old already has an active writer"}}"#,
                &mut pending,
            ),
            None
        );
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn server_request_id_collision_does_not_consume_pending_selection() {
        let mut pending = HashMap::new();
        track_thread_selection_request(
            r#"{"method":"thread/resume","id":7,"params":{"threadId":"old"}}"#,
            &mut pending,
        );

        assert_eq!(
            take_selected_thread_response(
                r#"{"method":"item/commandExecution/requestApproval","id":7,"params":{}}"#,
                &mut pending,
            ),
            None
        );
        assert!(pending.contains_key("7"));
        assert_eq!(
            take_selected_thread_response(
                r#"{"id":7,"result":{"thread":{"id":"resumed"}}}"#,
                &mut pending,
            ),
            Some(SelectedThread {
                id: "resumed".to_string(),
                confirmed: true,
                revision: 0,
            })
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn malformed_response_does_not_consume_pending_selection() {
        let mut pending = HashMap::new();
        track_thread_selection_request(
            r#"{"method":"thread/start","id":9,"params":{}}"#,
            &mut pending,
        );

        assert_eq!(
            take_selected_thread_response(
                r#"{"id":9,"result":{"thread":{"id":"wrong"}},"error":{"message":"also wrong"}}"#,
                &mut pending,
            ),
            None
        );
        assert!(pending.contains_key("9"));
    }
}
