//! Yorishiro MCP server の起動と lifecycle、および Rust → TS event channel の
//! round-trip 管理。
//!
//! port は `~/.yorishiro/config.json` の mcpPort が explicit なら固定。未指定なら
//! default 18743 を試し、使用中なら OS 選択の空き port に退避する。embedded agent
//! には、この process だけが持つ instance path を含む endpoint を渡す。
//!
//! rmcp 1.7.0 の `transport-streamable-http-server` feature を `axum` の
//! Router に nest してもらい、`tokio::spawn` で background に流す。
//! keep_alive は無制限（ローカル 1:1 接続のため session timeout 不要）。
//!
//! tool call が来ると `list_load_errors` 以外は `emit_tool_event` 経由で
//! Tauri event `mcp:tool-request` を emit し、TS 側 listener が handler を
//! 走らせて `mcp_tool_response` command で response を戻す。request_id →
//! oneshot Sender の map を静的に持って対応付ける。5s timeout で諦める。
//!
//! Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.5 / 4.6

use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::TcpListener;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpService,
};
use serde_json::Value;
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;

use crate::mcp::tools::Yorishiro;

const DEFAULT_PORT: u16 = 18743;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct McpServerRuntime {
    pub port: u16,
    pub endpoint: String,
    pub instance_id: String,
}

#[derive(Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerStatusSnapshot {
    pub port: Option<u16>,
    pub endpoint: Option<String>,
    pub instance_id: Option<String>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct McpServerStatus(Mutex<McpServerStatusSnapshot>);

impl McpServerStatus {
    pub fn snapshot(&self) -> Result<McpServerStatusSnapshot, String> {
        self.0
            .lock()
            .map(|status| status.clone())
            .map_err(|_| "mcp status lock poisoned".to_string())
    }

    pub fn set_started(&self, runtime: &McpServerRuntime) -> Result<(), String> {
        let mut status = self
            .0
            .lock()
            .map_err(|_| "mcp status lock poisoned".to_string())?;
        *status = McpServerStatusSnapshot {
            port: Some(runtime.port),
            endpoint: Some(runtime.endpoint.clone()),
            instance_id: Some(runtime.instance_id.clone()),
            error: None,
        };
        Ok(())
    }

    pub fn set_error(&self, error: String) -> Result<(), String> {
        let mut status = self
            .0
            .lock()
            .map_err(|_| "mcp status lock poisoned".to_string())?;
        *status = McpServerStatusSnapshot {
            port: None,
            endpoint: None,
            instance_id: None,
            error: Some(error),
        };
        Ok(())
    }

    pub fn endpoint(&self) -> Result<String, String> {
        let status = self
            .0
            .lock()
            .map_err(|_| "mcp status lock poisoned".to_string())?;
        status.endpoint.clone().ok_or_else(|| {
            status.error.clone().map_or_else(
                || "MCP server is not ready for this Yorishiro instance".to_string(),
                |error| format!("MCP server is unavailable for this Yorishiro instance: {error}"),
            )
        })
    }
}

/// Rust → TS event channel の timeout。5s 以内に response が来なければ諦める。
const TOOL_EVENT_TIMEOUT: Duration = Duration::from_secs(5);

/// 未解決の tool request を保持する map。`request_id` → `oneshot::Sender`。
/// Tauri event を emit した側が `recv()`、`mcp_tool_response` command が `send()`。
static PENDING: LazyLock<Mutex<HashMap<String, oneshot::Sender<Value>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VoicePlaybackProvenance {
    pub owner_id: String,
    pub generation: u64,
    pub fallback_playback_enabled: bool,
}

#[derive(Debug)]
struct VoicePlaybackLeaseState {
    provenance: VoicePlaybackProvenance,
    next_registration: u64,
    active_registration: u64,
    candidates: HashMap<String, u64>,
}

impl Default for VoicePlaybackLeaseState {
    fn default() -> Self {
        Self {
            provenance: VoicePlaybackProvenance {
                owner_id: String::new(),
                generation: 0,
                fallback_playback_enabled: true,
            },
            next_registration: 0,
            active_registration: 0,
            candidates: HashMap::new(),
        }
    }
}

static VOICE_PLAYBACK_LEASE: LazyLock<Mutex<VoicePlaybackLeaseState>> =
    LazyLock::new(|| Mutex::new(VoicePlaybackLeaseState::default()));

/// config.json の mcpPort を読む（不在 / 不正 → None）。
fn read_configured_port() -> Option<u16> {
    let path = crate::yorishiro_home_path().ok()?.join("config.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    parsed
        .get("mcpPort")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
        .filter(|port| *port != 0)
}

fn bind_listener_for_port(
    configured_port: Option<u16>,
    preferred_default_port: u16,
) -> Result<TcpListener, String> {
    let listener = if let Some(port) = configured_port {
        TcpListener::bind(("127.0.0.1", port))
            .map_err(|error| format!("configured MCP port {port} bind failed: {error}"))?
    } else {
        match TcpListener::bind(("127.0.0.1", preferred_default_port)) {
            Ok(listener) => listener,
            Err(error) if error.kind() == ErrorKind::AddrInUse => {
                TcpListener::bind(("127.0.0.1", 0))
                    .map_err(|error| format!("automatic MCP port bind failed: {error}"))?
            }
            Err(error) => {
                return Err(format!(
                    "default MCP port {preferred_default_port} bind failed: {error}"
                ));
            }
        }
    };
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("MCP listener nonblocking setup failed: {error}"))?;
    Ok(listener)
}

fn instance_endpoint(port: u16, instance_id: &str) -> String {
    format!("http://127.0.0.1:{port}/instances/{instance_id}/mcp")
}

/// Poisoned Mutex を recover しつつ guard を返す。pty.rs と同じ方針。
fn lock_pending() -> std::sync::MutexGuard<'static, HashMap<String, oneshot::Sender<Value>>> {
    PENDING
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn lock_voice_playback_lease() -> std::sync::MutexGuard<'static, VoicePlaybackLeaseState> {
    VOICE_PLAYBACK_LEASE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn apply_voice_playback_update(
    state: &mut VoicePlaybackLeaseState,
    next: VoicePlaybackProvenance,
) -> Result<(), String> {
    let belongs_to_current_owner = next.owner_id == state.provenance.owner_id;
    let is_newer_or_retry = next.generation > state.provenance.generation
        || (next.generation == state.provenance.generation
            && next.fallback_playback_enabled == state.provenance.fallback_playback_enabled);
    if belongs_to_current_owner {
        if is_newer_or_retry {
            state.provenance = next;
            return Ok(());
        }
        return Err("voice playback generation is stale".to_string());
    }

    let Some(registration) = state.candidates.remove(&next.owner_id) else {
        return Err("voice playback owner is stale or unregistered".to_string());
    };
    if registration <= state.active_registration {
        return Err("voice playback owner registration is stale".to_string());
    }

    state.active_registration = registration;
    state
        .candidates
        .retain(|_, candidate| *candidate > registration);
    state.provenance = next;
    Ok(())
}

pub fn set_voice_playback_provenance(next: VoicePlaybackProvenance) -> Result<(), String> {
    apply_voice_playback_update(&mut lock_voice_playback_lease(), next)
}

pub fn register_voice_playback_owner() -> String {
    let owner_id = uuid::Uuid::new_v4().to_string();
    register_voice_playback_owner_with_id(&mut lock_voice_playback_lease(), owner_id.clone());
    owner_id
}

fn register_voice_playback_owner_with_id(state: &mut VoicePlaybackLeaseState, owner_id: String) {
    state.next_registration = state.next_registration.saturating_add(1);
    state.candidates.insert(owner_id, state.next_registration);
}

fn voice_playback_provenance() -> VoicePlaybackProvenance {
    lock_voice_playback_lease().provenance.clone()
}

/// Tauri event で TS 層に tool request を飛ばし、`mcp_tool_response` が返す
/// `serde_json::Value` を await する。timeout や TS 側 error は `Err(String)`。
pub async fn emit_tool_event(app: &AppHandle, tool: &str, request: Value) -> Result<Value, String> {
    emit_tool_event_with_timeout(app, tool, request, TOOL_EVENT_TIMEOUT).await
}

/// timeout を個別指定できる版。persona_goodbye_switch のように TS 側が
/// 意図的に長く待つ（お別れの声の再生完了待ち）tool で使う。
pub async fn emit_tool_event_with_timeout(
    app: &AppHandle,
    tool: &str,
    request: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();

    {
        let mut guard = lock_pending();
        guard.insert(request_id.clone(), tx);
    }

    // Stamp request creation, not WebView dispatch, so delayed Live-era voice tools stay suppressed.
    let voice_playback = voice_playback_provenance();
    let payload = serde_json::json!({
        "requestId": request_id,
        "tool": tool,
        "request": request,
        "voicePlayback": {
            "ownerId": voice_playback.owner_id,
            "generation": voice_playback.generation,
            "fallbackPlaybackEnabled": voice_playback.fallback_playback_enabled,
        },
    });

    if let Err(err) = app.emit("mcp:tool-request", payload) {
        // emit 失敗は pending を掃除してから error に変換。
        lock_pending().remove(&request_id);
        return Err(format!("emit mcp:tool-request failed: {}", err));
    }

    match tokio::time::timeout(timeout, rx).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(_canceled)) => {
            // Sender が drop された（通常は起きない想定）。
            Err("tool response channel canceled".to_string())
        }
        Err(_elapsed) => {
            // timeout — pending map からは当該 entry を剥がす。
            lock_pending().remove(&request_id);
            Err(format!(
                "tool '{}' did not respond within {:?}",
                tool, timeout
            ))
        }
    }
}

/// `mcp_tool_response` Tauri command から呼ばれる。pending map から sender を
/// 取り出して `send()`。unknown request_id は黙って無視する（timeout 経由で
/// 既に掃除済みのケースがある）。
pub fn resolve_pending_response(request_id: &str, response: Value) -> Result<(), String> {
    let sender = {
        let mut guard = lock_pending();
        guard.remove(request_id)
    };
    if let Some(sender) = sender {
        // Receiver が既に drop していたら結果は捨てる。
        let _ = sender.send(response);
    }
    Ok(())
}

/// MCP server を spawn する。listener はこの関数内で同期的に確保し、そのまま
/// async runtime へ move するため、probe → drop → re-bind の race を作らない。
pub fn spawn_server(app_handle: AppHandle) -> Result<McpServerRuntime, String> {
    let listener = bind_listener_for_port(read_configured_port(), DEFAULT_PORT)?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("MCP listener address lookup failed: {error}"))?
        .port();
    let instance_id = uuid::Uuid::new_v4().to_string();
    let endpoint = instance_endpoint(port, &instance_id);
    let instance_path = format!("/instances/{instance_id}/mcp");

    // rmcp StreamableHttpService を axum Router に mount して tokio::spawn で
    // background に流す。factory closure は session ごとに Yorishiro 新規 instance
    // を返す必要がある（LocalSessionManager の session lifecycle 都合）。
    let service = StreamableHttpService::new(
        {
            let app = app_handle.clone();
            move || Ok(Yorishiro::new(app.clone()))
        },
        {
            let mut mgr = LocalSessionManager::default();
            mgr.session_config.keep_alive = None;
            mgr
        }
        .into(),
        Default::default(),
    );
    // /mcp は既存の手動 client 互換。embedded agent は instance path だけを使うため、
    // 別 process の endpoint を誤って渡されても route が一致せず接続できない。
    let router = axum::Router::new()
        .nest_service("/mcp", service.clone())
        .nest_service(&instance_path, service);

    // Tauri 2 の setup closure は tokio runtime context 内で動かないため、
    // `tokio::spawn` を直接呼ぶと "no reactor running" panic になる。
    // tauri の async_runtime::spawn は Tauri 本体の tokio runtime 上に task を
    // 流すため、setup の外側からでも安全に呼べる。
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(listener) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[yorishiro-mcp] listener handoff failed: {}", e);
                return;
            }
        };
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[yorishiro-mcp] axum::serve exited: {}", e);
        }
    });

    Ok(McpServerRuntime {
        port,
        endpoint,
        instance_id,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn configured_port_is_none_when_no_config_exists() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // HOME を存在しない path に向ければ config 不在扱いになる。
        let orig = std::env::var("HOME").ok();
        std::env::set_var(
            "HOME",
            std::env::temp_dir().join(format!(
                "yorishiro-mcp-server-missing-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0)
            )),
        );
        assert_eq!(read_configured_port(), None);
        match orig {
            Some(home) => std::env::set_var("HOME", home),
            None => std::env::remove_var("HOME"),
        }
    }

    #[test]
    fn unconfigured_listener_falls_back_when_preferred_port_is_occupied() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).expect("bind occupied port");
        let occupied_port = occupied.local_addr().expect("occupied address").port();

        let listener =
            bind_listener_for_port(None, occupied_port).expect("bind automatic fallback port");
        let selected_port = listener.local_addr().expect("selected address").port();

        assert_ne!(selected_port, occupied_port);
    }

    #[test]
    fn configured_listener_fails_closed_when_port_is_occupied() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).expect("bind occupied port");
        let occupied_port = occupied.local_addr().expect("occupied address").port();

        let error = bind_listener_for_port(Some(occupied_port), DEFAULT_PORT)
            .expect_err("configured collision must fail");

        assert!(error.contains("configured MCP port"));
        assert!(error.contains(&occupied_port.to_string()));
    }

    #[test]
    fn instance_endpoint_contains_runtime_identity() {
        assert_eq!(
            instance_endpoint(18744, "instance-a"),
            "http://127.0.0.1:18744/instances/instance-a/mcp"
        );
        assert_ne!(
            instance_endpoint(18744, "instance-a"),
            instance_endpoint(18744, "instance-b")
        );
    }

    #[test]
    fn status_returns_only_the_started_runtime_endpoint() {
        let status = McpServerStatus::default();
        assert!(status.endpoint().is_err());

        let runtime = McpServerRuntime {
            port: 18744,
            endpoint: instance_endpoint(18744, "instance-a"),
            instance_id: "instance-a".to_string(),
        };
        status.set_started(&runtime).expect("store runtime status");

        assert_eq!(status.endpoint(), Ok(runtime.endpoint));
    }

    #[test]
    fn resolve_pending_response_drops_unknown_ids_silently() {
        // unknown id → Ok(()) を返すが map には何も残らない。
        let before_len = lock_pending().len();
        let result = resolve_pending_response("00000000-0000-0000-0000-000000000000", Value::Null);
        assert!(result.is_ok());
        assert_eq!(lock_pending().len(), before_len);
    }

    #[test]
    fn voice_playback_provenance_ignores_out_of_order_updates() {
        let mut state = VoicePlaybackLeaseState {
            provenance: VoicePlaybackProvenance {
                owner_id: "current-owner".to_string(),
                generation: 2,
                fallback_playback_enabled: true,
            },
            next_registration: 1,
            active_registration: 1,
            candidates: HashMap::new(),
        };
        assert!(apply_voice_playback_update(
            &mut state,
            VoicePlaybackProvenance {
                owner_id: "current-owner".to_string(),
                generation: 1,
                fallback_playback_enabled: false,
            },
        )
        .is_err());
        assert!(state.provenance.fallback_playback_enabled);

        assert!(apply_voice_playback_update(
            &mut state,
            VoicePlaybackProvenance {
                owner_id: "stale-owner".to_string(),
                generation: 3,
                fallback_playback_enabled: false,
            },
        )
        .is_err());
        assert_eq!(state.provenance.owner_id, "current-owner");
        assert!(state.provenance.fallback_playback_enabled);

        assert!(apply_voice_playback_update(
            &mut state,
            VoicePlaybackProvenance {
                owner_id: "current-owner".to_string(),
                generation: 3,
                fallback_playback_enabled: false,
            },
        )
        .is_ok());
        assert!(!state.provenance.fallback_playback_enabled);
    }

    #[test]
    fn voice_playback_provenance_accepts_idempotent_retry() {
        let mut state = VoicePlaybackLeaseState {
            provenance: VoicePlaybackProvenance {
                owner_id: "current-owner".to_string(),
                generation: 2,
                fallback_playback_enabled: true,
            },
            next_registration: 1,
            active_registration: 1,
            candidates: HashMap::new(),
        };

        assert!(apply_voice_playback_update(
            &mut state,
            VoicePlaybackProvenance {
                owner_id: "current-owner".to_string(),
                generation: 2,
                fallback_playback_enabled: true,
            },
        )
        .is_ok());
        assert!(state.provenance.fallback_playback_enabled);
    }

    #[test]
    fn voice_playback_reordered_registration_and_updates_preserve_the_active_lease() {
        let mut state = VoicePlaybackLeaseState::default();
        register_voice_playback_owner_with_id(&mut state, "previous-owner".to_string());
        register_voice_playback_owner_with_id(&mut state, "current-owner".to_string());

        assert!(apply_voice_playback_update(
            &mut state,
            VoicePlaybackProvenance {
                owner_id: "current-owner".to_string(),
                generation: 0,
                fallback_playback_enabled: true,
            },
        )
        .is_ok());
        assert!(apply_voice_playback_update(
            &mut state,
            VoicePlaybackProvenance {
                owner_id: "previous-owner".to_string(),
                generation: 1,
                fallback_playback_enabled: false,
            },
        )
        .is_err());

        register_voice_playback_owner_with_id(&mut state, "delayed-previous-owner".to_string());
        assert_eq!(state.provenance.owner_id, "current-owner");
        assert!(apply_voice_playback_update(
            &mut state,
            VoicePlaybackProvenance {
                owner_id: "current-owner".to_string(),
                generation: 1,
                fallback_playback_enabled: false,
            },
        )
        .is_ok());

        assert_eq!(state.provenance.owner_id, "current-owner");
        assert!(!state.provenance.fallback_playback_enabled);
    }

    #[test]
    fn registering_voice_playback_owner_issues_unique_candidates_without_stealing() {
        let before = voice_playback_provenance();
        let first = register_voice_playback_owner();
        let second = register_voice_playback_owner();

        assert_ne!(first, second);
        assert_eq!(voice_playback_provenance(), before);
    }
}
