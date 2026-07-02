import type { SpawnSpec } from "../bindings/tauri-commands";
import type { Perception } from "../core/perception";
import type { SessionId } from "../runtime/sessions";
import Terminal from "../terminal";

interface TerminalWorkspaceProps {
  readonly sessions: ReadonlyArray<SessionId>;
  readonly activeSessionId: SessionId;
  readonly cwd: string | null;
  readonly getSessionCwd: (sessionId: SessionId) => string | null | undefined;
  readonly getSpec: (sessionId: SessionId) => SpawnSpec;
  readonly perception: Perception;
  readonly shouldAttachExistingSession: (sessionId: SessionId) => boolean;
  readonly onActivate: (sessionId: SessionId) => void;
}

export default function TerminalWorkspace({
  sessions,
  activeSessionId,
  cwd,
  getSessionCwd,
  getSpec,
  perception,
  shouldAttachExistingSession,
  onActivate,
}: TerminalWorkspaceProps) {
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

  return (
    <div className="terminal-workspace">
      {sessions.map((sessionId) => renderTerminal(sessionId, sessionId === activeSessionId))}
    </div>
  );
}
