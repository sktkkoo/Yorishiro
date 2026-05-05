//! Session 管理 layer。Phase A-4a では type 定義 + SessionRegistry skeleton のみ。
//! 実 PTY (PtySession) との配線は A-4b で `pty_session.rs` を追加する形で landing する。
//!
//! TS 側 `src/runtime/sessions/` と 1:1 mirror。
//!
//! Internal design-record: 2026-05-05-multi-pane-terminal.md.

pub mod pty_session;
pub mod registry;
pub mod types;

pub use pty_session::{PtySession, SpawnSpec};
pub use registry::SessionRegistry;
pub use types::{SessionDescriptor, SessionKind, DEFAULT_SESSION_ID};

// 以下は API surface に存在するが、このコミットでは外部から呼ばれていない。
// `set_activity` / `SessionActivityChanged` の wiring（Phase B の OSC 133 /
// hook router）と、`session_list` / `session_status` Tauri command（A-5）の
// 追加で削除予定。
#[allow(dead_code, unused_imports)]
pub use types::{SessionActivity, SessionEvent, SessionId, SessionLifecycle};
