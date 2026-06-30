import { Plus, X } from "lucide-react";
import {
  deriveSessionStatusBadge,
  isNoteworthyBadge,
  type SessionStatus,
} from "../runtime/session-status";
import type { SessionTabState } from "../runtime/session-tabs/types";
import type { SessionId } from "../runtime/sessions/types";

interface TabIndicatorProps {
  readonly state: SessionTabState;
  /** session id → 表示ラベル。見つからなければ id をそのまま表示。 */
  readonly labels: ReadonlyMap<SessionId, string>;
  /** session id → 観察状態。未接続なら従来どおり active dot だけ表示する。 */
  readonly statuses?: ReadonlyMap<SessionId, SessionStatus>;
  /** タブ選択。未指定なら表示専用。 */
  readonly onSelectSession?: (sessionId: SessionId) => void;
  readonly onAddSession?: () => void;
  readonly onCloseSession?: (sessionId: SessionId) => void;
}

/**
 * title bar に表示する session tab 列。
 * main session だけの場合も表示する。
 */
export default function TabIndicator({
  state,
  labels,
  statuses,
  onSelectSession,
  onAddSession,
  onCloseSession,
}: TabIndicatorProps) {
  return (
    <div className="tab-indicator" role="tablist" aria-label="Terminal sessions">
      {state.sessions.map((id) => {
        const isActive = id === state.activeSessionId;
        const isMain = id === state.mainSessionId;
        const label = labels.get(id) ?? id;
        const status = statuses?.get(id) ?? null;
        const badge = status ? deriveSessionStatusBadge(status) : null;
        const flags = [
          isActive ? "active" : "",
          status?.unread ? "unread" : "",
          badge && isNoteworthyBadge(badge) ? "noteworthy" : "",
          badge ? `badge-${badge}` : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <span key={id} className={`tab-indicator-item ${flags}`}>
            <button
              type="button"
              className="tab-indicator-tab"
              title={status?.attention ? attentionTitle(status.attention) : label}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelectSession?.(id)}
            >
              {status?.unread ? "◆" : isActive ? "●" : "○"} {label}
              {badge ? <span className="tab-indicator-status">{badgeLabel(badge)}</span> : null}
            </button>
            {!isMain && onCloseSession ? (
              <button
                type="button"
                className="tab-indicator-close"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                onClick={() => onCloseSession(id)}
              >
                <X size={12} strokeWidth={2} aria-hidden="true" />
              </button>
            ) : null}
          </span>
        );
      })}
      {onAddSession ? (
        <button
          type="button"
          className="tab-indicator-add"
          aria-label="New terminal tab"
          title="New terminal tab"
          onClick={onAddSession}
        >
          <Plus size={13} strokeWidth={2} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function attentionTitle(attention: NonNullable<SessionStatus["attention"]>): string {
  return attention.title ? `${attention.title}: ${attention.body}` : attention.body;
}

function badgeLabel(badge: ReturnType<typeof deriveSessionStatusBadge>): string {
  switch (badge) {
    case "awaiting-input":
      return "input";
    case "exited-fail":
      return "failed";
    case "exited-ok":
      return "done";
    case "exited-unknown":
      return "exited";
    case "running":
      return "run";
    case "starting":
      return "start";
    case "idle":
      return "idle";
  }
}
