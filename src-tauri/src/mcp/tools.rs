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

/// `get_ui_state` の引数。pack 内部 state の読み取り。key 省略時は full snapshot を返す。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetUiStateRequest {
    /// Pack id（必須）。pack 内部 state は pack ごとに分離されている。
    #[serde(rename = "packId")]
    pub pack_id: String,
    /// Optional state key. Omit to retrieve all keys.
    pub key: Option<String>,
}

/// `set_ui_state` の引数。pack 内部 state への書き込み。value は JSON value として TS runtime に渡す。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetUiStateRequest {
    /// Pack id（必須）。pack 内部 state は pack ごとに分離されている。
    #[serde(rename = "packId")]
    pub pack_id: String,
    /// Target state key.
    pub key: String,
    /// JSON value to store.
    pub value: Value,
}

/// `state_get` の引数。空 object。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StateGetRequest {}

/// `body_expression_set` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BodyExpressionSetRequest {
    /// VRM expression preset 名（"happy" / "angry" / "sad" / "relaxed" / "surprised" / "neutral" など）。
    pub preset: String,
    /// 0-1, default 1。0 で表情解除。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intensity: Option<f32>,
}

/// `space_effect_play` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SpaceEffectPlayRequest {
    /// Effect kind（既存 effect pack の handler key、例: "fireworks" / "letter" / "shake"）。
    pub kind: String,
    /// effect handler が解釈する任意 payload。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
}

/// `scene_camera_set` の引数。すべて optional、与えた field のみ更新。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SceneCameraSetRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<[f32; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<[f32; 3]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fov: Option<f32>,
    /// 補間時間（ms）。省略 / 0 で即時反映（既存動作）。
    #[serde(rename = "durationMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
    /// カメラ自動追従（head tracking）の有効/無効。省略で変更なし。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking: Option<bool>,
}

/// `scene_lighting_set` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SceneLightingSetRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intensity: Option<f32>,
    /// "#rrggbb" hex string
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// 補間時間（ms）。省略 / 0 で即時反映（既存動作）。
    #[serde(rename = "durationMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
}

/// `body_animation_play` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BodyAnimationPlayRequest {
    /// アニメーション ref（例: "anim:VRMA_small_nod" / "anim:Typing" 等）。
    pub animation: String,
    /// フェードイン ms。default 200。
    #[serde(rename = "fadeInMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fade_in_ms: Option<u32>,
    /// フェードアウト ms。default 250。
    #[serde(rename = "fadeOutMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fade_out_ms: Option<u32>,
    /// weight 0-1。default 1。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f32>,
    /// ループ再生するか。default false。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub r#loop: Option<bool>,
    /// 再生速度倍率。default 1。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speed: Option<f32>,
}

/// `body_motion_cancel` の引数。空。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BodyMotionCancelRequest {}

/// `scene_screenshot` の引数。optional camera override で「カメラ移動→撮影→復元」をアトミックに行う。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SceneScreenshotRequest {
    /// Camera position override [x, y, z]。省略で現在位置のまま撮影。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<[f32; 3]>,
    /// Camera lookAt target override [x, y, z]。省略で現在の向きのまま。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<[f32; 3]>,
    /// Camera field of view override (degrees)。省略で現在の fov。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fov: Option<f32>,
}

/// `app_screenshot` の引数。空 object。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct AppScreenshotRequest {}

/// `scene_activate` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SceneActivateRequest {
    /// Pack id（null で active を clear）。registry のみ更新、config.json は触らない。
    pub id: Option<String>,
}

/// `ui_activate` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UiActivateRequest {
    /// Pack id（null で active を clear）。registry のみ更新、config.json は触らない。
    pub id: Option<String>,
}

/// `ui_scene_layer_set` の引数。scene layer の blur / opacity を操作する。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UiSceneLayerSetRequest {
    /// Layer role: "background" or "foreground"
    pub role: String,
    /// Blur radius (px)。null でリセット（= blur なし）。省略は変更なし。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blur: Option<f32>,
    /// Opacity 0-1。null でリセット（= 1）。省略は変更なし。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    /// 補間時間（ms）。省略 / 0 で即時反映。
    #[serde(rename = "durationMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
}

/// `ui_terminal_set` の引数。terminal container の opacity を操作する。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UiTerminalSetRequest {
    /// Terminal container opacity 0-1。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub opacity: Option<f32>,
    /// 補間時間（ms）。省略 / 0 で即時反映。
    #[serde(rename = "durationMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
}

/// `ui_sidebar_set` の引数。sidebar の幅を操作する。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UiSidebarSetRequest {
    /// Sidebar width in px（数値）。CSS custom property `--sidebar-width` を操作する。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f32>,
    /// Sidebar width in %（0–100）。ウィンドウ幅に対する割合。width と同時指定時は widthPercent を優先。
    #[serde(rename = "widthPercent")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width_percent: Option<f32>,
    /// 補間時間（ms）。省略 / 0 で即時反映。
    #[serde(rename = "durationMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
}

/// `journal_write` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct JournalWriteRequest {
    /// 日付（YYYY-MM-DD 形式）。
    pub date: String,
    /// 書き込む内容。
    pub content: String,
    /// 印象に残ったことの一行要約。指定すると memories.md に追記される。
    pub summary: Option<String>,
}

/// `journal_read` の引数。date / days いずれも省略時は最新 7 日分を返す。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct JournalReadRequest {
    /// 読み取る日付（YYYY-MM-DD 形式）。指定時はその日のエントリのみ返す。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// 最新 N 日分を返す。date 指定時は無視される。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub days: Option<u32>,
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

    /// get_ui_state: pack 内部 state の読み取り。app-level UI（sidebar 幅等）ではなく、
    /// 個別 pack が ctx.state で保持する key-value。
    #[tool(
        description = "Read pack internal state by packId. Pass key to read one value, or omit key for all state. This is per-pack state (e.g. slider values), NOT app-level UI (use ui_sidebar_set etc. for that)."
    )]
    async fn get_ui_state(
        &self,
        Parameters(req): Parameters<GetUiStateRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(
            &self.app_handle,
            "get-ui-state",
            json!({ "packId": req.pack_id, "key": req.key }),
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }

    /// set_ui_state: pack 内部 state への書き込み。ctx.state subscribers に通知する。
    #[tool(description = "Set one UI pack state value by key")]
    async fn set_ui_state(
        &self,
        Parameters(req): Parameters<SetUiStateRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(
            &self.app_handle,
            "set-ui-state",
            json!({ "packId": req.pack_id, "key": req.key, "value": req.value }),
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }

    // 以下 5 tool は dot.notation の dispatch key を使う。既存 kebab key との
    // dual convention は Phase γ で actions registry 抽出時に再考
    // （specs/2026-04-28-mcp-mvp-design.md §Tool naming）。

    /// state_get: config / camera / lighting / vrm load を集約した snapshot を返す。
    #[tool(
        description = "Snapshot Charminal current state (config / camera / lighting / vrm load)."
    )]
    async fn state_get(
        &self,
        _params: Parameters<StateGetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(&self.app_handle, "state.get", json!({})).await
    }

    /// body_expression_set: VRM expression preset を設定（意識層 → 身体の path のみ、
    /// 反射層は別の non-MCP path を使う）。
    #[tool(
        description = "Set the resident's facial expression preset (conscious-layer path; reflex-driven expressions use a separate non-MCP path)."
    )]
    async fn body_expression_set(
        &self,
        Parameters(req): Parameters<BodyExpressionSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "body.expression.set",
            json!({ "preset": req.preset, "intensity": req.intensity }),
        )
        .await
    }

    /// space_effect_play: scene effect を kind で発火する。in-process pack の
    /// `ctx.space.injectEffect` と同 dispatcher。
    #[tool(
        description = "Dispatch a scene effect by kind (same dispatcher as in-process pack code; no listener = no-op)."
    )]
    async fn space_effect_play(
        &self,
        Parameters(req): Parameters<SpaceEffectPlayRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "space.effect.play",
            json!({ "kind": req.kind, "payload": req.payload }),
        )
        .await
    }

    /// scene_camera_set: PerspectiveCamera の position / lookAt target / fov を更新する。
    #[tool(description = "Set scene camera position, lookAt target, or fov.")]
    async fn scene_camera_set(
        &self,
        Parameters(req): Parameters<SceneCameraSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "scene.camera.set",
            json!({
                "position": req.position,
                "target": req.target,
                "fov": req.fov,
                "durationMs": req.duration_ms,
                "tracking": req.tracking,
            }),
        )
        .await
    }

    /// scene_lighting_set: scene の DirectionalLight の intensity / color を更新する。
    #[tool(description = "Set scene DirectionalLight intensity and/or color (#rrggbb).")]
    async fn scene_lighting_set(
        &self,
        Parameters(req): Parameters<SceneLightingSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "scene.lighting.set",
            json!({ "intensity": req.intensity, "color": req.color, "durationMs": req.duration_ms }),
        )
        .await
    }

    /// 住人 AI が意識的に body animation を再生する（priority mcp-conscious）。
    #[tool(
        description = "Play a body animation at mcp-conscious priority. Preempts lower-priority motions (persona/state/idle). Re-calling replaces the current MCP animation."
    )]
    async fn body_animation_play(
        &self,
        Parameters(req): Parameters<BodyAnimationPlayRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "body.animation.play",
            json!({
                "animation": req.animation,
                "fadeInMs": req.fade_in_ms,
                "fadeOutMs": req.fade_out_ms,
                "weight": req.weight,
                "loop": req.r#loop,
                "speed": req.speed,
            }),
        )
        .await
    }

    /// MCP source の active body animation を停止する。他 source には影響しない。
    #[tool(
        description = "Cancel the current MCP-initiated body animation. Other sources (persona/state/idle) are not affected."
    )]
    async fn body_motion_cancel(
        &self,
        _params: Parameters<BodyMotionCancelRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(&self.app_handle, "body.motion.cancel", json!({})).await
    }

    /// scene layer の blur / opacity を設定する。durationMs > 0 で TweenManager による滑らか補間。
    #[tool(
        description = "Set scene layer blur and/or opacity. Supports smooth interpolation via durationMs."
    )]
    async fn ui_scene_layer_set(
        &self,
        Parameters(req): Parameters<UiSceneLayerSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "ui.scene-layer.set",
            json!({
                "role": req.role,
                "blur": req.blur,
                "opacity": req.opacity,
                "durationMs": req.duration_ms,
            }),
        )
        .await
    }

    /// terminal container の opacity を設定する。durationMs > 0 で TweenManager による滑らか補間。
    #[tool(description = "Set terminal opacity. Supports smooth interpolation via durationMs.")]
    async fn ui_terminal_set(
        &self,
        Parameters(req): Parameters<UiTerminalSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "ui.terminal.set",
            json!({
                "opacity": req.opacity,
                "durationMs": req.duration_ms,
            }),
        )
        .await
    }

    /// sidebar の幅を設定する。durationMs > 0 で TweenManager による滑らか補間。
    #[tool(description = "Set sidebar width (px). Supports smooth interpolation via durationMs.")]
    async fn ui_sidebar_set(
        &self,
        Parameters(req): Parameters<UiSidebarSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "ui.sidebar.set",
            json!({
                "width": req.width,
                "widthPercent": req.width_percent,
                "durationMs": req.duration_ms,
            }),
        )
        .await
    }

    /// scene pack の active を runtime-only で切り替える。config.json は触らない。
    #[tool(
        description = "Switch the active scene pack at runtime (registry only; does not persist to config.json). Pass null id to clear. Use list_packs to discover available scene pack ids."
    )]
    async fn scene_activate(
        &self,
        Parameters(req): Parameters<SceneActivateRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(&self.app_handle, "scene.activate", json!({ "id": req.id })).await
    }

    /// UI pack の active を runtime-only で切り替える。config.json は触らない。
    #[tool(
        description = "Switch the active UI pack at runtime (registry only; does not persist to config.json). Pass null id to clear. Use list_packs to discover available ui pack ids."
    )]
    async fn ui_activate(
        &self,
        Parameters(req): Parameters<UiActivateRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(&self.app_handle, "ui.activate", json!({ "id": req.id })).await
    }

    /// Three.js canvas のスクリーンショットを撮影する。optional camera override で
    /// 任意の角度・位置・FOV から撮影し、撮影後にカメラを元の状態に復元する。
    #[tool(
        description = "Capture a screenshot of the Three.js scene canvas. Optionally override camera position/target/fov for the shot — camera is restored after capture. Returns an image."
    )]
    async fn scene_screenshot(
        &self,
        Parameters(req): Parameters<SceneScreenshotRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(
            &self.app_handle,
            "scene.screenshot",
            json!({
                "position": req.position,
                "target": req.target,
                "fov": req.fov,
            }),
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_image_response(response)
    }

    /// journal にエントリを書き込む。住人の日々の記録。summary を指定すると memories.md にも追記される。
    #[tool(
        description = "journal にエントリを書き込む。住人の日々の記録。summary を渡すと記憶に残る"
    )]
    async fn journal_write(
        &self,
        Parameters(req): Parameters<JournalWriteRequest>,
    ) -> Result<CallToolResult, McpError> {
        if let Err(msg) = crate::journal::write_entry(&req.date, &req.content) {
            return Err(McpError::internal_error(msg, None));
        }

        if let Some(ref summary) = req.summary {
            if let Err(msg) = crate::journal::append_memory(&req.date, summary) {
                return Err(McpError::internal_error(msg, None));
            }
        }

        let has_memory = req.summary.is_some();
        let content = Content::json(json!({ "ok": true, "date": req.date, "memory": has_memory }))?;
        Ok(CallToolResult::success(vec![content]))
    }

    /// journal エントリを読み取る。日付指定または最新 N 日分。
    #[tool(description = "journal エントリを読み取る。日付指定または最新 N 日分")]
    async fn journal_read(
        &self,
        Parameters(req): Parameters<JournalReadRequest>,
    ) -> Result<CallToolResult, McpError> {
        if let Some(date) = req.date {
            match crate::journal::read_entry(&date) {
                Ok(Some(text)) => {
                    let content = Content::json(json!({ "date": date, "content": text }))?;
                    Ok(CallToolResult::success(vec![content]))
                }
                Ok(None) => {
                    let content = Content::json(json!({ "date": date, "content": null }))?;
                    Ok(CallToolResult::success(vec![content]))
                }
                Err(msg) => Err(McpError::internal_error(msg, None)),
            }
        } else {
            // 最新 N 日分モード（clai/ + seed/ を統合）
            let days = req.days.unwrap_or(7) as usize;
            match crate::journal::read_recent(days) {
                Ok(entries) => {
                    let content = Content::json(json!({ "entries": entries }))?;
                    Ok(CallToolResult::success(vec![content]))
                }
                Err(msg) => Err(McpError::internal_error(msg, None)),
            }
        }
    }

    /// ウィンドウ全体（DOM + WebGL canvas）のスクリーンショットを撮影する。macOS のみ。
    #[tool(
        description = "Capture a screenshot of the entire Charminal window (DOM + WebGL canvas). macOS only."
    )]
    async fn app_screenshot(
        &self,
        _params: Parameters<AppScreenshotRequest>,
    ) -> Result<CallToolResult, McpError> {
        crate::mcp::screenshot::capture_webview_screenshot(&self.app_handle).await
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for Charminal {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(ServerCapabilities::builder().enable_tools().build())
            .with_instructions("Charminal user-layer inspection tools")
    }
}

/// 共通 helper: emit_tool_event + unwrap_ts_response。
async fn emit_to(app: &AppHandle, tool: &str, request: Value) -> Result<CallToolResult, McpError> {
    let r = emit_tool_event(app, tool, request)
        .await
        .map_err(|e| McpError::internal_error(e, None))?;
    unwrap_ts_response(r)
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

/// TS 側が返す `{ ok, payload: { dataUrl: "data:image/png;base64,..." } }` を
/// MCP `ImageContent` に変換する。screenshot tool 専用。
fn unwrap_image_response(response: Value) -> Result<CallToolResult, McpError> {
    let ok = response
        .get("ok")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    if !ok {
        let reason = response
            .get("reason")
            .and_then(|v| v.as_str())
            .unwrap_or("ts handler error")
            .to_string();
        return Err(McpError::internal_error(reason, None));
    }
    let data_url = response
        .get("payload")
        .and_then(|p| p.get("dataUrl"))
        .and_then(|v| v.as_str())
        .ok_or_else(|| McpError::internal_error("missing dataUrl in response", None))?;

    let base64_data = data_url
        .strip_prefix("data:image/png;base64,")
        .unwrap_or(data_url);

    let content = Content::image(base64_data, "image/png");
    Ok(CallToolResult::success(vec![content]))
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

    #[test]
    fn unwrap_image_response_extracts_base64_from_data_url() {
        let resp = json!({
            "ok": true,
            "payload": { "dataUrl": "data:image/png;base64,AAAA" }
        });
        let result = unwrap_image_response(resp).expect("ok");
        assert_ne!(result.is_error, Some(true));
        // Content::image wraps base64 data (prefix stripped)
        let content = &result.content[0];
        let serialized = serde_json::to_value(content).unwrap();
        assert_eq!(serialized["data"], "AAAA");
        assert_eq!(serialized["mimeType"], "image/png");
    }

    #[test]
    fn unwrap_image_response_handles_raw_base64_without_prefix() {
        let resp = json!({
            "ok": true,
            "payload": { "dataUrl": "RAWBASE64DATA" }
        });
        let result = unwrap_image_response(resp).expect("ok");
        let content = &result.content[0];
        let serialized = serde_json::to_value(content).unwrap();
        assert_eq!(serialized["data"], "RAWBASE64DATA");
    }

    #[test]
    fn unwrap_image_response_maps_not_ok_to_error() {
        let resp = json!({ "ok": false, "reason": "scene not ready" });
        let err = unwrap_image_response(resp).expect_err("should be err");
        assert!(err.message.contains("scene not ready"));
    }

    #[test]
    fn unwrap_image_response_returns_error_on_missing_data_url() {
        let resp = json!({ "ok": true, "payload": {} });
        let err = unwrap_image_response(resp).expect_err("should be err");
        assert!(err.message.contains("missing dataUrl"));
    }
}
