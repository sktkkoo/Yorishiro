/**
 * Pomodoro Timer ambient-ui — 画面右下に残り時間と操作ボタンを表示する。
 *
 * user が直接ポモドーロを操作する経路。MCP tool（住人用）と対称。
 * AmbientUiContext の public amenity service から state / command を使う。
 */

import type {
  AmbientUiContext,
  AmbientUiPackDefinition,
  AmenityServicesAPI,
  Disposable,
} from "@yorishiro/sdk";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";

// ─── Types ───────────────────────────────────────────────

type Phase = "idle" | "work" | "short-break" | "long-break";

interface PomodoroStatus {
  phase: Phase;
  round: number;
  totalRounds: number;
  remainingMs: number;
}

const IDLE_STATUS: PomodoroStatus = {
  phase: "idle",
  round: 0,
  totalRounds: 0,
  remainingMs: 0,
};

// ─── Helpers ─────────────────────────────────────────────

function formatTime(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${String(min).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function phaseLabel(phase: Phase): string {
  switch (phase) {
    case "work":
      return "WORK";
    case "short-break":
      return "BREAK";
    case "long-break":
      return "LONG BREAK";
    default:
      return "";
  }
}

function phaseColor(phase: Phase): string {
  switch (phase) {
    case "work":
      return "#4ade80";
    case "short-break":
      return "#60a5fa";
    case "long-break":
      return "#a78bfa";
    default:
      return "#888";
  }
}

function parseStatus(value: unknown): PomodoroStatus | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.phase !== "idle" &&
    candidate.phase !== "work" &&
    candidate.phase !== "short-break" &&
    candidate.phase !== "long-break"
  ) {
    return null;
  }
  if (
    typeof candidate.round !== "number" ||
    typeof candidate.totalRounds !== "number" ||
    typeof candidate.remainingMs !== "number"
  ) {
    return null;
  }
  return {
    phase: candidate.phase,
    round: candidate.round,
    totalRounds: candidate.totalRounds,
    remainingMs: candidate.remainingMs,
  };
}

// ─── Component ───────────────────────────────────────────

export function PomodoroUi({
  amenities,
}: {
  amenities: AmenityServicesAPI;
}): React.JSX.Element | null {
  const [status, setStatus] = useState<PomodoroStatus>(IDLE_STATUS);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    const service = amenities.get("pomodoro");
    if (service === null) {
      setStatus(IDLE_STATUS);
      return;
    }
    try {
      const result = parseStatus(await service.getState());
      if (result !== null) setStatus(result);
    } catch {
      /* ignore */
    }
  }, [amenities]);

  useEffect(() => {
    poll();
    pollRef.current = setInterval(poll, 1000);
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [poll]);

  const handleStop = useCallback(async () => {
    const service = amenities.get("pomodoro");
    if (service === null) return;
    await service.execute("stop");
    setStatus(IDLE_STATUS);
  }, [amenities]);

  if (status.phase === "idle") return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: 12,
        right: 12,
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 12px",
        borderRadius: 8,
        background: "rgba(0, 0, 0, 0.6)",
        backdropFilter: "blur(8px)",
        color: "#fff",
        fontSize: 13,
        fontFamily: "monospace",
        pointerEvents: "auto",
        cursor: "default",
        userSelect: "none",
        zIndex: 9999,
      }}
    >
      <span
        style={{
          display: "inline-block",
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: phaseColor(status.phase),
          flexShrink: 0,
        }}
      />
      <span style={{ color: phaseColor(status.phase), fontWeight: 600, fontSize: 11 }}>
        {phaseLabel(status.phase)}
      </span>
      <span style={{ fontVariantNumeric: "tabular-nums" }}>{formatTime(status.remainingMs)}</span>
      <span style={{ color: "#888", fontSize: 11 }}>
        {status.round}/{status.totalRounds}
      </span>
      <button
        type="button"
        onClick={handleStop}
        style={{
          background: "none",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: 4,
          color: "#ff6b6b",
          fontSize: 11,
          padding: "2px 6px",
          cursor: "pointer",
          lineHeight: 1,
        }}
      >
        Stop
      </button>
    </div>
  );
}

// ─── Pack definition ─────────────────────────────────────

const pomodoroUiPack = {
  type: "ambient-ui",
  id: "pomodoro-ui",
  mount: (ctx: AmbientUiContext, container: HTMLDivElement): Disposable => {
    const root = ReactDOM.createRoot(container);
    root.render(<PomodoroUi amenities={ctx.amenities} />);
    return {
      dispose: () => queueMicrotask(() => root.unmount()),
    };
  },
} satisfies AmbientUiPackDefinition;

export default pomodoroUiPack;
