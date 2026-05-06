/**
 * Session tab の状態型。SessionTabManager が管理する。
 */

import type { SessionId } from "../sessions/types";

/**
 * タブの並び順 + active + 保護対象を表す immutable state。
 * React 側は useSyncExternalStore でこれを subscribe する。
 */
export interface SessionTabState {
  readonly sessions: ReadonlyArray<SessionId>;
  readonly activeSessionId: SessionId;
  readonly mainSessionId: SessionId;
}

/**
 * SessionTabManager が emit する listener callback の型。
 */
export type SessionTabListener = (state: SessionTabState) => void;
