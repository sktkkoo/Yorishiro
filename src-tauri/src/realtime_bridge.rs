use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tokio::sync::mpsc::{self, UnboundedSender};
use tokio_tungstenite::tungstenite::Message;

enum BridgeCommand {
    Send(String),
    Close(Option<String>),
}

/// WebView と Codex app-server の間を JSON-RPC text message 単位で中継する。
///
/// Codex app-server は `Origin` header 付き WebSocket handshake を意図的に拒否する。
/// browser / WKWebView は Origin を外せないため、host の Rust client が loopback socket
/// を所有し、WebView には endpoint 自体を公開しない。
#[derive(Clone, Default)]
pub struct RealtimeBridgeState {
    connections: Arc<Mutex<HashMap<String, UnboundedSender<BridgeCommand>>>>,
}

impl RealtimeBridgeState {
    pub async fn connect(
        &self,
        endpoint: String,
        on_message: Channel<String>,
    ) -> Result<String, String> {
        let (socket, _) = tokio_tungstenite::connect_async(&endpoint)
            .await
            .map_err(|error| format!("Codex app-server connection failed: {error}"))?;
        let (mut sink, mut stream) = socket.split();
        let (sender, mut receiver) = mpsc::unbounded_channel();
        let connection_id = uuid::Uuid::new_v4().to_string();

        self.connections
            .lock()
            .map_err(|_| "realtime bridge lock poisoned".to_string())?
            .insert(connection_id.clone(), sender);

        let state = self.clone();
        let task_connection_id = connection_id.clone();
        tokio::spawn(async move {
            let mut explicit_close = false;
            let close_reason = loop {
                tokio::select! {
                    command = receiver.recv() => {
                        match command {
                            Some(BridgeCommand::Send(text)) => {
                                if let Err(error) = sink.send(Message::Text(text.into())).await {
                                    break Some(format!("Codex app-server send failed: {error}"));
                                }
                            }
                            Some(BridgeCommand::Close(final_message)) => {
                                explicit_close = true;
                                if let Some(text) = final_message {
                                    let _ = sink.send(Message::Text(text.into())).await;
                                }
                                let _ = sink.close().await;
                                break None;
                            }
                            None => {
                                explicit_close = true;
                                let _ = sink.close().await;
                                break None;
                            }
                        }
                    }
                    incoming = stream.next() => {
                        match incoming {
                            Some(Ok(Message::Text(text))) => {
                                if on_message.send(text.to_string()).is_err() {
                                    explicit_close = true;
                                    let _ = sink.close().await;
                                    break None;
                                }
                            }
                            Some(Ok(Message::Ping(payload))) => {
                                if let Err(error) = sink.send(Message::Pong(payload)).await {
                                    break Some(format!("Codex app-server pong failed: {error}"));
                                }
                            }
                            Some(Ok(Message::Close(_))) | None => {
                                break Some("Codex app-server connection closed".to_string());
                            }
                            Some(Ok(_)) => {}
                            Some(Err(error)) => {
                                break Some(format!("Codex app-server connection failed: {error}"));
                            }
                        }
                    }
                }
            };

            if let Ok(mut connections) = state.connections.lock() {
                connections.remove(&task_connection_id);
            }
            if !explicit_close {
                if let Some(message) = close_reason {
                    let payload = serde_json::json!({
                        "method": "yorishiro/realtime-bridge/closed",
                        "params": { "message": message },
                    });
                    let _ = on_message.send(payload.to_string());
                }
            }
        });

        Ok(connection_id)
    }

    pub fn send(&self, connection_id: &str, message: String) -> Result<(), String> {
        let sender = self
            .connections
            .lock()
            .map_err(|_| "realtime bridge lock poisoned".to_string())?
            .get(connection_id)
            .cloned()
            .ok_or_else(|| "realtime bridge connection not found".to_string())?;
        sender
            .send(BridgeCommand::Send(message))
            .map_err(|_| "realtime bridge connection closed".to_string())
    }

    pub fn disconnect(
        &self,
        connection_id: &str,
        final_message: Option<String>,
    ) -> Result<(), String> {
        let sender = self
            .connections
            .lock()
            .map_err(|_| "realtime bridge lock poisoned".to_string())?
            .remove(connection_id);
        if let Some(sender) = sender {
            let _ = sender.send(BridgeCommand::Close(final_message));
        }
        Ok(())
    }
}
