/**
 * @charminal/runtime/terminal-runtime
 *
 * Session id でキーされる TerminalRuntime instance Map（webview lifetime）。
 * 各 session が自分の xterm + PTY Channel + perception ref を持つ。
 * multi-session 対応。
 *
 * Internal design-record: 2026-04-17-terminal-runtime-singleton.md /
 *                         2026-05-05-multi-pane-terminal.md。
 */

export {
  DEFAULT_TERMINAL_THEME,
  disposeTerminalRuntime,
  getAllTerminalRuntimes,
  getTerminalRuntime,
} from "./terminal-runtime";
export type { InterruptProtectionMode, PtyParams, TerminalRuntime } from "./types";
