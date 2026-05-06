import type { SessionTabState } from "../runtime/session-tabs/types";
import type { SessionId } from "../runtime/sessions/types";

interface TabIndicatorProps {
  readonly state: SessionTabState;
  /** session id → 表示ラベル。見つからなければ id をそのまま表示。 */
  readonly labels: ReadonlyMap<SessionId, string>;
}

/**
 * Session が 2 つ以上のとき xterm 領域の下に表示する最小インジケーター。
 * 1 session のときは null を返す（非表示）。
 */
export default function TabIndicator({ state, labels }: TabIndicatorProps) {
  if (state.sessions.length <= 1) return null;

  return (
    <div className="tab-indicator">
      {state.sessions.map((id) => {
        const isActive = id === state.activeSessionId;
        const label = labels.get(id) ?? id;
        return (
          <span key={id} className={`tab-indicator-item${isActive ? " active" : ""}`}>
            {isActive ? "●" : "○"} {label}
          </span>
        );
      })}
    </div>
  );
}
