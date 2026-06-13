/**
 * LogBridge — 思考層と反射層を繋ぐ細い回路。反射層で起きた reaction の痕跡を
 * ring buffer に蓄え、Claude Code が `ctx.log` 経由で「自分の body が何をしたか」
 * を後から読めるようにする。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「ログという細い回路」+
 *             docs/philosophy/PHILOSOPHY.md「ログという橋」
 * SDK surface: src/sdk/context.d.ts の LogAPI / LogEntry / LogFilter（514–542）
 *
 * Phase 3.3(g.5) で TDD 実装。file persistence (jsonl append) は Phase 3.5 の
 * Rust bridge に委譲する — g.5 の責務は in-memory ring buffer と SDK adapter のみ。
 *
 * Semantics:
 *   - write: Time.now() で timestamp を自動付与、noticed: false で push。
 *     capacity を超えたら oldest を shift で落とす。
 *   - tail(count): 最新 N 件を chronological (oldest-first) で返す。返却された
 *     entry は内部で noticed: true に flip する。
 *   - read(filter): since / personaId / reaction / limit を AND で絞り、
 *     chronological で返す。マッチした entry のみ noticed: true に flip する。
 *   - snapshot は mutation の「前」の状態で撮る。すなわち初回観測では
 *     noticed: false、次回以降は true。これは「見る、ゆえに気づく」という
 *     哲学的対応: 観測という行為それ自体が「気づき」を生む。
 *   - tail() は personaId でフィルタしない。persona は sibling の行動を
 *     log 越しに観察できる (LogReadingPolicy.framing で語り口だけが変わる)。
 */

import type { LogAPI, LogEntry, LogEntryWrite, LogFilter } from "@charminal/sdk";
import type { Time } from "../time";

const DEFAULT_CAPACITY = 1000;

export interface LogBridgeDeps {
  readonly time: Time;
  /** Ring buffer capacity. Default: 1000. */
  readonly capacity?: number;
}

export interface LogWriteInput {
  readonly personaId: string;
  readonly reaction: string;
  readonly note?: string;
  readonly data?: unknown;
}

export interface LogQueryFilter {
  readonly since?: number;
  readonly personaId?: string;
  readonly reaction?: string;
  readonly limit?: number;
}

/**
 * Internal mutable entry. `noticed` flips to true after tail/read observes it;
 * all other fields are readonly. The SDK's LogEntry is constructed by
 * {@link snapshot} from one of these before return.
 */
interface MutableLogEntry {
  readonly timestamp: number;
  readonly personaId: string;
  readonly reaction: string;
  readonly note?: string;
  readonly data?: unknown;
  noticed: boolean;
}

const snapshot = (entry: MutableLogEntry): LogEntry => ({
  timestamp: entry.timestamp,
  personaId: entry.personaId,
  reaction: entry.reaction,
  note: entry.note,
  data: entry.data,
  noticed: entry.noticed,
});

export class LogBridge {
  private readonly time: Time;
  private readonly capacity: number;
  private readonly ring: MutableLogEntry[] = [];

  constructor(deps: LogBridgeDeps) {
    this.time = deps.time;
    this.capacity = deps.capacity ?? DEFAULT_CAPACITY;
  }

  write(input: LogWriteInput): void {
    const entry: MutableLogEntry = {
      timestamp: this.time.now(),
      personaId: input.personaId,
      reaction: input.reaction,
      note: input.note,
      data: input.data,
      noticed: false,
    };
    if (this.ring.length >= this.capacity) {
      this.ring.shift();
    }
    this.ring.push(entry);
  }

  tail(count: number): ReadonlyArray<LogEntry> {
    if (count <= 0) return [];
    const slice = this.ring.slice(-count);
    return this.observe(slice);
  }

  read(filter?: LogQueryFilter): ReadonlyArray<LogEntry> {
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

  /**
   * Emit snapshots for the given entries, then flip their internal `noticed`
   * flag to true. The returned array reflects the pre-mutation state — the
   * first observation of an entry is always `noticed: false`.
   */
  private observe(entries: MutableLogEntry[]): ReadonlyArray<LogEntry> {
    const out = entries.map(snapshot);
    for (const entry of entries) {
      entry.noticed = true;
    }
    return out;
  }

  private applyFilters(filter: LogQueryFilter | undefined): MutableLogEntry[] {
    if (!filter) return this.ring.slice();
    return this.ring.filter((entry) => {
      if (filter.since !== undefined && entry.timestamp < filter.since) return false;
      if (filter.personaId !== undefined && entry.personaId !== filter.personaId) return false;
      if (filter.reaction !== undefined && entry.reaction !== filter.reaction) return false;
      return true;
    });
  }
}

/**
 * Wrap a {@link LogBridge} as an SDK-compliant {@link LogAPI} instance with
 * `personaId` closure-bound at construction. Called by the runtime context
 * factory when materializing `ctx.log` for a persona.
 *
 * Naming note: the SDK's LogFilter declares `reactionType`, but LogEntry's
 * field is `reaction`. This adapter translates the SDK name into the
 * bridge's internal filter field.
 *
 * Tail is intentionally NOT personaId-scoped; personas observe the shared
 * log and use LogReadingPolicy.framing to narrate sibling actions.
 */
export function createLogAPI(bridge: LogBridge, personaId: string): LogAPI {
  return {
    write(entry: LogEntryWrite): void {
      bridge.write({
        personaId,
        reaction: entry.reaction,
        note: entry.note,
        data: entry.data,
      });
    },
    tail(count: number): ReadonlyArray<LogEntry> {
      return bridge.tail(count);
    },
    read(filter?: LogFilter): ReadonlyArray<LogEntry> {
      return bridge.read({
        since: filter?.since,
        personaId: filter?.personaId,
        reaction: filter?.reactionType,
        limit: filter?.limit,
      });
    },
  };
}
