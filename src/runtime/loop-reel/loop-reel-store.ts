import type { LoopLifecycleEvent } from "@yorishiro/sdk";
import { Time } from "../../core/time";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { SessionId, SessionKind } from "../sessions/types";
import { LOOP_REEL_TUNING } from "./constants";
import type {
  LoopMarker,
  RecordedEntry,
  SessionRecording,
  SessionRecordingMeta,
  SessionRecordingOrigin,
  SessionRecordingOutcome,
  SessionRecordingStatus,
  SessionTimelineMarker,
} from "./types";

interface MutableSessionRecording {
  readonly id: string;
  readonly sessionId: SessionId;
  label: string;
  kind: SessionKind | "unknown";
  readonly origin: SessionRecordingOrigin;
  readonly startedAt: number;
  endedAt: number | null;
  status: SessionRecordingStatus;
  outcome?: SessionRecordingOutcome;
  interrupted?: boolean;
  readonly entries: RecordedEntry[];
  version: number;
}

export interface LoopReelClock {
  now(): number;
}

export interface LoopReelStoreEntryAppend {
  readonly recordingId: string;
  readonly meta: SessionRecordingMeta;
  readonly entries: readonly RecordedEntry[];
}

export interface LoopReelStoreRecordingChange {
  readonly meta: SessionRecordingMeta;
}

export interface LoopReelStoreCallbacks {
  /** 永続化層がメモリ上限による間引き前に entry を捕まえるための同期 hook。 */
  readonly onEntriesAppended?: (event: LoopReelStoreEntryAppend) => void;
  /** meta.json の create/update を記録層の mutation と同じ順序で発火させる。 */
  readonly onRecordingChanged?: (event: LoopReelStoreRecordingChange) => void;
}

export interface LoopReelStore {
  /** PTY session の recording を明示的に開始する。同 session の既存 recording は閉じる。 */
  startSession(
    sessionId: SessionId,
    metadata?: {
      readonly label?: string;
      readonly kind?: SessionKind | "unknown";
      readonly timestamp?: number;
      readonly geometry?: { readonly cols: number; readonly rows: number };
    },
  ): void;
  /** PTY session の recording を閉じる。 */
  endSession(sessionId: SessionId, timestamp?: number): void;
  /** session id 付きで PTY output を記録する。active recording が無ければ no-op。 */
  recordPty(sessionId: SessionId, text: string, timestamp?: number): void;
  /** xterm geometry の変化を replay 用に記録する。 */
  recordResize(sessionId: SessionId, cols: number, rows: number, timestamp?: number): void;
  /** resume / rewind など、session timeline 上の構造化 marker を追加する。active recording が無ければ no-op。 */
  recordMarker(
    sessionId: SessionId,
    marker: SessionTimelineMarker,
    label?: string,
    detail?: unknown,
    timestamp?: number,
  ): void;
  /** loop_announce の started/completed/failed が recording 境界を司る。routing 先が無ければ null。 */
  recordLifecycle(fallbackSessionId: SessionId, event: LoopLifecycleEvent): SessionId | null;
  /** Yorishiro の active terminal session。UI の既定選択に使う。 */
  setActiveSession(sessionId: SessionId): void;
  getActiveSession(): SessionId | null;
  /** sessionId に対応する recording が現在開いているか。 */
  hasActiveRecording(sessionId: SessionId): boolean;
  /** sessionId に対応する active recording id。存在確認だけなら hasActiveRecording を使う。 */
  getActiveRecordingId(sessionId: SessionId): string | null;
  /** 全 recording。新しいものから返す。 */
  list(): readonly SessionRecording[];
  /** entries clone なしの recording meta 一覧。新しいものから返す。 */
  listMetas(): readonly SessionRecordingMeta[];
  /** 指定 recording の phase marker。timestamp 昇順で返す。 */
  markersOf(id: string): readonly LoopMarker[];
  /** 永続化層などが記録 mutation を同期的に観察する。 */
  subscribeRecordingEvents(callbacks: LoopReelStoreCallbacks): { dispose: () => void };
  /** UI 再描画用の購読。 */
  subscribe(listener: () => void): { dispose: () => void };
}

interface LoopReelStoreOptions {
  readonly maxEntriesPerRecording?: number;
  readonly maxRecordings?: number;
  readonly warn?: (message: string, meta?: Record<string, unknown>) => void;
  readonly time?: LoopReelClock | Time;
  readonly callbacks?: LoopReelStoreCallbacks;
}

const DEFAULT_MAX_ENTRIES_PER_RECORDING = 5000;
const DEFAULT_MAX_RECORDINGS = 200;
const SYSTEM_CLOCK: LoopReelClock = new Time();

class LoopReelStoreImpl implements LoopReelStore {
  private readonly recordings: MutableSessionRecording[] = [];
  private readonly activeBySessionId = new Map<SessionId, MutableSessionRecording>();
  private readonly snapshotCache = new Map<
    string,
    { readonly version: number; readonly snapshot: SessionRecording }
  >();
  private readonly metaCache = new Map<
    string,
    { readonly version: number; readonly snapshot: SessionRecordingMeta }
  >();
  private readonly listeners = new Set<() => void>();
  private readonly warnedRecordingIds = new Set<string>();
  private readonly maxEntriesPerRecording: number;
  private readonly maxRecordings: number;
  private readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  private readonly time: LoopReelClock;
  private readonly callbacks: LoopReelStoreCallbacks;
  private readonly recordingEventSubscribers = new Set<LoopReelStoreCallbacks>();
  private readonly lastInterventionBySessionId = new Map<SessionId, number>();
  private activeSessionId: SessionId | null = null;
  private warnedRecordingEviction = false;
  private ptyEmitScheduled = false;
  private nextSequence = 0;

  constructor(options: LoopReelStoreOptions = {}) {
    this.maxEntriesPerRecording =
      options.maxEntriesPerRecording ?? DEFAULT_MAX_ENTRIES_PER_RECORDING;
    this.maxRecordings = normalizePositiveInteger(options.maxRecordings, DEFAULT_MAX_RECORDINGS);
    this.warn =
      options.warn ??
      ((message, meta) => {
        console.warn(message, meta);
      });
    this.time = options.time ?? SYSTEM_CLOCK;
    this.callbacks = options.callbacks ?? {};
  }

  startSession(
    sessionId: SessionId,
    metadata: {
      readonly label?: string;
      readonly kind?: SessionKind | "unknown";
      readonly timestamp?: number;
      readonly geometry?: { readonly cols: number; readonly rows: number };
    } = {},
  ): void {
    const timestamp = metadata.timestamp ?? this.time.now();
    this.endSession(sessionId, timestamp);

    const recording = this.createRecording(sessionId, timestamp, "manual", metadata);
    this.evictRecordingsIfNeeded();
    this.notifyRecordingChanged(recording);
    this.emit();
  }

  endSession(sessionId: SessionId, timestamp: number = this.time.now()): void {
    const recording = this.activeBySessionId.get(sessionId);
    if (!recording) return;
    recording.status = "ended";
    recording.endedAt = Math.max(timestamp, recording.startedAt);
    const endedMarker: RecordedEntry = {
      kind: "marker",
      marker: "session-ended",
      label: "Session ended",
      timestamp: recording.endedAt,
    };
    this.appendEntries(recording, [endedMarker], { emitPtySoon: false });
    this.activeBySessionId.delete(sessionId);
    this.lastInterventionBySessionId.delete(sessionId);
    this.evictRecordingsIfNeeded();
    this.notifyRecordingChanged(recording);
    this.emit();
  }

  recordPty(sessionId: SessionId, text: string, timestamp: number = this.time.now()): void {
    const recording = this.activeBySessionId.get(sessionId);
    if (!recording) return;
    this.appendEntries(recording, [{ kind: "pty", text, timestamp }], { emitPtySoon: true });
  }

  recordResize(
    sessionId: SessionId,
    cols: number,
    rows: number,
    timestamp: number = this.time.now(),
  ): void {
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return;
    const safeCols = Math.max(2, Math.floor(cols));
    const safeRows = Math.max(1, Math.floor(rows));
    const recording = this.activeBySessionId.get(sessionId);
    if (!recording) return;
    const previousResize = lastResizeEntry(recording.entries);
    if (previousResize?.cols === safeCols && previousResize.rows === safeRows) return;
    this.appendEntries(recording, [{ kind: "resize", cols: safeCols, rows: safeRows, timestamp }], {
      emitPtySoon: false,
    });
    this.emit();
  }

  recordMarker(
    sessionId: SessionId,
    marker: SessionTimelineMarker,
    label = defaultMarkerLabel(marker),
    detail?: unknown,
    timestamp: number = this.time.now(),
  ): void {
    const recording = this.activeBySessionId.get(sessionId);
    if (!recording) return;
    if (this.shouldThrottleInterventionMarker(sessionId, marker, timestamp)) return;
    this.appendEntries(recording, [{ kind: "marker", marker, label, detail, timestamp }], {
      emitPtySoon: false,
    });
    if (marker === "intervention") {
      this.lastInterventionBySessionId.set(sessionId, timestamp);
    }
    this.emit();
  }

  recordLifecycle(fallbackSessionId: SessionId, event: LoopLifecycleEvent): SessionId | null {
    const sessionId = this.routeLifecycleSession(fallbackSessionId, event);
    const metadata = {
      label: event.agent ?? sessionId,
      kind: event.agent === null ? ("unknown" as const) : ("agent" as const),
    };

    if (event.phase === "started") {
      const existing = this.activeBySessionId.get(sessionId);
      const recording =
        existing ?? this.createRecording(sessionId, event.timestamp, "lifecycle", metadata);
      this.updateRecordingMetadata(recording, metadata);
      if (recording.entries.some((entry) => entry.kind === "phase" && entry.phase === "started")) {
        return sessionId;
      }
      this.appendEntries(recording, [phaseEntry(event)], { emitPtySoon: false });
      this.evictRecordingsIfNeeded();
      this.notifyRecordingChanged(recording);
      this.emit();
      return sessionId;
    }

    const recording = this.activeBySessionId.get(sessionId);
    if (!recording) return null;
    this.updateRecordingMetadata(recording, metadata);
    this.appendEntries(recording, [phaseEntry(event)], { emitPtySoon: false });
    if (event.phase === "completed" || event.phase === "failed") {
      recording.outcome = event.phase;
      this.bumpRecording(recording);
      this.endSession(sessionId, event.timestamp);
      return sessionId;
    }
    this.notifyRecordingChanged(recording);
    this.emit();
    return sessionId;
  }

  setActiveSession(sessionId: SessionId): void {
    if (this.activeSessionId === sessionId) return;
    this.activeSessionId = sessionId;
    this.emit();
  }

  getActiveSession(): SessionId | null {
    return this.activeSessionId;
  }

  hasActiveRecording(sessionId: SessionId): boolean {
    return this.activeBySessionId.has(sessionId);
  }

  getActiveRecordingId(sessionId: SessionId): string | null {
    return this.activeBySessionId.get(sessionId)?.id ?? null;
  }

  list(): readonly SessionRecording[] {
    return this.recordings.map((recording) => this.snapshotOf(recording));
  }

  listMetas(): readonly SessionRecordingMeta[] {
    return this.recordings.map((recording) => this.metaOf(recording));
  }

  markersOf(id: string): readonly LoopMarker[] {
    const recording = this.recordings.find((candidate) => candidate.id === id);
    if (!recording) return [];
    return recording.entries
      .filter((entry): entry is Extract<RecordedEntry, { kind: "phase" }> => entry.kind === "phase")
      .map((entry) => ({
        phase: entry.phase,
        timestamp: entry.timestamp,
        detail: entry.detail,
      }))
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  subscribe(listener: () => void): { dispose: () => void } {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  subscribeRecordingEvents(callbacks: LoopReelStoreCallbacks): { dispose: () => void } {
    this.recordingEventSubscribers.add(callbacks);
    return {
      dispose: () => {
        this.recordingEventSubscribers.delete(callbacks);
      },
    };
  }

  private createRecording(
    sessionId: SessionId,
    timestamp: number,
    origin: SessionRecordingOrigin,
    metadata: {
      readonly label?: string;
      readonly kind?: SessionKind | "unknown";
      readonly geometry?: { readonly cols: number; readonly rows: number };
    } = {},
  ): MutableSessionRecording {
    const recording: MutableSessionRecording = {
      id: this.createRecordingId(sessionId, timestamp),
      sessionId,
      label: metadata.label ?? sessionId,
      kind: metadata.kind ?? "unknown",
      origin,
      startedAt: timestamp,
      endedAt: null,
      status: "recording",
      entries: [],
      version: 0,
    };
    const initialEntries: RecordedEntry[] = [
      {
        kind: "marker",
        marker: "session-start",
        label: metadata.label ?? sessionId,
        timestamp,
      },
    ];
    if (isValidGeometry(metadata.geometry)) {
      initialEntries.push({
        kind: "resize",
        cols: metadata.geometry.cols,
        rows: metadata.geometry.rows,
        timestamp,
      });
    }
    this.recordings.unshift(recording);
    this.activeBySessionId.set(sessionId, recording);
    this.lastInterventionBySessionId.delete(sessionId);
    this.appendEntries(recording, initialEntries, { emitPtySoon: false });
    return recording;
  }

  private shouldThrottleInterventionMarker(
    sessionId: SessionId,
    marker: SessionTimelineMarker,
    timestamp: number,
  ): boolean {
    if (marker !== "intervention") return false;
    const previousTimestamp = this.lastInterventionBySessionId.get(sessionId);
    return (
      previousTimestamp !== undefined &&
      timestamp - previousTimestamp < LOOP_REEL_TUNING.interventionMarkerThrottleMs
    );
  }

  private updateRecordingMetadata(
    recording: MutableSessionRecording,
    metadata: { readonly label?: string; readonly kind?: SessionKind | "unknown" },
  ): void {
    let changed = false;
    if (metadata.label && recording.label !== metadata.label) {
      recording.label = metadata.label;
      changed = true;
    }
    if (metadata.kind && recording.kind !== metadata.kind) {
      recording.kind = metadata.kind;
      changed = true;
    }
    if (!changed) return;
    this.bumpRecording(recording);
  }

  private appendEntries(
    recording: MutableSessionRecording,
    entries: readonly RecordedEntry[],
    options: { readonly emitPtySoon: boolean },
  ): void {
    recording.entries.push(...entries);
    this.bumpRecording(recording);
    this.notifyEntriesAppended(recording, entries);
    this.trimRecording(recording);
    if (options.emitPtySoon) {
      this.emitPtySoon();
    }
  }

  private bumpRecording(recording: MutableSessionRecording): void {
    recording.version += 1;
  }

  private snapshotOf(recording: MutableSessionRecording): SessionRecording {
    const cached = this.snapshotCache.get(recording.id);
    if (cached?.version === recording.version) return cached.snapshot;

    const snapshot = cloneRecording(recording);
    this.snapshotCache.set(recording.id, { version: recording.version, snapshot });
    return snapshot;
  }

  private metaOf(recording: MutableSessionRecording): SessionRecordingMeta {
    const cached = this.metaCache.get(recording.id);
    if (cached?.version === recording.version) return cached.snapshot;

    const snapshot = cloneMeta(recording);
    this.metaCache.set(recording.id, { version: recording.version, snapshot });
    return snapshot;
  }

  private notifyEntriesAppended(
    recording: MutableSessionRecording,
    entries: readonly RecordedEntry[],
  ): void {
    const clonedEntries = entries.map(cloneEntry);
    const meta = this.metaOf(recording);
    this.callbacks.onEntriesAppended?.({
      recordingId: recording.id,
      meta,
      entries: clonedEntries,
    });
    for (const callbacks of this.recordingEventSubscribers) {
      callbacks.onEntriesAppended?.({
        recordingId: recording.id,
        meta,
        entries: clonedEntries,
      });
    }
  }

  private notifyRecordingChanged(recording: MutableSessionRecording): void {
    this.callbacks.onRecordingChanged?.({ meta: this.metaOf(recording) });
    for (const callbacks of this.recordingEventSubscribers) {
      callbacks.onRecordingChanged?.({ meta: this.metaOf(recording) });
    }
  }

  private routeLifecycleSession(
    fallbackSessionId: SessionId,
    event: LoopLifecycleEvent,
  ): SessionId {
    if (event.phase === "started") return fallbackSessionId;
    const lifecycleRecordings = Array.from(this.activeBySessionId.values()).filter(
      (recording) => recording.origin === "lifecycle",
    );
    return lifecycleRecordings.length === 1 ? lifecycleRecordings[0].sessionId : fallbackSessionId;
  }

  private evictRecordingsIfNeeded(): void {
    while (this.recordings.length > this.maxRecordings) {
      const index = findOldestEndedRecordingIndex(this.recordings);
      if (index === -1) return;

      const [evicted] = this.recordings.splice(index, 1);
      this.snapshotCache.delete(evicted.id);
      this.metaCache.delete(evicted.id);
      this.warnedRecordingIds.delete(evicted.id);

      if (this.warnedRecordingEviction) continue;
      this.warnedRecordingEviction = true;
      this.warn("LoopReelStore: recording cap reached; old ended recordings were dropped", {
        recordingId: evicted.id,
        maxRecordings: this.maxRecordings,
      });
    }
  }

  private trimRecording(recording: MutableSessionRecording): void {
    let trimmed = false;
    const trimTarget =
      this.maxEntriesPerRecording > 100
        ? Math.floor(this.maxEntriesPerRecording * 0.9)
        : this.maxEntriesPerRecording;
    let entriesToDrop = recording.entries.length - trimTarget;
    while (entriesToDrop > 0) {
      const index = recording.entries.findIndex((entry) => entry.kind === "pty");
      if (index === -1) break;
      recording.entries.splice(index, 1);
      entriesToDrop -= 1;
      trimmed = true;
    }

    if (!trimmed) return;
    this.bumpRecording(recording);
    if (this.warnedRecordingIds.has(recording.id)) return;
    this.warnedRecordingIds.add(recording.id);
    this.warn("LoopReelStore: recording entry cap reached; old PTY entries were dropped", {
      recordingId: recording.id,
      maxEntriesPerRecording: this.maxEntriesPerRecording,
    });
  }

  private createRecordingId(sessionId: SessionId, timestamp: number): string {
    this.nextSequence += 1;
    return `session-${sanitizeIdPart(sessionId)}-${timestamp}-${this.nextSequence}`;
  }

  private emit(): void {
    this.ptyEmitScheduled = false;
    for (const listener of Array.from(this.listeners)) {
      listener();
    }
  }

  private emitPtySoon(): void {
    if (this.ptyEmitScheduled) return;
    this.ptyEmitScheduled = true;
    const flush = (): void => {
      if (!this.ptyEmitScheduled) return;
      this.emit();
    };
    if (typeof globalThis.requestAnimationFrame === "function") {
      globalThis.requestAnimationFrame(flush);
    } else {
      globalThis.setTimeout(flush, 0);
    }
  }
}

const phaseEntry = (event: LoopLifecycleEvent): RecordedEntry => ({
  kind: "phase",
  phase: event.phase,
  agent: event.agent,
  detail: event.detail,
  timestamp: event.timestamp,
});

const sanitizeIdPart = (value: string): string =>
  value.replace(/[^0-9A-Za-z-]+/g, "-") || "session";

const normalizePositiveInteger = (value: number | undefined, fallback: number): number =>
  Number.isFinite(value) && value !== undefined && value > 0 ? Math.floor(value) : fallback;

const isValidGeometry = (
  value: { readonly cols: number; readonly rows: number } | undefined,
): value is { readonly cols: number; readonly rows: number } =>
  value !== undefined &&
  Number.isFinite(value.cols) &&
  Number.isFinite(value.rows) &&
  value.cols >= 2 &&
  value.rows >= 1;

const findOldestEndedRecordingIndex = (recordings: readonly MutableSessionRecording[]): number => {
  for (let index = recordings.length - 1; index >= 0; index -= 1) {
    if (recordings[index].status === "ended") return index;
  }
  return -1;
};

const lastResizeEntry = (
  entries: readonly RecordedEntry[],
): Extract<RecordedEntry, { kind: "resize" }> | null => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.kind === "resize") return entry;
  }
  return null;
};

const defaultMarkerLabel = (marker: SessionTimelineMarker): string => {
  switch (marker) {
    case "session-start":
      return "Session started";
    case "session-resume":
      return "Session resumed";
    case "session-rewind":
      return "Session rewind";
    case "session-ended":
      return "Session ended";
    case "intervention":
      return "User intervention";
    case "command-failed":
      return "Command failed";
  }
};

const cloneEntry = (entry: RecordedEntry): RecordedEntry => ({ ...entry });

const cloneMeta = (recording: MutableSessionRecording): SessionRecordingMeta => ({
  id: recording.id,
  sessionId: recording.sessionId,
  label: recording.label,
  kind: recording.kind,
  origin: recording.origin,
  startedAt: recording.startedAt,
  endedAt: recording.endedAt,
  status: recording.status,
  outcome: recording.outcome,
  interrupted: recording.interrupted,
});

const cloneRecording = (recording: MutableSessionRecording): SessionRecording => ({
  ...cloneMeta(recording),
  entries: recording.entries.map(cloneEntry),
});

export function createLoopReelStore(options?: LoopReelStoreOptions): LoopReelStore {
  return new LoopReelStoreImpl(options);
}

/** hot-data singleton。HMR をまたいで Loop Reel の in-memory 記録を保持する。 */
export function getLoopReelStore(): LoopReelStore {
  return getOrInit(KEYS.LOOP_REEL_STORE, () => createLoopReelStore());
}
