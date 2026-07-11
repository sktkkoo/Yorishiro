import type { RecordedEntry, SessionRecording } from "./types";

export type ReplayStreamEntry = Extract<RecordedEntry, { kind: "pty" | "resize" }>;

export interface ReplayFrame {
  readonly entry: ReplayStreamEntry;
  readonly timestamp: number;
  readonly dueMs: number;
}

export interface ReplayTimelineOptions {
  /** 記録上の空白時間を replay 上で何 ms まで保持するか。 */
  readonly maxGapMs?: number;
}

const DEFAULT_MAX_GAP_MS = 1800;

const isReplayStreamEntry = (entry: RecordedEntry): entry is ReplayStreamEntry =>
  entry.kind === "pty" || entry.kind === "resize";

const sortedStreamEntries = (recording: SessionRecording): readonly ReplayStreamEntry[] =>
  recording.entries
    .map((entry, index) => ({ entry, index }))
    .filter((item): item is { readonly entry: ReplayStreamEntry; readonly index: number } =>
      isReplayStreamEntry(item.entry),
    )
    .sort((a, b) => a.entry.timestamp - b.entry.timestamp || a.index - b.index)
    .map((item) => item.entry);

/**
 * SessionRecording から replay terminal に適用する stream frame を作る。
 * PTY bytes と resize だけを対象にし、phase/marker は UI 側の章立てで扱う。
 */
export function buildReplayTimeline(
  recording: SessionRecording,
  options: ReplayTimelineOptions = {},
): readonly ReplayFrame[] {
  const maxGapMs = normalizeMaxGap(options.maxGapMs);
  const streamEntries = sortedStreamEntries(recording);

  let previousTimestamp = recording.startedAt;
  let dueMs = 0;
  return streamEntries.map((entry) => {
    const gap = Math.max(0, entry.timestamp - previousTimestamp);
    dueMs += Math.min(gap, maxGapMs);
    previousTimestamp = entry.timestamp;
    return { entry, timestamp: entry.timestamp, dueMs };
  });
}

export function replayDurationMs(frames: readonly ReplayFrame[]): number {
  return frames[frames.length - 1]?.dueMs ?? 0;
}

const normalizeMaxGap = (value: number | undefined): number => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return DEFAULT_MAX_GAP_MS;
  return Math.floor(value);
};
