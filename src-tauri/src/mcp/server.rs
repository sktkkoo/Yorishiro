//! Yorishiro MCP server の起動と lifecycle、および Rust → TS event channel の
//! round-trip 管理。
//!
//! port は `~/.yorishiro/config.json` の mcpPort か default 18743。bind fail
//! は log に書いて server 起動を skip、Yorishiro 本体は継続させる。
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
}

pub(crate) fn resolve_port() -> u16 {
    read_configured_port().unwrap_or(DEFAULT_PORT)
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

/// MCP server を spawn する。bind fail で panic せず Err を返す。
/// 呼び出し元（lib.rs setup）が Err を dev-log に落として継続する。
pub fn spawn_server(app_handle: AppHandle) -> Result<u16, String> {
    let port = resolve_port();

    // bind pre-check — rmcp 側の async bind 前に占有確認。ここで fail したら
    // early return して Yorishiro 本体は継続させる。
    let probe = std::net::TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("port {} bind failed: {}", port, e))?;
    drop(probe); // すぐ解放、rmcp 側で再 bind。

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
    let router = axum::Router::new().nest_service("/mcp", service);

    // Tauri 2 の setup closure は tokio runtime context 内で動かないため、
    // `tokio::spawn` を直接呼ぶと "no reactor running" panic になる。
    // tauri の async_runtime::spawn は Tauri 本体の tokio runtime 上に task を
    // 流すため、setup の外側からでも安全に呼べる。
    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[yorishiro-mcp] bind failed after probe: {}", e);
                return;
            }
        };
        if let Err(e) = axum::serve(listener, router).await {
            eprintln!("[yorishiro-mcp] axum::serve exited: {}", e);
        }
    });

    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_port_falls_back_to_default_when_no_config() {
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
        assert_eq!(resolve_port(), DEFAULT_PORT);
        if let Some(h) = orig {
            std::env::set_var("HOME", h);
        }
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
