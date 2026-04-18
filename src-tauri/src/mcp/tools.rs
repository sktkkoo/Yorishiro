//! MCP tool ハンドラ。list_load_errors は file read のみで Rust 内で完結、
//! 他は TS runtime への event channel round-trip を経由する（Task 14-16）。
//!
//! 現時点では rmcp の `#[tool_router]` impl に配線されていないため `pub fn`
//! は call site を持たない。Task 13 の rmcp wire-up で解除する。

#![allow(dead_code)]

use crate::mcp::types::{ListLoadErrorsResponse, LoadError};
use crate::read_last_startup_report_impl;
use serde_json::Value;
use std::path::Path;

/// list_load_errors: last-startup.json を読んで failed entries を抽出する。
pub fn list_load_errors() -> Result<ListLoadErrorsResponse, String> {
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
        let r = list_load_errors().expect("ok");
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
        let r = list_load_errors().expect("ok");
        assert_eq!(r.errors.len(), 1);
        assert_eq!(r.errors[0].id, "bad");
        assert_eq!(r.errors[0].phase, "import");
        assert_eq!(r.errors[0].message, "boom");
        let _ = fs::remove_dir_all(&home);
    }
}
