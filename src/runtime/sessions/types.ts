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
  readonly displayCwd: string | null;
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
    }
  | {
      readonly type: "session-cwd-changed";
      readonly id: SessionId;
      readonly cwd: string;
    };

/**
 * 起動時に存在する default session の id。
 */
export const DEFAULT_SESSION_ID: SessionId = "default-session";

/**
 * Session profile — session を起動するための宣言的 spec。`~/.charminal/config.json`
 * の `profiles[]` に書け、bundled profile (`shell` / `claude` / `codex` / `opencode`) と並ぶ。
 *
 * `kind` で観察 / wrapper 注入 / hook 配線が分岐する。
 * - `shell`: shell binary を spawn、`integration` true で OSC 133 wrapper を被せる
 * - `agent`: coding agent を spawn、`agent` field で adapter id を選ぶ
 *
 * `command` が null のとき：shell では `$SHELL`、agent では agent 既定 binary。
 */
export interface SessionProfile {
  readonly id: string;
  readonly kind: SessionKind;
  readonly command: string | null;
  readonly args: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string | null;
  /** `kind: "agent"` のとき adapter id、`kind: "shell"` のとき null。 */
  readonly agent: string | null;
  /** Charminal 側 instrumentation（OSC 133 / hook 注入）の有無。default true。 */
  readonly integration: boolean;
}
