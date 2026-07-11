import {
  encodeLoopReelEntriesJsonl,
  type LoopReelPersistedMeta,
  loopReelAppendEntries,
  loopReelCreate,
  loopReelDelete,
  loopReelList,
  loopReelLoadEntries,
  loopReelUpdateMeta,
} from "../../bindings/tauri-commands";
import { Time } from "../../core/time";
import type { LoopReelClock, LoopReelStore } from "./loop-reel-store";
import type { RecordedEntry, SessionRecording, SessionRecordingMeta } from "./types";

export type { LoopReelPersistedMeta } from "../../bindings/tauri-commands";

export interface LoopReelPersistenceBackend {
  create(meta: LoopReelPersistedMeta): Promise<void>;
  updateMeta(id: string, meta: LoopReelPersistedMeta): Promise<void>;
  appendEntries(id: string, jsonl: string): Promise<void>;
  list(): Promise<readonly LoopReelPersistedMeta[]>;
  loadEntries(id: string): Promise<string>;
  delete(id: string): Promise<void>;
}

export interface LoopReelPersistenceOptions {
  readonly flushIntervalMs?: number;
  readonly flushEntryCount?: number;
  readonly maxPersistedRecordings?: number;
  readonly backend?: LoopReelPersistenceBackend;
  readonly time?: LoopReelClock;
  readonly warn?: (message: string, meta?: Record<string, unknown>) => void;
}

export interface LoopReelPersistenceController {
  initialize(): Promise<void>;
  flushAll(): Promise<void>;
  flushRecording(id: string): Promise<void>;
  listRecordings(): Promise<readonly LoopReelPersistedMeta[]>;
  loadRecording(id: string): Promise<SessionRecording | null>;
  dispose(): void;
}

const DEFAULT_FLUSH_INTERVAL_MS = 1000;
const DEFAULT_FLUSH_ENTRY_COUNT = 64;
const DEFAULT_MAX_PERSISTED_RECORDINGS = 100;
const SYSTEM_CLOCK: LoopReelClock = new Time();

export const TAURI_LOOP_REEL_BACKEND: LoopReelPersistenceBackend = {
  create: (meta) => loopReelCreate({ meta }),
  updateMeta: (id, meta) => loopReelUpdateMeta({ id, meta }),
  appendEntries: (id, jsonl) => loopReelAppendEntries({ id, jsonl }),
  list: () => loopReelList(),
  loadEntries: (id) => loopReelLoadEntries({ id }),
  delete: (id) => loopReelDelete({ id }),
};

export const metaFromRecording = (meta: SessionRecordingMeta): LoopReelPersistedMeta => ({
  id: meta.id,
  sessionId: meta.sessionId,
  label: meta.label,
  kind: meta.kind,
  origin: meta.origin,
  startedAt: meta.startedAt,
  endedAt: meta.endedAt,
  status: meta.status,
  outcome: meta.outcome,
  interrupted: meta.interrupted,
});

export const parseEntriesJsonl = (jsonl: string): RecordedEntry[] =>
  jsonl
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as RecordedEntry);

export class LoopReelPersistence implements LoopReelPersistenceController {
  private readonly store: LoopReelStore;
  private readonly backend: LoopReelPersistenceBackend;
  private readonly flushIntervalMs: number;
  private readonly flushEntryCount: number;
  private readonly maxPersistedRecordings: number;
  private readonly time: LoopReelClock;
  private readonly warn: (message: string, meta?: Record<string, unknown>) => void;
  private readonly pendingEntries = new Map<string, RecordedEntry[]>();
  private readonly appendChains = new Map<string, Promise<void>>();
  private readonly knownMetaIds = new Set<string>();
  private readonly metas = new Map<string, LoopReelPersistedMeta>();
  private readonly subscription: { dispose: () => void };
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(store: LoopReelStore, options: LoopReelPersistenceOptions = {}) {
    this.store = store;
    this.backend = options.backend ?? TAURI_LOOP_REEL_BACKEND;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
    this.flushEntryCount = options.flushEntryCount ?? DEFAULT_FLUSH_ENTRY_COUNT;
    this.maxPersistedRecordings =
      options.maxPersistedRecordings ?? DEFAULT_MAX_PERSISTED_RECORDINGS;
    this.time = options.time ?? SYSTEM_CLOCK;
    this.warn =
      options.warn ??
      ((message, meta) => {
        console.warn(message, meta);
      });
    this.subscription = this.store.subscribeRecordingEvents({
      onEntriesAppended: (event) => {
        this.handleEntries(event.meta, event.entries);
      },
      onRecordingChanged: (event) => {
        this.handleRecordingChanged(event.meta);
      },
    });
  }

  async initialize(): Promise<void> {
    const metas = await this.backend.list();
    for (const meta of metas) {
      this.knownMetaIds.add(meta.id);
      this.metas.set(meta.id, meta);
      if (meta.status !== "recording") continue;
      const repaired: LoopReelPersistedMeta = {
        ...meta,
        status: "ended",
        endedAt: Math.max(meta.startedAt, this.time.now()),
        interrupted: true,
      };
      await this.backend.updateMeta(meta.id, repaired);
      this.metas.set(meta.id, repaired);
    }
    await this.rotatePersistedRecordings();
  }

  async flushAll(): Promise<void> {
    this.clearFlushTimer();
    const ids = Array.from(new Set([...this.pendingEntries.keys(), ...this.appendChains.keys()]));
    for (const id of ids) {
      await this.flushRecording(id);
    }
  }

  async flushRecording(id: string): Promise<void> {
    const entries = this.pendingEntries.get(id);
    if (!entries || entries.length === 0) {
      await (this.appendChains.get(id) ?? Promise.resolve());
      return;
    }
    this.pendingEntries.delete(id);
    await this.enqueueAppend(id, entries);
  }

  async listRecordings(): Promise<readonly LoopReelPersistedMeta[]> {
    const metas = await this.backend.list();
    for (const meta of metas) {
      this.knownMetaIds.add(meta.id);
      this.metas.set(meta.id, meta);
    }
    return metas;
  }

  async loadRecording(id: string): Promise<SessionRecording | null> {
    const meta = this.metas.get(id) ?? (await this.findMeta(id));
    if (!meta) return null;
    const entries = parseEntriesJsonl(await this.backend.loadEntries(id));
    return { ...meta, entries };
  }

  dispose(): void {
    this.disposed = true;
    this.clearFlushTimer();
    this.subscription.dispose();
  }

  private handleEntries(meta: SessionRecordingMeta, entries: readonly RecordedEntry[]): void {
    void this.ensureMetaCreated(metaFromRecording(meta));
    const pending = this.pendingEntries.get(meta.id) ?? [];
    pending.push(...entries);
    this.pendingEntries.set(meta.id, pending);
    if (pending.length >= this.flushEntryCount) {
      void this.flushRecording(meta.id).catch((error) => {
        this.warn("LoopReelPersistence: flush failed", { error });
      });
      return;
    }
    this.scheduleFlush();
  }

  private handleRecordingChanged(meta: SessionRecordingMeta): void {
    const persistedMeta = metaFromRecording(meta);
    void this.persistMeta(persistedMeta)
      .then(async () => {
        if (meta.status === "ended") {
          await this.flushRecording(meta.id);
          await this.rotatePersistedRecordings();
        }
      })
      .catch((error) => {
        this.warn("LoopReelPersistence: meta update failed", { error });
      });
  }

  private async persistMeta(meta: LoopReelPersistedMeta): Promise<void> {
    if (this.disposed) return;
    if (this.knownMetaIds.has(meta.id)) {
      await this.backend.updateMeta(meta.id, meta);
    } else {
      await this.backend.create(meta);
      this.knownMetaIds.add(meta.id);
    }
    this.metas.set(meta.id, meta);
  }

  private async ensureMetaCreated(meta: LoopReelPersistedMeta): Promise<void> {
    if (this.disposed || this.knownMetaIds.has(meta.id)) return;
    await this.backend.create(meta);
    this.knownMetaIds.add(meta.id);
    this.metas.set(meta.id, meta);
  }

  private enqueueAppend(id: string, entries: readonly RecordedEntry[]): Promise<void> {
    const previous = this.appendChains.get(id) ?? Promise.resolve();
    const jsonl = encodeLoopReelEntriesJsonl(entries);
    const current = previous.then(() => this.backend.appendEntries(id, jsonl));
    const tracked = current
      .catch(() => undefined)
      .then(() => {
        if (this.appendChains.get(id) === tracked) {
          this.appendChains.delete(id);
        }
      });
    this.appendChains.set(id, tracked);
    return current;
  }

  private async findMeta(id: string): Promise<LoopReelPersistedMeta | null> {
    const metas = await this.backend.list();
    for (const meta of metas) {
      this.knownMetaIds.add(meta.id);
      this.metas.set(meta.id, meta);
    }
    return this.metas.get(id) ?? null;
  }

  private async rotatePersistedRecordings(): Promise<void> {
    const metas = await this.backend.list();
    for (const meta of metas) {
      this.knownMetaIds.add(meta.id);
      this.metas.set(meta.id, meta);
    }
    const ended = metas
      .filter((meta) => meta.status === "ended")
      .sort((a, b) => (a.endedAt ?? a.startedAt) - (b.endedAt ?? b.startedAt));
    const deleteCount = ended.length - this.maxPersistedRecordings;
    if (deleteCount <= 0) return;
    for (const meta of ended.slice(0, deleteCount)) {
      await this.backend.delete(meta.id);
      this.knownMetaIds.delete(meta.id);
      this.metas.delete(meta.id);
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer !== null || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flushAll().catch((error) => {
        this.warn("LoopReelPersistence: scheduled flush failed", { error });
      });
    }, this.flushIntervalMs);
  }

  private clearFlushTimer(): void {
    if (this.flushTimer === null) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }
}

export const createLoopReelPersistence = (
  store: LoopReelStore,
  options?: LoopReelPersistenceOptions,
): LoopReelPersistenceController => new LoopReelPersistence(store, options);
