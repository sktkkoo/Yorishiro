import type { LoopPhase } from "@yorishiro/sdk";
import type { IterationClip } from "./iteration-clips";
import { type LoopReelPersistedMeta, metaFromRecording } from "./persistence";
import type { RecordedEntry, SessionRecording, SessionRecordingMeta } from "./types";

export interface LoopReelTimeRange {
  readonly fromTs: number;
  readonly toTs: number;
}

export interface LoopReelPhaseMarker {
  readonly phase: LoopPhase;
  readonly timestamp: number;
}

export function mergeLoopReelMetas(
  persisted: readonly LoopReelPersistedMeta[],
  memoryMetas: readonly SessionRecordingMeta[],
): readonly LoopReelPersistedMeta[] {
  const byId = new Map<string, LoopReelPersistedMeta>();
  for (const meta of persisted) byId.set(meta.id, meta);
  for (const meta of memoryMetas) byId.set(meta.id, metaFromRecording(meta));
  return Array.from(byId.values()).sort(
    (a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id),
  );
}

export const endedLoopReelMetas = (
  metas: readonly LoopReelPersistedMeta[],
): readonly LoopReelPersistedMeta[] =>
  metas
    .filter((meta) => meta.status === "ended")
    .sort((a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id));

export function recordingTimeRange(recording: SessionRecording): LoopReelTimeRange {
  const lastTimestamp = recording.entries.reduce(
    (max, entry) => Math.max(max, entry.timestamp),
    recording.startedAt,
  );
  const toTs = Math.max(recording.startedAt + 1, recording.endedAt ?? lastTimestamp);
  return { fromTs: recording.startedAt, toTs };
}

export const phaseMarkersOfRecording = (
  recording: SessionRecording,
): readonly LoopReelPhaseMarker[] =>
  recording.entries
    .filter((entry): entry is Extract<RecordedEntry, { kind: "phase" }> => entry.kind === "phase")
    .map((entry) => ({ phase: entry.phase, timestamp: entry.timestamp }))
    .sort((a, b) => a.timestamp - b.timestamp);

export function previousClipTimestamp(
  clips: readonly IterationClip[],
  timestamp: number,
): number | null {
  for (let index = clips.length - 1; index >= 0; index -= 1) {
    const fromTs = clips[index].fromTs;
    if (fromTs < timestamp) return fromTs;
  }
  return null;
}

export function nextClipTimestamp(
  clips: readonly IterationClip[],
  timestamp: number,
): number | null {
  for (const clip of clips) {
    if (clip.fromTs > timestamp) return clip.fromTs;
  }
  return null;
}

export function nextFailedTimestamp(recording: SessionRecording, timestamp: number): number | null {
  const failed = recording.entries
    .filter(
      (entry): entry is Extract<RecordedEntry, { kind: "phase" }> =>
        entry.kind === "phase" && entry.phase === "failed" && entry.timestamp > timestamp,
    )
    .sort((a, b) => a.timestamp - b.timestamp);
  return failed[0]?.timestamp ?? null;
}

export function clampTimestamp(timestamp: number, range: LoopReelTimeRange): number {
  if (!Number.isFinite(timestamp)) return range.fromTs;
  return Math.min(range.toTs, Math.max(range.fromTs, timestamp));
}
