import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import type { SpawnSpec } from "../bindings/tauri-commands";
import type { Perception } from "../core/perception";
import { resolveVisibleTerminalSessionIds } from "../runtime/session-tabs";
import type { SessionId } from "../runtime/sessions";
import Terminal from "../terminal";

const MIN_SPLIT_PERCENT = 25;
const MAX_SPLIT_PERCENT = 75;

interface TerminalWorkspaceProps {
  readonly sessions: ReadonlyArray<SessionId>;
  readonly activeSessionId: SessionId;
  readonly defaultSessionId: SessionId;
  readonly cwd: string | null;
  readonly getSessionCwd: (sessionId: SessionId) => string | null | undefined;
  readonly getSpec: (sessionId: SessionId) => SpawnSpec;
  readonly perception: Perception;
  readonly shouldAttachExistingSession: (sessionId: SessionId) => boolean;
  readonly onActivate: (sessionId: SessionId) => void;
}

function clampSplitPercent(value: number): number {
  return Math.min(MAX_SPLIT_PERCENT, Math.max(MIN_SPLIT_PERCENT, value));
}

export default function TerminalWorkspace({
  sessions,
  activeSessionId,
  defaultSessionId,
  cwd,
  getSessionCwd,
  getSpec,
  perception,
  shouldAttachExistingSession,
  onActivate,
}: TerminalWorkspaceProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [splitPercent, setSplitPercent] = useState(50);
  const visibleSessionIds = useMemo(
    () => resolveVisibleTerminalSessionIds({ sessions, activeSessionId, defaultSessionId }),
    [sessions, activeSessionId, defaultSessionId],
  );
  const visibleSessionIdSet = useMemo(() => new Set(visibleSessionIds), [visibleSessionIds]);
  const paired = visibleSessionIds.length >= 2;

  const startResize = useCallback((event: ReactPointerEvent<HTMLHRElement>) => {
    const root = rootRef.current;
    if (!root) return;
    event.preventDefault();
    const rect = root.getBoundingClientRect();
    if (rect.width <= 0) return;

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const next = ((moveEvent.clientX - rect.left) / rect.width) * 100;
      setSplitPercent(clampSplitPercent(next));
    };
    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
  }, []);

  const handleResizeKeyDown = useCallback((event: ReactKeyboardEvent<HTMLHRElement>) => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setSplitPercent((current) => clampSplitPercent(current - step));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setSplitPercent((current) => clampSplitPercent(current + step));
    }
  }, []);

  const renderTerminal = (sessionId: SessionId, visible: boolean) => {
    const sessionCwd = getSessionCwd(sessionId);
    const active = sessionId === activeSessionId;
    return (
      <Terminal
        key={sessionId}
        sessionId={sessionId}
        visible={visible}
        active={active}
        spec={getSpec(sessionId)}
        cwd={sessionCwd === undefined ? cwd : sessionCwd}
        perception={active ? perception : null}
        attachFirst={shouldAttachExistingSession(sessionId)}
        onActivate={onActivate}
      />
    );
  };

  if (!paired) {
    return (
      <div ref={rootRef} className="terminal-workspace terminal-workspace--single">
        {sessions.map((sessionId) => renderTerminal(sessionId, visibleSessionIdSet.has(sessionId)))}
      </div>
    );
  }

  const [primarySessionId, secondarySessionId] = visibleSessionIds;
  const hiddenSessionIds = sessions.filter((sessionId) => !visibleSessionIdSet.has(sessionId));
  const style = { "--terminal-workspace-left": `${splitPercent}%` } as CSSProperties;

  return (
    <div ref={rootRef} className="terminal-workspace terminal-workspace--paired" style={style}>
      <div className="terminal-workspace-pane terminal-workspace-pane--primary">
        {renderTerminal(primarySessionId, true)}
      </div>
      <hr
        tabIndex={0}
        className="terminal-workspace-resizer"
        aria-label="Resize terminal panes"
        aria-orientation="vertical"
        aria-valuemin={MIN_SPLIT_PERCENT}
        aria-valuemax={MAX_SPLIT_PERCENT}
        aria-valuenow={Math.round(splitPercent)}
        onPointerDown={startResize}
        onKeyDown={handleResizeKeyDown}
      />
      <div className="terminal-workspace-pane terminal-workspace-pane--secondary">
        {renderTerminal(secondarySessionId, true)}
      </div>
      {hiddenSessionIds.map((sessionId) => renderTerminal(sessionId, false))}
    </div>
  );
}
