/**
 * @charminal/runtime/sessions
 *
 * Session lifecycle 管理。1 session = 1 PTY + descriptor。Phase A は
 * type 定義のみ、Registry は subsequent task で landing する。
 *
 * Internal design-record: 2026-05-05-multi-pane-terminal.md.
 */

export {
  getBundledProfile,
  listAvailableProfiles,
  listBundledProfiles,
  resolveProfile,
} from "./profiles";
export { getSessionRegistry, SessionRegistry } from "./session-registry";
export type {
  SessionActivity,
  SessionDescriptor,
  SessionEvent,
  SessionId,
  SessionKind,
  SessionLifecycle,
  SessionProfile,
} from "./types";
export { DEFAULT_SESSION_ID } from "./types";
