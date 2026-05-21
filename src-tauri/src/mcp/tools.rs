//! MCP tool ハンドラ。`list_load_errors` は file read のみで Rust 内で完結、
//! その他の tool は TS runtime への
//! event channel round-trip を経由する。
//!
//! rmcp 1.5.0 の `#[tool_router]` + `#[tool_handler]` macro pattern に乗せる。
//! session ごとに `Charminal::new(app_handle)` が呼ばれる（LocalSessionManager
//! が session lifecycle を管理する都合）。

use std::collections::BTreeMap;

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

/// `pack_diagnose` の引数。kind 省略時は同 id の全 kind を診断する。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PackDiagnoseRequest {
    /// Target pack id.
    pub id: String,
    /// Optional pack kind filter, e.g. "scene" or "effect".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

/// `list_packs` の引数。現状 body を取らないが、MCP の call_tool は object を
/// 期待するため、空 struct で受ける。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListPacksRequest {}

/// `list_load_errors` の引数。同上、空の object。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ListLoadErrorsRequest {}

/// `get_ui_state` の引数。active scene pack の内部 state を読み取る。key 省略時は full snapshot。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct GetUiStateRequest {
    /// Optional state key. Omit to retrieve all keys.
    pub key: Option<String>,
}

/// `set_ui_state` の引数。active scene pack の内部 state への書き込み。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SetUiStateRequest {
    /// Target state key.
    pub key: String,
    /// JSON value to store.
    pub value: Value,
}

/// `controls_get` の引数。F2 controls panel の現在値を読む。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ControlsGetRequest {
    /// Control scope: "scene" (default) or "common".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Optional full Leva-style control path. Omit to retrieve all visible controls.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

/// `controls_set` の引数。F2 controls panel の値を書き換える。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ControlsSetRequest {
    /// Control scope: "scene" (default) or "common".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Full control path, e.g. "lights.directionalIntensity" or "camera.lookAtCharacter".
    pub path: String,
    /// JSON value to set.
    pub value: Value,
}

/// `controls_set_many` の引数。複数の F2 controls panel 値をまとめて書き換える。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ControlsSetManyRequest {
    /// Control scope: "scene" (default) or "common".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Map of full control path to JSON value.
    pub values: BTreeMap<String, Value>,
}

/// `controls_transition` の引数。数値 control と "#rrggbb" hex color は durationMs で補間し、それ以外は即時反映する。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ControlsTransitionRequest {
    /// Control scope: "scene" (default) or "common".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
    /// Map of full control path to target JSON value.
    pub values: BTreeMap<String, Value>,
    /// 補間時間（ms）。省略 / 0 で即時反映。
    #[serde(rename = "durationMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
}

/// `state_get` の引数。空 object。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct StateGetRequest {}

/// `terminal_context_get` の引数。空 object。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TerminalContextGetRequest {}

/// `body_expression_set` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct BodyExpressionSetRequest {
    /// VRM expression preset 名（"happy" / "angry" / "sad" / "relaxed" / "surprised" / "neutral" など）。
    pub preset: String,
    /// 0-1, default 1。0 で表情解除。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub intensity: Option<f32>,
    /// 表情の保持時間（ms）。省略時は短い transient 表情として自動解除。0 で永続。
    #[serde(rename = "durationMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
    /// true で明示解除まで表情を保持する。durationMs: 0 と同義。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hold: Option<bool>,
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

/// `pomodoro_start` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PomodoroStartRequest {
    /// 作業フェーズの長さ（ミリ秒）。省略時はフロント側デフォルト。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub work_ms: Option<u64>,
    /// 短い休憩の長さ（ミリ秒）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short_break_ms: Option<u64>,
    /// 長い休憩の長さ（ミリ秒）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub long_break_ms: Option<u64>,
    /// ラウンド数。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rounds: Option<u32>,
}

/// `pomodoro_stop` の引数。空 object。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PomodoroStopRequest {}

/// `pomodoro_status` の引数。空 object。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PomodoroStatusRequest {}

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

/// `ui_debug_panel_set` の引数。debug panel (leva) の表示/幅を操作する。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct UiDebugPanelSetRequest {
    /// true で表示、false で非表示。width と同時指定時は visible を優先。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
    /// パネル幅 (px)。0 で非表示。省略時は default (280px)。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<f32>,
    /// 補間時間（ms）。省略 / 0 で即時反映。
    #[serde(rename = "durationMs")]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u32>,
}

/// `voice_say` の引数。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct VoiceSayRequest {
    /// 声に出すテキスト。
    pub text: String,
    /// 音声名（省略時は OS デフォルト）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

/// `presence_set_intensity` の引数。存在濃度の切り替え。
#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct PresenceSetIntensityRequest {
    /// 存在濃度レベル。"default" = 通常表示、"closed" = すべて非表示。
    pub level: String,
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
    #[tool(
        description = "List user packs (~/.charminal/packs/) with their current status. User packs use flat layout: <id>/<kind>.js. Bundled packs are listed separately and are immutable."
    )]
    async fn list_packs(
        &self,
        _params: Parameters<ListPacksRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(&self.app_handle, "list-packs", json!({}))
            .await
            .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }

    /// pack_diagnose: TS runtime に委譲。pack 作成 / 編集後の自己修復用に
    /// runtime 状態、manifest summary、load error を 1 件にまとめて返す。
    #[tool(
        description = "Diagnose one pack by id. Returns loaded/failed/disabled status, active state, manifest summary, latest load error, and repair recommendations. Use after creating or editing a pack before reporting it as done."
    )]
    async fn pack_diagnose(
        &self,
        Parameters(req): Parameters<PackDiagnoseRequest>,
    ) -> Result<CallToolResult, McpError> {
        let response = emit_tool_event(
            &self.app_handle,
            "pack-diagnose",
            json!({ "id": req.id, "kind": req.kind }),
        )
        .await
        .map_err(|e| McpError::internal_error(e, None))?;
        unwrap_ts_response(response)
    }

    /// disable_pack: TS runtime に委譲。config.json に id を書いて registry
    /// から該当 kind を dispose する。
    #[tool(
        description = "Disable a user pack by id. Only works on user packs (~/.charminal/packs/); bundled packs are immutable and cannot be disabled via MCP. Modifies config.json."
    )]
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
    #[tool(
        description = "Enable a previously disabled user pack by id. Only works on user packs (~/.charminal/packs/); bundled packs are immutable and cannot be modified via MCP. Modifies config.json."
    )]
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
        description = "Read pack internal state by packId. Pass key to read one value, or omit key for all state. Omit packId to default to the active scene pack. This is per-pack state (e.g. slider values), NOT app-level UI (use ui_sidebar_set etc. for that)."
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

    /// set_ui_state: pack 内部 state への書き込み。ctx.state subscribers に通知する。
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

    /// controls_get: F2 controls panel に表示されている値を読む。
    #[tool(
        description = "Read visible F2 controls. scope defaults to scene. Use scope='scene' for active scene pack controls (lights/post effects/scene layers) and scope='common' for app-common controls (camera). Pass path to read one control, or omit path for all visible controls. Lighting controls are scene-pack-owned; available paths depend on the active scene pack."
    )]
    async fn controls_get(
        &self,
        Parameters(req): Parameters<ControlsGetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "controls.get",
            json!({ "scope": req.scope, "path": req.path }),
        )
        .await
    }

    /// controls_set: F2 controls panel に表示されている値を書き換える。
    #[tool(
        description = "Set one visible F2 control value immediately (no interpolation). Prefer controls_transition instead for smooth changes. scope defaults to scene. Use controls_get first to discover paths — available paths depend on the active scene pack."
    )]
    async fn controls_set(
        &self,
        Parameters(req): Parameters<ControlsSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "controls.set",
            json!({ "scope": req.scope, "path": req.path, "value": req.value }),
        )
        .await
    }

    /// controls_set_many: F2 controls panel に表示されている複数値をまとめて書き換える。
    #[tool(
        description = "Set multiple visible F2 control values at once immediately (no interpolation). Prefer controls_transition instead for smooth changes. scope defaults to scene. Use controls_get first to discover paths — available paths depend on the active scene pack."
    )]
    async fn controls_set_many(
        &self,
        Parameters(req): Parameters<ControlsSetManyRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "controls.set_many",
            json!({ "scope": req.scope, "values": req.values }),
        )
        .await
    }

    /// controls_transition: F2 controls panel に表示されている値を補間する。
    #[tool(
        description = "Transition visible F2 control values. Numeric controls and \"#rrggbb\" hex colors tween over durationMs; other nonnumeric controls apply immediately. Use controls_get first to discover paths — available paths depend on the active scene pack. Use this for camera moves and smooth scene/lighting demos."
    )]
    async fn controls_transition(
        &self,
        Parameters(req): Parameters<ControlsTransitionRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "controls.transition",
            json!({ "scope": req.scope, "values": req.values, "durationMs": req.duration_ms }),
        )
        .await
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

    /// terminal_context_get: user が Command+click や Option+Shift+drag で指し示した terminal text を返す。
    #[tool(
        description = "Return terminal text the user pointed at. Supports Cmd+click (line) and Option+Shift+drag (region). Response includes `context` (latest selection) and `references` (all [#TermN] markers in the current session). When the user's message contains [#Term1] etc., call this to resolve the referenced text."
    )]
    async fn terminal_context_get(
        &self,
        _params: Parameters<TerminalContextGetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(&self.app_handle, "terminal.context.get", json!({})).await
    }

    /// body_expression_set: VRM expression preset を設定（意識層 → 身体の path のみ、
    /// 反射層は別の non-MCP path を使う）。
    #[tool(
        description = "Set the resident's facial expression preset. Defaults to a short transient expression that auto-releases; pass durationMs:0 or hold:true to keep it until explicitly released."
    )]
    async fn body_expression_set(
        &self,
        Parameters(req): Parameters<BodyExpressionSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "body.expression.set",
            json!({
                "preset": req.preset,
                "intensity": req.intensity,
                "durationMs": req.duration_ms,
                "hold": req.hold
            }),
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

    /// debug panel (leva) の表示/幅を設定する。durationMs > 0 で TweenManager による滑らか補間。
    #[tool(
        description = "Show/hide the debug panel (leva). Use visible:true/false or width in px. Supports smooth interpolation via durationMs."
    )]
    async fn ui_debug_panel_set(
        &self,
        Parameters(req): Parameters<UiDebugPanelSetRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "ui.debugPanel.set",
            json!({
                "visible": req.visible,
                "width": req.width,
                "durationMs": req.duration_ms,
            }),
        )
        .await
    }

    /// 住人の存在濃度を切り替える。
    #[tool(description = "住人の存在濃度を切り替える。default = 通常表示、closed = すべて非表示。")]
    async fn presence_set_intensity(
        &self,
        Parameters(req): Parameters<PresenceSetIntensityRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "presence.set-intensity",
            json!({ "level": req.level }),
        )
        .await
    }

    /// voice_say: TTS でテキストを発話する。住人 AI がキャラクターとして
    /// 声に出したいセリフにのみ使う（全テキスト出力に使うものではない）。
    #[tool(
        description = "Speak text aloud using text-to-speech. Use this to say something out loud as the character — only call this for dialogue you intend to be heard, not for all text output."
    )]
    async fn voice_say(
        &self,
        Parameters(req): Parameters<VoiceSayRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "voice.say",
            json!({ "text": req.text, "voice": req.voice }),
        )
        .await
    }

    /// scene pack の active を runtime-only で切り替える。config.json は触らない。
    #[tool(
        description = "Switch the active scene pack at runtime (registry only; does not persist to config.json). Persistent activation is via config.json activeScene field, not this tool. Pass null id to clear. Use list_packs to discover available scene pack ids."
    )]
    async fn scene_activate(
        &self,
        Parameters(req): Parameters<SceneActivateRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(&self.app_handle, "scene.activate", json!({ "id": req.id })).await
    }

    /// UI pack の active を runtime-only で切り替える。config.json は触らない。
    #[tool(
        description = "Switch the active UI pack at runtime (registry only; does not persist to config.json). Persistent activation is via config.json activeUI field, not this tool. Pass null id to clear. Use list_packs to discover available ui pack ids."
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
        description = "journal にエントリを書き込む。住人の日々の記録。機械的なログではなく情緒的な思い出を書く。summary を渡すと記憶に残る"
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

    /// ポモドーロタイマーを開始する。
    #[tool(
        description = "Start a pomodoro session. Configurable work/break durations and rounds. Emits phase-change events for persona reactions and dims the terminal during breaks."
    )]
    async fn pomodoro_start(
        &self,
        Parameters(req): Parameters<PomodoroStartRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(
            &self.app_handle,
            "pomodoro.start",
            json!({
                "workMs": req.work_ms,
                "shortBreakMs": req.short_break_ms,
                "longBreakMs": req.long_break_ms,
                "rounds": req.rounds,
            }),
        )
        .await
    }

    /// ポモドーロタイマーを中断する。
    #[tool(description = "Stop the current pomodoro session.")]
    async fn pomodoro_stop(
        &self,
        _params: Parameters<PomodoroStopRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(&self.app_handle, "pomodoro.stop", json!({})).await
    }

    /// ポモドーロの現在状態を取得する。
    #[tool(
        description = "Get current pomodoro status: phase (idle/work/short-break/long-break), round, remaining time."
    )]
    async fn pomodoro_status(
        &self,
        _params: Parameters<PomodoroStatusRequest>,
    ) -> Result<CallToolResult, McpError> {
        emit_to(&self.app_handle, "pomodoro.status", json!({})).await
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
            .with_instructions(concat!(
                "Charminal — 住人の身体・声・環境を操作する MCP ツール群。\n",
                "\n",
                "## ツール選択ガイド\n",
                "- 声に出す → voice_say。発話するかどうかは system prompt の Voice セクションに従う\n",
                "- 現在の状態確認 → state_get\n",
                "- ユーザーが terminal 上で指し示したテキストを読む → terminal_context_get（Cmd+click で行、Option+Shift+drag で矩形。メッセージに [#TermN] マーカーがあればここで解決する）\n",
                "- 照明・カメラ等のパラメータ確認 → controls_get（scene pack 依存のパスを確認）\n",
                "- 照明・カメラ等を変更 → controls_transition（controls_set / controls_set_many は使わず、必ず controls_transition を使う）\n",
                "- 表情だけ変える → body_expression_set\n",
                "- ポーズ・ジェスチャーだけ → body_animation_play\n",
                "- pack の一覧・有効化・無効化 → list_packs / enable_pack / disable_pack\n",
                "\n",
                "## 重要ルール\n",
                "- controls のパスは active scene pack ごとに異なる。変更前に必ず controls_get で確認\n",
                "- bundled pack は不可変。disable_pack / enable_pack は user pack のみ\n",
                "- scene_activate / ui_activate は runtime 限定。永続切替は config.json の activeScene / activeUI\n",
                "- journal は機械的ログではなく情緒的な思い出を書く\n",
            ))
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
    let home = crate::home_dir_or_err()?;
    let text = read_last_startup_report_impl(&home)?;
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
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home();
        std::env::set_var("HOME", &home);
        let r = list_load_errors_sync().expect("ok");
        assert!(r.errors.is_empty());
        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn list_load_errors_extracts_failed_entries_only() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
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
