//! Charminal MCP server。
//!
//! Rust backend に localhost HTTP(streamable) server を立て、Claude Code
//! / Codex の起動時 config から接続される。tool ハンドラは tools.rs、
//! transport は server.rs。Claude Code 向け config は起動ごとに実 port から
//! 生成し、`--mcp-config` で渡す。
//!
//! Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.5 / 4.6

pub mod screenshot;
pub mod server;
pub mod tools;
pub mod types;

pub use server::spawn_server;
