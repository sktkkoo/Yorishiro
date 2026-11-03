//! Continue work through the selected Main Agent's existing Codex thread.
//!
//! This client never changes model, permissions, sandbox, working directory, or
//! approval routing. The terminal remains the owner of approval requests.
use super::types::{Context, TerminalStatus};
use crate::sessions::{PtySession, SessionKind, SessionRegistry};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio::net::TcpStream;
use tokio_tungstenite::{tungstenite::Message, MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const WORK_TIMEOUT: Duration = Duration::from_secs(60 * 60);

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Target {
    pub session_id: String,
    pub thread_id: String,
    pub cwd: String,
    pub launch_id: String,
}

pub(super) struct Report {
    pub value: Value,
    pub progressed: bool,
}

pub(super) struct TerminalTurn {
    pub id: String,
    pub status: TerminalStatus,
    pub evidence: Vec<Value>,
}

pub(super) enum Outcome {
    Completed(Report),
    Terminal(TerminalTurn),
}

pub(super) struct Request {
    pub id: String,
    pub prompt: String,
    pub schema: Value,
    pub allow_dispatch: bool,
}

pub(super) fn target(app: &AppHandle, context: &Context) -> Result<Option<Target>, String> {
    let Some(session_id) = &context.execution_session_id else {
        return Ok(None);
    };
    let registry = app.state::<Arc<SessionRegistry>>();
    let Some(descriptor) = registry.get(session_id) else {
        return Err("The Main Agent is not ready for autonomous work.".into());
    };
    if descriptor.profile_id != "codex" || descriptor.kind != SessionKind::Agent {
        return Ok(None);
    }
    let session = registry
        .get_pty_session(session_id)
        .filter(|session| session.is_alive())
        .ok_or("The Main Agent is not running.")?;
    let selection = session
        .realtime_selected_thread()
        .ok_or("The Main Agent conversation is not ready.")?;
    let cwd = context
        .cwd
        .as_deref()
        .ok_or("The autonomous work folder is unavailable.")?;
    let selected_cwd = descriptor
        .display_cwd
        .as_deref()
        .or(descriptor.cwd.as_deref());
    if !selected_cwd.is_some_and(|selected| same_directory(selected, cwd)) {
        return Err("The Main Agent and autonomous work folders do not match.".into());
    }
    Ok(Some(Target {
        session_id: session_id.clone(),
        thread_id: selection.session_id,
        cwd: cwd.to_owned(),
        launch_id: session.hook_launch_id().to_owned(),
    }))
}

fn current_session(app: &AppHandle, target: &Target) -> Result<Arc<PtySession>, String> {
    let registry = app.state::<Arc<SessionRegistry>>();
    let descriptor = registry
        .get(&target.session_id)
        .ok_or("The Main Agent is unavailable.")?;
    if descriptor.profile_id != "codex" || descriptor.kind != SessionKind::Agent {
        return Err("The Main Agent changed; the previous work was not sent again.".into());
    }
    let session = registry
        .get_pty_session(&target.session_id)
        .filter(|session| session.is_alive())
        .ok_or("The Main Agent is not running.")?;
    let selected = session
        .realtime_selected_thread()
        .ok_or("The Main Agent conversation is not ready.")?;
    if selected.session_id != target.thread_id
        || !descriptor
            .display_cwd
            .as_deref()
            .or(descriptor.cwd.as_deref())
            .is_some_and(|cwd| same_directory(cwd, &target.cwd))
    {
        return Err(
            "The Main Agent conversation changed; the previous work was not sent again.".into(),
        );
    }
    Ok(session)
}

fn same_directory(left: &str, right: &str) -> bool {
    match (std::fs::canonicalize(left), std::fs::canonicalize(right)) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

pub(super) async fn run(
    app: &AppHandle,
    target: Target,
    request: Request,
    cancel: CancellationToken,
    on_dispatch: impl Fn() -> Result<(), String>,
) -> Result<Outcome, String> {
    if cancel.is_cancelled() {
        return Err("Autonomous work was cancelled before starting.".into());
    }
    let session = current_session(app, &target)?;
    let endpoint = session
        .realtime_endpoint()
        .ok_or("The Main Agent connection is unavailable.")?;
    let mut client = Client::connect(&endpoint).await?;
    let result = run_connected(&mut client, &target, request, cancel, || {
        let session = current_session(app, &target)?;
        if session.hook_launch_id() != target.launch_id {
            return Err("The Main Agent restarted; unfinished work must be recovered before starting it again.".into());
        }
        on_dispatch()
    }).await;
    let _ = client.socket.close(None).await;
    result
}

async fn run_connected(
    client: &mut Client,
    target: &Target,
    request: Request,
    cancel: CancellationToken,
    before_start: impl Fn() -> Result<(), String>,
) -> Result<Outcome, String> {
    let marker = format!("[Yorishiro work request: {}]", request.id);
    let metadata = client
        .request(
            "thread/read",
            json!({"threadId":target.thread_id,"includeTurns":false}),
        )
        .await?;
    validate_thread(&metadata, target)?;
    // Check durable history before any dispatch. If the process died after the
    // start was accepted, retry observes that same turn instead of doing it twice.
    let existing = client.find_request(&target.thread_id, &marker).await?;
    let turn_id = if let Some(turn) = existing {
        if turn.get("status").and_then(Value::as_str) != Some("inProgress") {
            return report(&turn, &marker);
        }
        turn.get("id")
            .and_then(Value::as_str)
            .ok_or("The saved work turn has no ID.")?
            .to_owned()
    } else {
        if !request.allow_dispatch {
            return Err("The previous work request has no confirmed receipt yet. It will not be sent again; inspect the Main Agent before retrying recovery.".into());
        }
        let metadata = client
            .request(
                "thread/read",
                json!({"threadId":target.thread_id,"includeTurns":false}),
            )
            .await?;
        validate_thread(&metadata, target)?;
        if metadata
            .pointer("/thread/status/type")
            .and_then(Value::as_str)
            != Some("idle")
        {
            return Err(
                "The Main Agent is busy. Autonomous work will retry when it is free.".into(),
            );
        }
        if cancel.is_cancelled() {
            return Err("Autonomous work was cancelled before starting.".into());
        }
        before_start()?;
        let started = client
            .request(
                "turn/start",
                start_params(target, &request.id, &marker, request.prompt, request.schema),
            )
            .await?;
        started
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or("The Main Agent did not acknowledge a work turn.")?
            .to_owned()
    };
    // Accepted work belongs to Main Agent. Voice transcript updates and closing
    // the companion view must not cancel it or cause an automatic duplicate.
    tokio::time::timeout(WORK_TIMEOUT, async {
        loop {
            if let Some(turn) = client.find_request(&target.thread_id, &marker).await? {
                if turn.get("id").and_then(Value::as_str) != Some(turn_id.as_str()) {
                    return Err(
                        "The autonomous work receipt does not match its original turn.".into(),
                    );
                }
                if turn.get("status").and_then(Value::as_str) != Some("inProgress") {
                    return report(&turn, &marker);
                }
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .map_err(|_| {
        "Autonomous work is still running in Main Agent; retry to recover its result.".to_owned()
    })?
}

fn validate_thread(metadata: &Value, target: &Target) -> Result<(), String> {
    let thread = metadata
        .get("thread")
        .ok_or("The Main Agent returned no conversation.")?;
    if thread.get("id").and_then(Value::as_str) != Some(target.thread_id.as_str())
        || !thread
            .get("cwd")
            .and_then(Value::as_str)
            .is_some_and(|cwd| same_directory(cwd, &target.cwd))
        || thread.get("parentThreadId").is_some_and(|id| !id.is_null())
        || thread.get("canAcceptDirectInput").and_then(Value::as_bool) == Some(false)
    {
        return Err("The Main Agent conversation does not match this work request.".into());
    }
    Ok(())
}

fn start_params(
    target: &Target,
    request_id: &str,
    marker: &str,
    prompt: String,
    schema: Value,
) -> Value {
    // Keep all sticky Main Agent settings intact, including approval routing.
    json!({
        "threadId":target.thread_id,
        "clientUserMessageId":request_id,
        "input":[{"type":"text","text":format!("{marker}\n{prompt}"),"text_elements":[]}],
        "outputSchema":schema,
    })
}

fn report(turn: &Value, marker: &str) -> Result<Outcome, String> {
    match turn.get("status").and_then(Value::as_str) {
        Some("completed") => {},
        Some(status @ ("interrupted" | "failed")) => {
            let id = turn.get("id").and_then(Value::as_str).filter(|id| !id.is_empty())
                .ok_or("The terminal work receipt has no turn ID.")?;
            let items = turn.get("items").and_then(Value::as_array)
                .ok_or("The terminal work receipt has no observed items.")?;
            if !items.iter().any(|item| user_item_has_marker(item, marker)) {
                return Err("The terminal work receipt does not identify this request.".into());
            }
            // Retain compact references to observed tool items, not arbitrary
            // command output or a model's account of whether work succeeded.
            let evidence = items.iter().filter(|item| {
                matches!(item.get("type").and_then(Value::as_str),
                    Some("commandExecution" | "fileChange" | "mcpToolCall"))
            }).take(16).map(|item| json!({
                "id": item.get("id").and_then(Value::as_str).map(|value| value.chars().take(256).collect::<String>()),
                "type": item.get("type").and_then(Value::as_str),
                "status": item.get("status").and_then(Value::as_str).map(|value| value.chars().take(64).collect::<String>()),
                "exitCode": item.get("exitCode").and_then(Value::as_i64),
            })).collect();
            return Ok(Outcome::Terminal(TerminalTurn {
                id: id.into(),
                status: if status == "interrupted" { TerminalStatus::Interrupted } else { TerminalStatus::Failed },
                evidence,
            }));
        }
        _ => return Err("The Main Agent work status is unconfirmed. Recover its original receipt before starting more work.".into()),
    }
    let items = turn
        .get("items")
        .and_then(Value::as_array)
        .ok_or("The work result has no completed items.")?;
    // turn/start may steer a concurrently started user turn. The user owns
    // that turn: its tools must not justify another autonomous followup.
    let user_items = items
        .iter()
        .filter(|item| item.get("type").and_then(Value::as_str) == Some("userMessage"))
        .collect::<Vec<_>>();
    if user_items.len() != 1 || !user_item_has_marker(user_items[0], marker) {
        return Ok(Outcome::Completed(Report {
            value: json!({"reply":"","understandings":[],"drafts":[],"reflection":"","nextStep":null}),
            progressed: false,
        }));
    }
    let value = items.iter().rev().find(|item| item.get("type").and_then(Value::as_str) == Some("agentMessage")
            && item.get("phase").and_then(Value::as_str) != Some("commentary"))
        .and_then(|item| item.get("text").and_then(Value::as_str))
        .and_then(|text| serde_json::from_str::<Value>(text).ok().filter(Value::is_object))
        .ok_or("The Main Agent completed work without a structured result. Its work will not be repeated.")?;
    Ok(Outcome::Completed(Report {
        value,
        progressed: items.iter().any(item_progressed),
    }))
}

fn item_progressed(item: &Value) -> bool {
    match item.get("type").and_then(Value::as_str) {
        Some("commandExecution") => {
            item.get("status").and_then(Value::as_str) == Some("completed")
                && item.get("exitCode").and_then(Value::as_i64) == Some(0)
        }
        Some("fileChange") => {
            item.get("status").and_then(Value::as_str) == Some("completed")
                && item
                    .get("changes")
                    .and_then(Value::as_array)
                    .is_some_and(|changes| !changes.is_empty())
        }
        Some("mcpToolCall") => {
            item.get("status").and_then(Value::as_str) == Some("completed")
                && item.get("error").is_none_or(Value::is_null)
                && item.pointer("/result/isError").and_then(Value::as_bool) != Some(true)
                && item
                    .get("tool")
                    .and_then(Value::as_str)
                    .is_some_and(|tool| {
                        let tool = tool.rsplit("__").next().unwrap_or(tool);
                        !matches!(
                            tool,
                            "continuity_observe"
                                | "continuity_context"
                                | "voice_say"
                                | "journal_write"
                                | "journal_read"
                        )
                    })
        }
        Some("dynamicToolCall") => item.get("success").and_then(Value::as_bool) == Some(true),
        Some("webSearch" | "imageView") => true,
        _ => false,
    }
}

struct Client {
    socket: WebSocketStream<MaybeTlsStream<TcpStream>>,
    next_id: u64,
}

impl Client {
    async fn connect(endpoint: &str) -> Result<Self, String> {
        let (socket, _) = tokio::time::timeout(
            RPC_TIMEOUT,
            tokio_tungstenite::connect_async_with_config(
                endpoint,
                Some(crate::realtime_bridge::codex_websocket_config()),
                false,
            ),
        )
        .await
        .map_err(|_| "Main Agent connection timed out.")?
        .map_err(|_| "Could not connect to Main Agent.")?;
        let mut client = Self { socket, next_id: 1 };
        client.request("initialize", json!({"clientInfo":{"name":"yorishiro_continuity","title":"Yorishiro","version":env!("CARGO_PKG_VERSION")},"capabilities":{"experimentalApi":true}})).await?;
        client
            .socket
            .send(Message::Text(
                json!({"method":"initialized","params":{}})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|_| "Could not initialize the Main Agent connection.")?;
        Ok(client)
    }

    async fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        tokio::time::timeout(RPC_TIMEOUT, async {
            self.socket
                .send(Message::Text(
                    json!({"id":id,"method":method,"params":params})
                        .to_string()
                        .into(),
                ))
                .await
                .map_err(|_| "Could not send a Main Agent request.")?;
            loop {
                match self.socket.next().await {
                    Some(Ok(Message::Text(text))) => {
                        let event: Value = serde_json::from_str(&text)
                            .map_err(|_| "Invalid Main Agent response.")?;
                        if event.get("id").and_then(Value::as_u64) == Some(id)
                            && event.get("method").is_none()
                        {
                            if let Some(error) = event.get("error") {
                                if method == "thread/turns/list"
                                    && error.get("code").and_then(Value::as_i64) == Some(-32600)
                                    && params.get("threadId").and_then(Value::as_str).is_some_and(|id|
                                        error.get("message").and_then(Value::as_str) == Some(format!("thread {id} is not materialized yet; thread/turns/list is unavailable before first user message").as_str()))
                                {
                                    return Ok(json!({"data":[],"nextCursor":null}));
                                }
                                return Err(format!(
                                    "Main Agent rejected {method}; check its terminal for details."
                                ));
                            }
                            return event
                                .get("result")
                                .cloned()
                                .ok_or("Main Agent returned no result.".into());
                        }
                        // Requests (including approvals) remain with the terminal.
                        // This observer never grants or rejects them on its behalf.
                    }
                    Some(Ok(Message::Ping(data))) => self
                        .socket
                        .send(Message::Pong(data))
                        .await
                        .map_err(|_| "Main Agent connection closed.")?,
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                        return Err(
                            "Main Agent connection closed; retry to recover the original work."
                                .into(),
                        )
                    }
                    _ => {}
                }
            }
        })
        .await
        .map_err(|_| {
            "Main Agent request timed out; retry to recover the original work.".to_owned()
        })?
    }

    async fn find_request(
        &mut self,
        thread_id: &str,
        marker: &str,
    ) -> Result<Option<Value>, String> {
        let mut cursor: Option<String> = None;
        // Never infer absence from an incomplete history page, as that could
        // repeat an already accepted filesystem or external operation.
        loop {
            let page = self
                .request(
                    "thread/turns/list",
                    json!({"threadId":thread_id,"itemsView":"full","limit":50,"cursor":cursor}),
                )
                .await?;
            let turns = page
                .get("data")
                .and_then(Value::as_array)
                .ok_or("Main Agent history is unavailable.")?;
            if let Some(turn) = turns.iter().find(|turn| turn_has_marker(turn, marker)) {
                return Ok(Some(turn.clone()));
            }
            let next = page
                .get("nextCursor")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if next.is_none() {
                return Ok(None);
            }
            if next == cursor {
                return Err("Main Agent history did not advance.".into());
            }
            cursor = next;
        }
    }
}

fn turn_has_marker(turn: &Value, marker: &str) -> bool {
    turn.get("items")
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| user_item_has_marker(item, marker)))
}

fn user_item_has_marker(item: &Value, marker: &str) -> bool {
    item.get("type").and_then(Value::as_str) == Some("userMessage")
        && item
            .get("content")
            .and_then(Value::as_array)
            .is_some_and(|content| {
                content.iter().any(|part| {
                    part.get("type").and_then(Value::as_str) == Some("text")
                        && part
                            .get("text")
                            .and_then(Value::as_str)
                            .is_some_and(|text| {
                                text.strip_prefix(marker)
                                    .is_some_and(|rest| rest.starts_with('\n'))
                            })
                })
            })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    const MARKER: &str = "[Yorishiro work request: test-request]";

    fn completed_turn() -> Value {
        json!({"id":"turn-1","status":"completed","items":[
            {"type":"userMessage","content":[{"type":"text","text":format!("{MARKER}\nDo the entrusted work")}]},
            {"type":"commandExecution","status":"completed","exitCode":0},
            {"type":"agentMessage","phase":"final_answer","text":"{\"reply\":\"Verified result\",\"understandings\":[],\"drafts\":[],\"reflection\":\"\",\"nextStep\":\"Check the next case\"}"}
        ]})
    }

    fn request(allow_dispatch: bool) -> Request {
        Request {
            id: "test-request".into(),
            prompt: "Do the entrusted work".into(),
            schema: json!({"type":"object"}),
            allow_dispatch,
        }
    }

    #[test]
    fn preserves_main_permissions_and_rejects_wrong_project_or_subagent() {
        let directory = tempfile::tempdir().unwrap();
        let target = Target {
            session_id: "main".into(),
            thread_id: "thread".into(),
            cwd: directory.path().to_str().unwrap().into(),
            launch_id: "launch".into(),
        };
        let params = start_params(&target, "request", MARKER, "Work".into(), json!({}));
        assert_eq!(params.as_object().unwrap().len(), 4);
        assert!(params.get("approvalPolicy").is_none());
        assert!(params.get("sandboxPolicy").is_none());
        assert!(params.get("model").is_none());
        let valid = json!({"thread":{"id":"thread","cwd":target.cwd,"canAcceptDirectInput":true,"parentThreadId":null}});
        validate_thread(&valid, &target).unwrap();
        for (key, value) in [
            ("id", json!("different")),
            ("cwd", json!("/missing/project")),
            ("parentThreadId", json!("parent")),
            ("canAcceptDirectInput", json!(false)),
        ] {
            let mut invalid = valid.clone();
            invalid["thread"][key] = value;
            assert!(validate_thread(&invalid, &target).is_err());
        }
    }

    #[test]
    fn only_completed_owned_work_can_supply_progress_and_followups() {
        let mut turn = completed_turn();
        let Outcome::Completed(result) = report(&turn, MARKER).unwrap() else {
            panic!("expected completed work");
        };
        assert!(result.progressed);
        assert_eq!(result.value["reply"], "Verified result");
        turn["items"][1]["exitCode"] = json!(1);
        let Outcome::Completed(result) = report(&turn, MARKER).unwrap() else {
            panic!("expected completed work");
        };
        assert!(!result.progressed);
        turn["status"] = json!("interrupted");
        assert!(matches!(
            report(&turn, MARKER).unwrap(),
            Outcome::Terminal(TerminalTurn {
                status: TerminalStatus::Interrupted,
                ..
            })
        ));
        turn["status"] = json!("failed");
        assert!(matches!(
            report(&turn, MARKER).unwrap(),
            Outcome::Terminal(TerminalTurn {
                status: TerminalStatus::Failed,
                ..
            })
        ));
        turn["status"] = json!("unknown");
        assert!(report(&turn, MARKER).is_err());
        let mut mixed = completed_turn();
        mixed["items"].as_array_mut().unwrap().insert(
            0,
            json!({"type":"userMessage","content":[{"type":"text","text":"A newer manual task"}]}),
        );
        let Outcome::Completed(result) = report(&mixed, MARKER).unwrap() else {
            panic!("expected completed work");
        };
        assert!(!result.progressed);
        assert_eq!(result.value["reply"], "");
        assert!(result.value["nextStep"].is_null());
        assert!(!item_progressed(
            &json!({"type":"mcpToolCall","tool":"continuity_observe","status":"completed"})
        ));
        assert!(!item_progressed(
            &json!({"type":"mcpToolCall","tool":"write","status":"completed","result":{"isError":true}})
        ));
        for tool in [
            "voice_say",
            "continuity_context",
            "journal_write",
            "mcp__yorishiro__voice_say",
        ] {
            assert!(!item_progressed(
                &json!({"type":"mcpToolCall","tool":tool,"status":"completed"})
            ));
        }
        let mut unfinished_report = completed_turn();
        unfinished_report["items"].as_array_mut().unwrap().push(
            json!({"type":"agentMessage","phase":"final_answer","text":"No structured report"}),
        );
        assert!(
            report(&unfinished_report, MARKER).is_err(),
            "an earlier JSON message cannot replace the final report"
        );
    }

    async fn fixture(
        busy: bool,
        completed: bool,
        turn_status: &'static str,
    ) -> (
        String,
        Target,
        Arc<AtomicUsize>,
        tokio::task::JoinHandle<()>,
        tempfile::TempDir,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let target = Target {
            session_id: "main".into(),
            thread_id: "thread".into(),
            cwd: directory.path().to_str().unwrap().into(),
            launch_id: "launch".into(),
        };
        let cwd = target.cwd.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("ws://{}", listener.local_addr().unwrap());
        let starts = Arc::new(AtomicUsize::new(0));
        let sent = starts.clone();
        let done = Arc::new(AtomicBool::new(completed));
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
                while let Some(Ok(Message::Text(text))) = socket.next().await {
                    let request: Value = serde_json::from_str(&text).unwrap();
                    let Some(id) = request.get("id") else {
                        continue;
                    };
                    let method = request["method"]
                        .as_str()
                        .expect("client never answers terminal approval requests");
                    let response = match method {
                        "initialize" => json!({"id":id,"result":{}}),
                        "thread/read" => {
                            json!({"id":id,"result":{"thread":{"id":"thread","cwd":cwd,"status":{"type":if busy {"active"} else {"idle"}},"canAcceptDirectInput":true,"parentThreadId":null}}})
                        }
                        "thread/turns/list" => {
                            if done.load(Ordering::SeqCst) {
                                let mut turn = completed_turn();
                                turn["status"] = json!(turn_status);
                                json!({"id":id,"result":{"data":[turn],"nextCursor":null}})
                            } else {
                                json!({"id":id,"error":{"code":-32600,"message":"thread thread is not materialized yet; thread/turns/list is unavailable before first user message"}})
                            }
                        }
                        "turn/start" => {
                            sent.fetch_add(1, Ordering::SeqCst);
                            done.store(true, Ordering::SeqCst);
                            socket.send(Message::Text(json!({"id":999,"method":"item/commandExecution/requestApproval","params":{"threadId":"thread"}}).to_string().into())).await.unwrap();
                            json!({"id":id,"result":{"turn":{"id":"turn-1","status":"inProgress"}}})
                        }
                        _ => panic!("unexpected request {method}"),
                    };
                    if socket
                        .send(Message::Text(response.to_string().into()))
                        .await
                        .is_err()
                    {
                        break;
                    }
                }
            }
        });
        (endpoint, target, starts, task, directory)
    }

    #[tokio::test]
    async fn starts_a_fresh_thread_and_recovers_the_same_completed_request_without_resending() {
        let (endpoint, target, starts, server, _dir) = fixture(false, false, "completed").await;
        let claimed = AtomicBool::new(false);
        let mut client = Client::connect(&endpoint).await.unwrap();
        let result = run_connected(
            &mut client,
            &target,
            request(true),
            CancellationToken::new(),
            || {
                claimed.store(true, Ordering::SeqCst);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(claimed.load(Ordering::SeqCst));
        assert!(matches!(
            result,
            Outcome::Completed(Report {
                progressed: true,
                ..
            })
        ));
        client.socket.close(None).await.unwrap();
        let mut client = Client::connect(&endpoint).await.unwrap();
        let result = run_connected(
            &mut client,
            &target,
            request(false),
            CancellationToken::new(),
            || panic!("must recover without dispatch"),
        )
        .await
        .unwrap();
        assert!(matches!(
            result,
            Outcome::Completed(Report {
                progressed: true,
                ..
            })
        ));
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        server.abort();
    }

    #[tokio::test]
    async fn busy_and_unacknowledged_requests_never_dispatch_another_turn() {
        for (busy, allow_dispatch) in [(true, true), (false, false)] {
            let (endpoint, target, starts, server, _dir) = fixture(busy, false, "completed").await;
            let mut client = Client::connect(&endpoint).await.unwrap();
            let error = run_connected(
                &mut client,
                &target,
                request(allow_dispatch),
                CancellationToken::new(),
                || panic!("must not dispatch"),
            )
            .await
            .err()
            .unwrap();
            assert!(
                error.contains(if busy { "busy" } else { "no confirmed receipt" }),
                "{error}"
            );
            assert_eq!(starts.load(Ordering::SeqCst), 0);
            server.abort();
        }
    }

    #[tokio::test]
    async fn terminal_receipts_are_recovered_without_dispatching_or_claiming_progress() {
        for status in ["interrupted", "failed"] {
            let (endpoint, target, starts, server, _dir) = fixture(false, true, status).await;
            let mut client = Client::connect(&endpoint).await.unwrap();
            let outcome = run_connected(
                &mut client,
                &target,
                request(false),
                CancellationToken::new(),
                || panic!("a terminal request must never be dispatched again"),
            )
            .await
            .unwrap();
            let Outcome::Terminal(receipt) = outcome else {
                panic!("expected confirmed terminal receipt");
            };
            assert_eq!(receipt.id, "turn-1");
            assert_eq!(
                receipt.status,
                if status == "failed" {
                    TerminalStatus::Failed
                } else {
                    TerminalStatus::Interrupted
                }
            );
            assert!(!receipt.evidence.is_empty());
            assert_eq!(starts.load(Ordering::SeqCst), 0);
            server.abort();
        }
    }

    #[test]
    fn terminal_status_without_a_matching_request_is_not_retired() {
        let mut turn = completed_turn();
        turn["status"] = json!("interrupted");
        assert!(report(&turn, "[Yorishiro work request: another-request]").is_err());
        turn.as_object_mut().unwrap().remove("id");
        assert!(report(&turn, MARKER).is_err());
    }
}
