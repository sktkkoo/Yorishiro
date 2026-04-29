/**
 * @charminal/runtime/terminal-runtime
 *
 * Webview-lifetime singleton holding xterm + PTY Channel + perception ref.
 * Internal design-record: 2026-04-17-terminal-runtime-singleton.md.
 */

export { DEFAULT_TERMINAL_THEME, getTerminalRuntime } from "./terminal-runtime";
export type { PtyParams, TerminalRuntime } from "./types";
