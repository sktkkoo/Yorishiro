import type { SessionId } from "../sessions/types";

export interface VisibleTerminalSessionInput {
  readonly sessions: ReadonlyArray<SessionId>;
  readonly activeSessionId: SessionId;
  readonly defaultSessionId: SessionId;
}

/**
 * paired workspace で実際に attach する terminal session。
 *
 * default session は agent pane として常時残し、もう片方に active shell を出す。
 * active が default の場合だけ、先頭 shell を隣に置いて shell pane を保つ。
 */
export function resolveVisibleTerminalSessionIds({
  sessions,
  activeSessionId,
  defaultSessionId,
}: VisibleTerminalSessionInput): ReadonlyArray<SessionId> {
  if (sessions.length <= 1) return sessions;

  const defaultId = sessions.includes(defaultSessionId) ? defaultSessionId : sessions[0];
  const nonDefaultSessions = sessions.filter((id) => id !== defaultId);
  const pairedId =
    activeSessionId !== defaultId && sessions.includes(activeSessionId)
      ? activeSessionId
      : nonDefaultSessions[0];

  return pairedId === undefined ? [defaultId] : [defaultId, pairedId];
}
