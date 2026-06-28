/**
 * @charminal/runtime/session-status
 *
 * Session ごとの観察状態（lifecycle / activity / unread / exit）を UI 向けに
 * 集約する read model。terminal release foundation Phase 1。observation only。
 */

export {
  detectScreenAttentionRequest,
  type ScreenAttentionDetection,
} from "./screen-attention-detector";
export {
  deriveSessionStatusBadge,
  getSessionStatusStore,
  isAttentionClearingInput,
  isNoteworthyBadge,
  type SessionAttention,
  type SessionStatus,
  type SessionStatusBadge,
  SessionStatusStore,
  type SessionStatusStoreOptions,
} from "./session-status-store";
