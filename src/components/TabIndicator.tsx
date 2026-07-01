import { Plus, X } from "lucide-react";
import { deriveSessionStatusBadge, type SessionStatus } from "../runtime/session-status";
import type { SessionTabState } from "../runtime/session-tabs/types";
import type { SessionId } from "../runtime/sessions/types";

export type TabIndicatorBadgeTone = "agent-hook" | "charminal" | "danger";

export interface TabIndicatorBadge {
  readonly label: string;
  readonly tone: TabIndicatorBadgeTone;
  readonly title?: string;
}

interface TabIndicatorProps {
  readonly state: SessionTabState;
  /** session id → 表示ラベル。見つからなければ id をそのまま表示。 */
  readonly labels: ReadonlyMap<SessionId, string>;
  /** session id → 観察状態。未接続なら従来どおり active dot だけ表示する。 */
  readonly statuses?: ReadonlyMap<SessionId, SessionStatus>;
  readonly hookBadges?: ReadonlyMap<SessionId, TabIndicatorBadge>;
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
  hookBadges,
  onSelectSession,
  onAddSession,
  onCloseSession,
}: TabIndicatorProps) {
  return (
    <div className="tab-indicator">
      <div className="tab-indicator-tabs" role="tablist" aria-label="Terminal sessions">
        {state.sessions.map((id) => {
          const isActive = id === state.activeSessionId;
          const isMain = id === state.mainSessionId;
          const label = labels.get(id) ?? id;
          const status = statuses?.get(id) ?? null;
          const hookBadge = hookBadges?.get(id) ?? null;
          const badge = status ? deriveSessionStatusBadge(status) : null;
          const icon = badge ? stateIconForBadge(badge) : null;
          const flags = [
            isActive ? "active" : "",
            isMain ? "is-main" : "",
            state.sessions.length === 1 ? "is-single" : "",
            status?.unread ? "unread" : "",
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
                <span className="tab-indicator-label">{label}</span>
                {icon ? (
                  <span
                    className={`tab-indicator-state state-${icon.kind}`}
                    role="img"
                    aria-label={icon.label}
                  >
                    {icon.text ?? ""}
                  </span>
                ) : null}
                {hookBadge ? (
                  <span
                    className={`tab-indicator-hook-badge tone-${hookBadge.tone}`}
                    title={hookBadge.title}
                  >
                    {hookBadge.label}
                  </span>
                ) : null}
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
      </div>
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

type StateIcon = {
  readonly kind: "running" | "input" | "failed";
  readonly label: string;
  readonly text?: string;
};

function stateIconForBadge(badge: ReturnType<typeof deriveSessionStatusBadge>): StateIcon | null {
  switch (badge) {
    case "starting":
      return { kind: "running", label: "Starting" };
    case "running":
      return { kind: "running", label: "Running" };
    case "awaiting-input":
      return { kind: "input", label: "Needs input" };
    case "exited-fail":
      return { kind: "failed", label: "Failed", text: "!" };
    case "exited-ok":
    case "exited-unknown":
      return null;
    case "idle":
      return null;
  }
}

function attentionTitle(attention: NonNullable<SessionStatus["attention"]>): string {
  return attention.title ? `${attention.title}: ${attention.body}` : attention.body;
}
