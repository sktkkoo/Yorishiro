use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::net::TcpListener;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use tokio::sync::oneshot;
use tokio_tungstenite::tungstenite::{
    handshake::server::{Callback, ErrorResponse, Request, Response},
    http::StatusCode,
    Message,
};

/// Codex TUI の app-server transport を透過中継し、thread 選択 response の ID だけを保持する。
/// transcript や turn payload は保存しない。
pub(super) struct CodexTuiProxy {
    endpoint: String,
    selected_thread: Arc<Mutex<Option<SelectedThread>>>,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
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
                                tokio::spawn(async move {
                                    if let Err(error) = proxy_connection(stream, upstream, selected).await {
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

    loop {
        tokio::select! {
            message = client_stream.next() => {
                let Some(message) = message else { break };
                let message = message.map_err(|error| format!("TUI receive failed: {error}"))?;
                if let Message::Text(text) = &message {
                    if let Some(response) = empty_unmaterialized_history_response(
                        text.as_ref(),
                        &fresh_fallback_threads,
                    ) {
                        client_sink.send(response).await
                            .map_err(|error| format!("TUI history fallback send failed: {error}"))?;
                        continue;
                    }
                    track_thread_selection_request(text.as_ref(), &mut thread_selection_requests);
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
                    if let Some(thread_id) = take_successful_turn_start_response(
                        text.as_ref(),
                        &mut turn_start_requests,
                    ) {
                        mark_selected_thread_confirmed(&thread_id, &selected_thread);
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
    let confirmed = match method {
        Some("thread/start") => Some(false),
        Some("thread/resume") => Some(true),
        Some("thread/fork") => (message
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
) {
    let mut selected = selected_thread
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(selected) = selected
        .as_mut()
        .filter(|selected| selected.id == thread_id)
    {
        selected.confirmed = true;
        selected.revision = selected.revision.saturating_add(1);
    }
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
