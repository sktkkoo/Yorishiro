import type { LoopPhase } from "@yorishiro/sdk";
import type { RecordedEntry, SessionRecording } from "./types";

export interface IterationClipMarker {
  readonly phase: Exclude<LoopPhase, "started" | "iterating">;
  readonly timestamp: number;
  readonly detail?: unknown;
}

export interface IterationClip {
  readonly index: number;
  readonly fromTs: number;
  readonly toTs: number;
  readonly endPhase?: LoopPhase;
  readonly markers: readonly IterationClipMarker[];
}

type PhaseEntry = Extract<RecordedEntry, { kind: "phase" }>;
type BoundaryPhaseEntry = PhaseEntry & { readonly phase: "started" | "iterating" };

const isBoundary = (entry: PhaseEntry): entry is BoundaryPhaseEntry =>
  entry.phase === "started" || entry.phase === "iterating";

const isMarkerPhase = (
  entry: PhaseEntry,
): entry is PhaseEntry & { readonly phase: IterationClipMarker["phase"] } =>
  entry.phase !== "started" && entry.phase !== "iterating";

/**
 * loop lifecycle の phase entry から iteration 単位の clip 境界を導出する。
 *
 * phase entry が無い手動録画では clip を捏造せず、空配列を返す。
 */
export function buildIterationClips(recording: SessionRecording): readonly IterationClip[] {
  const phases = recording.entries
    .filter((entry): entry is PhaseEntry => entry.kind === "phase")
    .sort((a, b) => a.timestamp - b.timestamp);
  const boundaries = phases.filter(isBoundary);
  if (boundaries.length === 0) return [];

  const fallbackEnd = recording.endedAt ?? lastEntryTimestamp(recording) ?? recording.startedAt;
  return boundaries.map((boundary, index) => {
    const nextBoundary = boundaries[index + 1] ?? null;
    const finalPhase = nextBoundary ?? lastPhaseInRange(phases, boundary.timestamp, fallbackEnd);
    const toTs = nextBoundary?.timestamp ?? finalPhase?.timestamp ?? fallbackEnd;
    const isFinalClip = nextBoundary === null;
    const markers = phases
      .filter(
        (entry): entry is PhaseEntry & { readonly phase: IterationClipMarker["phase"] } =>
          isMarkerPhase(entry) &&
          entry.timestamp >= boundary.timestamp &&
          (isFinalClip ? entry.timestamp <= toTs : entry.timestamp < toTs),
      )
      .map((entry) => ({
        phase: entry.phase,
        timestamp: entry.timestamp,
        detail: entry.detail,
      }));

    return {
      index,
      fromTs: boundary.timestamp,
      toTs: Math.max(boundary.timestamp, toTs),
      endPhase: finalPhase?.phase,
      markers,
    };
  });
}

const lastPhaseInRange = (
  phases: readonly PhaseEntry[],
  fromTs: number,
  toTs: number,
): PhaseEntry | null => {
  for (let index = phases.length - 1; index >= 0; index -= 1) {
    const phase = phases[index];
    if (phase.timestamp < fromTs || phase.timestamp > toTs) continue;
    return phase;
  }
  return null;
};

const lastEntryTimestamp = (recording: SessionRecording): number | null => {
  let timestamp: number | null = null;
  for (const entry of recording.entries) {
    timestamp = timestamp === null ? entry.timestamp : Math.max(timestamp, entry.timestamp);
  }
  return timestamp;
};
