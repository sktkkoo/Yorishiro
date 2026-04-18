//! Charminal MCP server の起動と lifecycle。
//!
//! port は `~/.charminal/config.json` の mcpPort か default 18743。bind fail
//! は log に書いて server 起動を skip、Charminal 本体は継続させる。
//!
//! rmcp 1.5.0 の `transport-streamable-http-server` feature を使う。
//! 手順（spike 確認済み）：
//!   1. `#[tool_router]` + `#[tool_handler]` impl で tool 群を定義（tools.rs 側）
//!   2. `StreamableHttpService::new` で service を作る
//!   3. axum Router に `nest_service("/mcp", service)` で mount
//!   4. `tokio::net::TcpListener::bind("127.0.0.1:port")` で listen
//!   5. `tokio::spawn` で background に流す
//!
//! 現 skeleton では rmcp server の実 mount を TODO(rmcp-wire) として残し、
//! bind pre-check と port resolve までを実装する。Task 13 で rmcp service を
//! 載せる（tool 4 本揃ったら一気に配線）。

use std::net::TcpListener;
use tauri::AppHandle;

const DEFAULT_PORT: u16 = 18743;

/// config.json の mcpPort を読む（不在 / 不正 → None）。
fn read_configured_port() -> Option<u16> {
    let home = std::env::var("HOME").ok()?;
    let path = std::path::Path::new(&home)
        .join(".charminal")
        .join("config.json");
    let text = std::fs::read_to_string(&path).ok()?;
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    parsed
        .get("mcpPort")
        .and_then(|v| v.as_u64())
        .and_then(|n| u16::try_from(n).ok())
}

fn resolve_port() -> u16 {
    read_configured_port().unwrap_or(DEFAULT_PORT)
}

/// MCP server を spawn する。bind fail で panic せず Err を返す。
/// 呼び出し元（lib.rs setup）が Err を dev-log に落として継続する。
pub fn spawn_server(app_handle: AppHandle) -> Result<u16, String> {
    let port = resolve_port();

    // bind test — rmcp の起動前に占有確認。ここで fail したら early return。
    let listener = TcpListener::bind(("127.0.0.1", port))
        .map_err(|e| format!("port {} bind failed: {}", port, e))?;
    drop(listener); // すぐ解放、rmcp 側で再 bind。

    // TODO(rmcp-wire): rmcp の StreamableHttpService を axum Router に mount
    //   して `tokio::spawn` で background に流す。spike 結果（2026-04-18）：
    //     - rmcp 1.5.0 + transport-streamable-http-server + axum 0.8 で
    //       localhost bind + async tool handler が成立することを確認
    //     - tool 登録は `#[tool_router]` + `#[tool]` マクロ経由（closure ではなく
    //       struct method だが、async fn を取るので要件は満たす）
    //     - Tauri 2 の tokio runtime は setup closure 内から `tokio::spawn`
    //       できる（Tauri は tokio runtime を持っている）
    //   Task 13 で tool 4 本を tools.rs に揃えた時点で配線する。
    let _ = app_handle;
    Ok(port)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_port_falls_back_to_default_when_no_config() {
        // HOME を存在しない path に向ければ config 不在扱いになる。
        let orig = std::env::var("HOME").ok();
        std::env::set_var(
            "HOME",
            std::env::temp_dir().join(format!(
                "charminal-mcp-server-missing-{}",
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
}
