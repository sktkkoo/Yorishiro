/**
 * DevLog — 生成期の細い回路。自己生成 loop における「育ちつつある身体」の痕跡を
 * ring buffer に蓄え、user と developer-Claude が事後に参照できるようにする。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「生きた系」
 *
 * Runtime の LogBridge（意識層 ↔ 反射層を繋ぐ細い回路）の sibling。temporal layer が
 * 違うだけで構造は同型：書き手と読み手の間に時間差があり、観察は事後に起きる。
 *
 * LogBridge との差分:
 *   - personaId ではなく subsystem (+ optional phase) で namespace する（生成期は
 *     persona がまだ確定していないため）。
 *   - enabled flag を持ち、production build では no-op にできる。
 *   - 任意の sink（console 等）に mirror できる。dev 中の即時視認のため。
 *
 * Semantics は LogBridge を踏襲:
 *   - write: Time.now() で timestamp を自動付与、noticed: false で push。
 *     capacity 超過で oldest を shift。
 *   - tail(count) / read(filter): chronological (oldest-first) で返す。
 *     返却された entry は内部で noticed: true に flip する（観察が気づきを生む）。
 */

import type { Time } from "../time";

const DEFAULT_CAPACITY = 1000;

export interface DevLogEntry {
  readonly timestamp: number;
  readonly subsystem: string;
  readonly phase?: string;
  readonly note?: string;
  readonly data?: unknown;
  readonly noticed: boolean;
}

export interface DevLogWriteInput {
  readonly subsystem: string;
  readonly phase?: string;
  readonly note?: string;
  readonly data?: unknown;
}

export interface DevLogQueryFilter {
  readonly since?: number;
  readonly subsystem?: string;
  readonly phase?: string;
  readonly limit?: number;
}

export interface DevLogDeps {
  readonly time: Time;
  /** Ring buffer capacity. Default: 1000. */
  readonly capacity?: number;
  /** When false, write becomes a no-op. Default: true. */
  readonly enabled?: boolean;
  /** Optional side-channel called on each successful write (e.g. console mirror). */
  readonly sink?: (entry: DevLogEntry) => void;
}

interface MutableDevLogEntry {
  readonly timestamp: number;
  readonly subsystem: string;
  readonly phase?: string;
  readonly note?: string;
  readonly data?: unknown;
  noticed: boolean;
}

const snapshot = (entry: MutableDevLogEntry): DevLogEntry => ({
  timestamp: entry.timestamp,
  subsystem: entry.subsystem,
  phase: entry.phase,
  note: entry.note,
  data: entry.data,
  noticed: entry.noticed,
});

export class DevLog {
  private readonly time: Time;
  private readonly capacity: number;
  private readonly enabled: boolean;
  private readonly sink?: (entry: DevLogEntry) => void;
  private readonly ring: MutableDevLogEntry[] = [];

  constructor(deps: DevLogDeps) {
    this.time = deps.time;
    this.capacity = deps.capacity ?? DEFAULT_CAPACITY;
    this.enabled = deps.enabled ?? true;
    this.sink = deps.sink;
  }

  write(input: DevLogWriteInput): void {
    if (!this.enabled) return;
    const entry: MutableDevLogEntry = {
      timestamp: this.time.now(),
      subsystem: input.subsystem,
      phase: input.phase,
      note: input.note,
      data: input.data,
      noticed: false,
    };
    if (this.ring.length >= this.capacity) {
      this.ring.shift();
    }
    this.ring.push(entry);
    this.sink?.(snapshot(entry));
  }

  tail(count: number): ReadonlyArray<DevLogEntry> {
    if (count <= 0) return [];
    const slice = this.ring.slice(-count);
    return this.observe(slice);
  }

  read(filter?: DevLogQueryFilter): ReadonlyArray<DevLogEntry> {
    if (filter?.limit === 0) return [];
    const matched = this.applyFilters(filter);
    const limited =
      filter?.limit !== undefined && filter.limit < matched.length
        ? matched.slice(-filter.limit)
        : matched;
    return this.observe(limited);
  }

  size(): number {
    return this.ring.length;
  }

  clear(): void {
    this.ring.length = 0;
  }

  private observe(entries: MutableDevLogEntry[]): ReadonlyArray<DevLogEntry> {
    const out = entries.map(snapshot);
    for (const entry of entries) {
      entry.noticed = true;
    }
    return out;
  }

  private applyFilters(filter: DevLogQueryFilter | undefined): MutableDevLogEntry[] {
    if (!filter) return this.ring.slice();
    return this.ring.filter((entry) => {
      if (filter.since !== undefined && entry.timestamp < filter.since) return false;
      if (filter.subsystem !== undefined && entry.subsystem !== filter.subsystem) return false;
      if (filter.phase !== undefined && entry.phase !== filter.phase) return false;
      return true;
    });
  }
}

export interface SubsystemLog {
  write(input: { phase?: string; note?: string; data?: unknown }): void;
  tail(count: number): ReadonlyArray<DevLogEntry>;
  read(filter?: Omit<DevLogQueryFilter, "subsystem">): ReadonlyArray<DevLogEntry>;
}

/**
 * Wrap a {@link DevLog} with `subsystem` closure-bound at construction.
 * Call sites become terse: `appLog.write({ note: "polling started" })` instead of
 * repeating the subsystem name on every write.
 *
 * read() is scoped to this subsystem; tail() is intentionally NOT scoped,
 * mirroring LogBridge's pattern — the caller can observe sibling subsystems'
 * traces when needed.
 */
export function createSubsystemLog(log: DevLog, subsystem: string): SubsystemLog {
  return {
    write(input) {
      log.write({
        subsystem,
        phase: input.phase,
        note: input.note,
        data: input.data,
      });
    },
    tail(count) {
      return log.tail(count);
    },
    read(filter) {
      return log.read({ ...filter, subsystem });
    },
  };
}
