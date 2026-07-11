import type { LoopPhase } from "@yorishiro/sdk";
import type { SessionId, SessionKind } from "../sessions/types";

export type SessionTimelineMarker =
  | "session-start"
  | "session-resume"
  | "session-rewind"
  | "session-ended"
  | "intervention"
  | "command-failed";

/** 記録された観察 entry。timestamp は host 側で stamp された時刻を使う。 */
export type RecordedEntry =
  | { readonly kind: "pty"; readonly text: string; readonly timestamp: number }
  | {
      readonly kind: "marker";
      readonly marker: SessionTimelineMarker;
      readonly label: string;
      readonly detail?: unknown;
      readonly timestamp: number;
    }
  | {
      readonly kind: "resize";
      readonly cols: number;
      readonly rows: number;
      readonly timestamp: number;
    }
  | {
      readonly kind: "phase";
      readonly phase: LoopPhase;
      readonly agent: string | null;
      readonly detail?: unknown;
      readonly timestamp: number;
    };

export type SessionRecordingStatus = "recording" | "ended";
export type SessionRecordingOutcome = "completed" | "failed";
export type SessionRecordingOrigin = "lifecycle" | "manual";

export interface SessionRecordingMeta {
  readonly id: string;
  readonly sessionId: SessionId;
  readonly label: string;
  readonly kind: SessionKind | "unknown";
  readonly origin: SessionRecordingOrigin;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly status: SessionRecordingStatus;
  readonly outcome?: SessionRecordingOutcome;
  readonly interrupted?: boolean;
}

export interface SessionRecording extends SessionRecordingMeta {
  readonly entries: readonly RecordedEntry[];
}

/** marker は phase entry から導出する。 */
export interface LoopMarker {
  readonly phase: LoopPhase;
  readonly timestamp: number;
  readonly detail?: unknown;
}
