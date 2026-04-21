//! MCP tool の request / response DTO。Claude Code と TS runtime が双方
//! 同じ shape を見る。
//!
//! Task 16 で event channel が配線された時点で `list_load_errors` の戻り
//! （`ListLoadErrorsResponse` + `LoadError`）は実際に参照される。残りの
//! DTO（`PackStatus` / `ListPacksResponse` / `PackIdArg` / `SimpleOkResponse`）
//! は「MCP 層が TS runtime に委譲する shape の宣言」として置いてあり、
//! 実体は TS 側 `charminal-mcp/tool-handlers.ts` が持つ。Rust 内では
//! 参照先を持たないので dead_code 警告が出る——共有 shape の document として
//! 残すため module 単位で allow する。

#![allow(dead_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
pub struct PackStatus {
    pub id: String,
    pub kind: String,
    /// "loaded" | "disabled" | "failed"
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListPacksResponse {
    pub packs: Vec<PackStatus>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LoadError {
    pub id: String,
    pub kind: String,
    pub phase: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ListLoadErrorsResponse {
    pub errors: Vec<LoadError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackIdArg {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SimpleOkResponse {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiStateValueResponse {
    #[serde(rename = "packId")]
    pub pack_id: String,
    pub key: String,
    pub value: serde_json::Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct UiStateSnapshotResponse {
    #[serde(rename = "packId")]
    pub pack_id: String,
    pub state: serde_json::Map<String, serde_json::Value>,
}
