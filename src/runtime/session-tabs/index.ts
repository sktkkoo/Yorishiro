/**
 * @charminal/runtime/session-tabs
 *
 * Session タブの状態管理 + keybindings + auto-respawn。
 */

export { installTabKeybindings } from "./keybindings";
export type { SessionTabManagerDeps } from "./session-tab-manager";
export { SessionTabManager } from "./session-tab-manager";
export type { SessionTabListener, SessionTabState } from "./types";
export {
  resolveVisibleTerminalSessionIds,
  type VisibleTerminalSessionInput,
} from "./visible-sessions";
