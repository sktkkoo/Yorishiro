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
    selected_thread_id: Arc<Mutex<Option<String>>>,
    shutdown: Option<oneshot::Sender<()>>,
    thread: Option<JoinHandle<()>>,
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
        let selected_thread_id = Arc::new(Mutex::new(None));
        let task_selected_thread_id = Arc::clone(&selected_thread_id);
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
                                let selected = Arc::clone(&task_selected_thread_id);
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
            selected_thread_id,
            shutdown: Some(shutdown),
            thread: Some(thread),
        })
    }

    pub(super) fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub(super) fn selected_thread_id(&self) -> Option<String> {
        self.selected_thread_id
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
    selected_thread_id: Arc<Mutex<Option<String>>>,
) -> Result<(), String> {
    let client = tokio_tungstenite::accept_hdr_async(client_stream, RejectBrowserOrigin)
        .await
        .map_err(|error| format!("TUI handshake failed: {error}"))?;
    let (upstream, _) = tokio_tungstenite::connect_async(&upstream_endpoint)
        .await
        .map_err(|error| format!("upstream connection failed: {error}"))?;
    let (mut client_sink, mut client_stream) = client.split();
    let (mut upstream_sink, mut upstream_stream) = upstream.split();
    let mut thread_selection_requests = HashSet::new();
    let mut resume_fallback_requests = HashMap::new();

    loop {
        tokio::select! {
            message = client_stream.next() => {
                let Some(message) = message else { break };
                let message = message.map_err(|error| format!("TUI receive failed: {error}"))?;
                if let Message::Text(text) = &message {
                    track_thread_selection_request(text.as_ref(), &mut thread_selection_requests);
                    track_resume_fallback_request(text.as_ref(), &mut resume_fallback_requests);
                }
                upstream_sink.send(message).await
                    .map_err(|error| format!("upstream send failed: {error}"))?;
            }
            message = upstream_stream.next() => {
                let Some(message) = message else { break };
                let message = message.map_err(|error| format!("upstream receive failed: {error}"))?;
                if let Message::Text(text) = &message {
                    if let Some(fallback) = take_active_writer_fallback_request(
                        text.as_ref(),
                        &mut resume_fallback_requests,
                    ) {
                        eprintln!(
                            "[codex-tui-proxy] resume target has an active writer; forking it instead"
                        );
                        upstream_sink
                            .send(Message::Text(fallback.to_string().into()))
                            .await
                            .map_err(|error| format!("upstream fallback send failed: {error}"))?;
                        continue;
                    }
                    if let Some(thread_id) = take_selected_thread_response(
                        text.as_ref(),
                        &mut thread_selection_requests,
                    ) {
                        *selected_thread_id
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(thread_id);
                    }
                }
                client_sink.send(message).await
                    .map_err(|error| format!("TUI send failed: {error}"))?;
            }
        }
    }
    Ok(())
}

fn request_id_key(value: &Value) -> Option<String> {
    serde_json::to_string(value).ok()
}

fn track_thread_selection_request(raw: &str, pending: &mut HashSet<String>) {
    let Ok(message) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    let method = message.get("method").and_then(Value::as_str);
    let selects_main_thread = match method {
        Some("thread/start" | "thread/resume") => true,
        Some("thread/fork") => {
            message
                .get("params")
                .and_then(|params| params.get("excludeTurns"))
                .and_then(Value::as_bool)
                != Some(true)
        }
        _ => false,
    };
    if !selects_main_thread {
        return;
    }
    if let Some(key) = message.get("id").and_then(request_id_key) {
        pending.insert(key);
    }
}

/// Keep a `thread/fork` equivalent of each resume request until its response arrives.
/// If Codex rejects the resume because another process still owns the thread writer
/// lock, the proxy can retry the same selection as a fork without restarting the TUI.
fn track_resume_fallback_request(raw: &str, pending: &mut HashMap<String, Value>) {
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
        "path",
        "permissions",
        "runtimeWorkspaceRoots",
        "sandbox",
        "serviceTier",
        "threadId",
    ];

    let Ok(mut message) = serde_json::from_str::<Value>(raw) else {
        return;
    };
    if message.get("method").and_then(Value::as_str) != Some("thread/resume") {
        return;
    }
    let Some(key) = message.get("id").and_then(request_id_key) else {
        return;
    };

    message["method"] = Value::String("thread/fork".to_string());
    if let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) {
        // Forward only fields accepted by both ThreadResumeParams and
        // ThreadForkParams. A future resume-only field must not make the fallback
        // fail with invalid params merely because the proxy did not know to drop it.
        params.retain(|key, _| FORK_COMPATIBLE_RESUME_FIELDS.contains(&key.as_str()));
    }
    pending.insert(key, message);
}

fn take_active_writer_fallback_request(
    raw: &str,
    pending: &mut HashMap<String, Value>,
) -> Option<Value> {
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
    is_active_writer.then_some(fallback)
}

fn take_selected_thread_response(raw: &str, pending: &mut HashSet<String>) -> Option<String> {
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
    if !pending.remove(&key) {
        return None;
    }
    message
        .get("result")?
        .get("thread")?
        .get("id")?
        .as_str()
        .filter(|thread_id| !thread_id.is_empty())
        .map(str::to_string)
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
                r#"{"method":"thread/resume","id":7,"params":{"threadId":"old","cwd":"/workspace","history":[],"initialTurnsPage":null,"personality":"friendly","futureResumeOnly":true}}"#
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

    #[test]
    fn observes_only_successful_thread_selection_responses() {
        let mut pending = HashSet::new();
        track_thread_selection_request(
            r#"{"method":"thread/resume","id":7,"params":{"threadId":"old"}}"#,
            &mut pending,
        );
        assert_eq!(
            take_selected_thread_response(
                r#"{"id":7,"result":{"thread":{"id":"resumed"}}}"#,
                &mut pending,
            ),
            Some("resumed".to_string())
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn ignores_unrelated_and_failed_responses() {
        let mut pending = HashSet::new();
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
        let mut pending = HashSet::new();
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
        assert!(pending.contains("7"));
        assert_eq!(
            take_selected_thread_response(
                r#"{"id":7,"result":{"thread":{"id":"resumed"}}}"#,
                &mut pending,
            ),
            Some("resumed".to_string())
        );
        assert!(pending.is_empty());
    }

    #[test]
    fn malformed_response_does_not_consume_pending_selection() {
        let mut pending = HashSet::new();
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
        assert!(pending.contains("9"));
    }
}
