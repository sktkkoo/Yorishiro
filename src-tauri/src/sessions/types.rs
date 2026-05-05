//! Session 関連の型定義。TS 側 `src/runtime/sessions/types.ts` と 1:1 mirror。
//!
//! Internal design-record: 2026-05-05-multi-pane-terminal.md.

use serde::{Deserialize, Serialize};

/// Session の識別子。process / window 内で unique。
pub type SessionId = String;

/// Phase A で固定使用する default session の id（TS 側 DEFAULT_SESSION_ID と一致）。
pub const DEFAULT_SESSION_ID: &str = "default-session";

/// Session の種別。観察 / wrapper 注入 / hook 配線の分岐軸。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Shell,
    Agent,
}

/// Lifecycle state — process そのものの生死。観察 signal の有無に依存しない
/// 低レベルな fact。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionLifecycle {
    Starting,
    Running,
    Exited,
}

/// Activity state — 「いま何をしているか」の意味的な状態。OSC 133 marker や
/// agent hook 信号から導出する（Phase B 以降で生成 logic を追加）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionActivity {
    Idle,
    RunningCommand,
    AwaitingInput,
}

/// Session の identity / 構成情報。Registry が外に出す唯一の record。
/// mutable な lifecycle / activity は別 channel で取る。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionDescriptor {
    pub id: SessionId,
    pub profile_id: String,
    pub kind: SessionKind,
    pub label: String,
    pub cwd: Option<String>,
    /// epoch milliseconds at session creation。
    pub started_at: u64,
}

/// Registry が emit する event。serde tag で TS 側 discriminated union と整合。
///
/// Variant prefix の `Session` は JSON 上の `"type": "session-added"` 等と
/// 一致させるため意図的に保持（clippy::enum_variant_names を抑制）。
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
#[allow(clippy::enum_variant_names)]
pub enum SessionEvent {
    SessionAdded {
        descriptor: SessionDescriptor,
    },
    SessionRemoved {
        id: SessionId,
    },
    /// A-4b の PtySession spawn 完了時に emit される（lifecycle Starting → Running）。
    #[allow(dead_code)]
    SessionLifecycleChanged {
        id: SessionId,
        lifecycle: SessionLifecycle,
    },
    /// Phase B で OSC 133 / hook router から emit される。
    #[allow(dead_code)]
    SessionActivityChanged {
        id: SessionId,
        activity: SessionActivity,
    },
}
