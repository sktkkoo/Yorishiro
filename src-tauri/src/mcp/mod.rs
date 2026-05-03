//! Charminal MCP server。
//!
//! Rust backend に localhost HTTP(streamable) server を立て、Claude Code
//! plugin の .mcp.json から auto-discover される。tool ハンドラは tools.rs、
//! transport は server.rs。
//!
//! Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.5 / 4.6

pub mod screenshot;
pub mod server;
pub mod tools;
pub mod types;

pub use server::spawn_server;
