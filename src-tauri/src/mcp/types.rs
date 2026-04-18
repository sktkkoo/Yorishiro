//! MCP tool の request / response DTO。Claude Code と TS runtime が双方
//! 同じ shape を見る。
//!
//! `list_load_errors` 以外の tool は Task 14-16 で接続されるため、それまで
//! DTO は tool ルーター経由で参照されない。pre-push の `-D warnings` を
//! 通すため module ごと `allow(dead_code)` とする（Task 14-16 完了時に解除）。

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
