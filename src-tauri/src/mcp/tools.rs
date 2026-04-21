//! MCP tool ハンドラ。`list_load_errors` は file read のみで Rust 内で完結、
//! その他の tool は TS runtime への
//! event channel round-trip を経由する。
//!
//! rmcp 1.5.0 の `#[tool_router]` + `#[tool_handler]` macro pattern に乗せる。
//! session ごとに `Charminal::new(app_handle)` が呼ばれる（LocalSessionManager
//! が session lifecycle を管理する都合）。

use std::path::Path;

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{CallToolResult, Content, ServerCapabilities, ServerInfo},
    schemars, tool, tool_handler, tool_router, ErrorData as McpError, ServerHandler,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::mcp::server::emit_tool_event;
use crate::mcp::types::{ListLoadErrorsResponse, LoadError};
use crate::read_last_startup_report_impl;

/// `disable_pack` / `enable_pack` の引数。MCP client から `{"id": "..."}` で渡る。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PackIdRequest {
    /// Target pack id。
    pub id: String,
}

/// `list_packs` の引数。現状 body を取らないが、MCP の call_tool は object を
/// 期待するため、空 struct で受ける。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListPacksRequest {}

/// `list_load_errors` の引数。同上、空の object。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListLoadErrorsRequest {}

/// `get_ui_state` の引数。key 省略時は full snapshot を返す。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetUiStateRequest {
    /// Optional UI state key. Omit to retrieve all keys.
    pub key: Option<String>,
}

/// `set_ui_state` の引数。value は JSON value として TS runtime に渡す。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetUiStateRequest {
    /// Target UI state key.
    pub key: String,
    /// JSON value to store.
    pub value: Value,
}

#[derive(Clone)]
pub struct Charminal {
    app_handle: AppHandle,
    tool_router: ToolRouter<Self>,
}

impl Charminal {
    pub fn new(app_handle: AppHandle) -> Self {
        Self {
            app_handle,
            tool_router: Self::tool_router(),
        }
    }
}

#[tool_router]
impl Charminal {
    /// list_load_errors: Rust 側完結。~/.charminal/last-startup.json を読んで
    /// `status == "failed"` の entries を JSON で返す。
    #[tool(description = "List user packs that failed to load on last startup")]
    async fn list_load_errors(
        &self,
        _params: Parameters<ListLoadErrorsRequest>,
    ) -> Result<CallToolResult, McpError> {
        match list_load_errors_sync() {
            Ok(response) => {
                let content = Content::json(response)?;
                Ok(CallToolResult::success(vec![content]))
            }
            Err(msg) => Err(McpError::internal_error(msg, None)),
        }
    }

    /// list_packs: TS runtime に委譲。`{ packs: PackStatus[] }` を返す。
    #[tool(description = "List user packs with their current status")]
    async fn list_packs(
        &self,
        _params: Parameters<ListPacksRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(&self.app_handle, "list-packs", json!({}))
            .await
            .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }

    /// disable_pack: TS runtime に委譲。config.json に id を書いて registry
    /// から該当 kind を dispose する。
    #[tool(description = "Disable a user pack by id")]
    async fn disable_pack(
        &self,
        Parameters(req): Parameters<PackIdRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(&self.app_handle, "disable-pack", json!({ "id": req.id }))
            .await
            .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }

    /// enable_pack: TS runtime に委譲。config.json から id を外して reload を
    /// 依頼する。
    #[tool(description = "Enable a previously disabled user pack by id")]
    async fn enable_pack(
        &self,
        Parameters(req): Parameters<PackIdRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(&self.app_handle, "enable-pack", json!({ "id": req.id }))
            .await
            .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }

    /// get_ui_state: TS runtime に委譲。key ありなら `{ key, value }`、
    /// key なしなら `{ state }` を返す。
    #[tool(
        description = "Read UI pack state. Pass key to read one value, or omit key for all state."
    )]
    async fn get_ui_state(
        &self,
        Parameters(req): Parameters<GetUiStateRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(&self.app_handle, "get-ui-state", json!({ "key": req.key }))
            .await
            .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }

    /// set_ui_state: TS runtime に委譲。UI pack の ctx.state subscribers に通知する。
    #[tool(description = "Set one UI pack state value by key")]
    async fn set_ui_state(
        &self,
        Parameters(req): Parameters<SetUiStateRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(
            &self.app_handle,
            "set-ui-state",
            json!({ "key": req.key, "value": req.value }),
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Charminal {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Charminal user-layer inspection tools")
    }
}

/// TS 側 `dispatchToolEvent` が返す `{ ok, payload } | { ok, reason }` を
/// MCP `CallToolResult` に変換する。`ok: false` は MCP error として返す。
fn unwrap_ts_response(response: Value) -> Result<CallToolResult, McpError> {
    let ok = response
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if ok {
        let payload = response.get("payload").cloned().unwrap_or(Value::Null);
        let content = Content::json(payload)?;
        Ok(CallToolResult::success(vec![content]))
    } else {
        let reason = response
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("ts handler error")
            .to_string();
        Err(McpError::internal_error(reason, None))
    }
}

/// list_load_errors の実装本体（Rust 内で完結するため test からも直接叩ける）。
pub(crate) fn list_load_errors_sync() -> Result<ListLoadErrorsResponse, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let text = read_last_startup_report_impl(Path::new(&home))?;
    if text.is_empty() {
        return Ok(ListLoadErrorsResponse { errors: vec![] });
    }
    let parsed: Value =
        serde_json::from_str(&text).map_err(|e| format!("parse last-startup.json: {}", e))?;
    let results = parsed.get("loadResults").and_then(|v| v.as_array());
    let mut errors = Vec::new();
    if let Some(arr) = results {
        for item in arr {
            let status = item.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if status != "failed" {
                continue;
            }
            let id = item
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let kind = item
                .get("kind")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let err = item.get("error");
            let phase = err
                .and_then(|e| e.get("phase"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let message = err
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            errors.push(LoadError {
                id,
                kind,
                phase,
                message,
            });
        }
    }
    Ok(ListLoadErrorsResponse { errors })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;

    // HOME を書き換える tests は race する。同じ env key を掴む test 同士は
    // この Mutex で serialize する。
    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn tmp_home() -> PathBuf {
        let base = std::env::temp_dir();
        let tmp = base.join(format!(
            "charminal-mcp-tools-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join(".charminal")).expect("mkdir");
        tmp
    }

    #[test]
    fn list_load_errors_returns_empty_when_no_report() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home();
        std::env::set_var("HOME", &home);
        let r = list_load_errors_sync().expect("ok");
        assert!(r.errors.is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn list_load_errors_extracts_failed_entries_only() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home();
        std::env::set_var("HOME", &home);
        fs::write(
            home.join(".charminal/last-startup.json"),
            r#"{
                "timestamp": "2026-04-18T00:00:00Z",
                "safeMode": false,
                "loadResults": [
                    { "id": "ok", "kind": "effect", "status": "loaded" },
                    {
                        "id": "bad",
                        "kind": "persona",
                        "status": "failed",
                        "error": { "phase": "import", "message": "boom" }
                    }
                ]
            }"#,
        )
        .expect("write");
        let r = list_load_errors_sync().expect("ok");
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.errors[0].id, "bad");
        assert_eq!(r.errors[0].phase, "import");
        assert_eq!(r.errors[0].message, "boom");
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn unwrap_ts_response_extracts_payload_for_ok() {
        let resp = json!({ "ok": true, "payload": { "packs": [] } });
        let result = unwrap_ts_response(resp).expect("ok");
        assert_ne!(result.is_error, Some(true));
    }

    #[test]
    fn unwrap_ts_response_maps_not_ok_to_error() {
        let resp = json!({ "ok": false, "reason": "missing id" });
        let err = unwrap_ts_response(resp).expect_err("should be err");
        assert!(err.message.contains("missing id"));
    }
}
