/**
 * Session lifecycle / activity types。1 session = 1 PTY + その meta。
 *
 * Internal design-record: 2026-05-05-multi-pane-terminal.md.
 */

/**
 * Session の識別子。process / window 内で unique。
 */
export type SessionId = string;

/**
 * Session の種別。観察・wrapper 注入・hook 配線の分岐軸。
 */
export type SessionKind = "shell" | "agent";

/**
 * Lifecycle state — process そのものの生死。観察 signal の有無に依存しない
 * 低レベルな fact。
 */
export type SessionLifecycle = "starting" | "running" | "exited";

/**
 * Activity state — 「いま何をしているか」の意味的な状態。OSC 133 marker や
 * agent hook 信号から導出する。
 */
export type SessionActivity = "idle" | "running-command" | "awaiting-input";

/**
 * Session の identity / 構成情報。Registry が外に出す唯一の record。
 * mutable な lifecycle / activity は別 channel（event / getter）で取る。
 */
export interface SessionDescriptor {
  readonly id: SessionId;
  readonly profileId: string;
  readonly kind: SessionKind;
  readonly label: string;
  readonly cwd: string | null;
  readonly startedAt: number;
}

/**
 * Registry が emit する event。consumer は subscribe で受ける。
 */
export type SessionEvent =
  | { readonly type: "session-added"; readonly descriptor: SessionDescriptor }
  | { readonly type: "session-removed"; readonly id: SessionId }
  | {
      readonly type: "session-lifecycle-changed";
      readonly id: SessionId;
      readonly lifecycle: SessionLifecycle;
    }
  | {
      readonly type: "session-activity-changed";
      readonly id: SessionId;
      readonly activity: SessionActivity;
    };

/**
 * 起動時に存在する default session の id。
 */
export const DEFAULT_SESSION_ID: SessionId = "default-session";
