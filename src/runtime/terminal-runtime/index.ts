/**
 * @yorishiro/runtime/terminal-runtime
 *
 * Session id でキーされる TerminalRuntime instance Map（webview lifetime）。
 * 各 session が自分の xterm + PTY Channel + perception ref を持つ。
 * multi-session 対応。
 *
 * Internal design-record: 2026-04-17-terminal-runtime-singleton.md /
 *                         2026-05-05-multi-pane-terminal.md。
 */

export { type AgentToolRun, getAgentToolRunStore } from "./agent-tool-run-store";
export { getLoopRunStore, type LoopRun } from "./loop-run-store";
export {
  DEFAULT_TERMINAL_THEME,
  disposeTerminalRuntime,
  getAllTerminalRuntimes,
  getTerminalRuntime,
} from "./terminal-runtime";
export type {
  InterruptProtectionMode,
  LoopReelRecorderSink,
  PtyParams,
  TerminalRuntime,
} from "./types";
export { mergeRunTimeline, type RunTimelineEntry } from "./unified-timeline";
