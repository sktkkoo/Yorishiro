/**
 * EventBus — DispatchEvent の dispatcher。登録済み Trigger を match し、handler を async schedule する。
 *
 * revelation 3.19 の runtime contract を実装する load-bearing piece：
 *
 *   1. Max dispatch chain depth (default 4, constructor-overridable)。越えた synthetic
 *      event は logger.warn して silent drop する。
 *   2. Trigger.match() は dispatch/emitSynthetic の呼び出し stack で synchronous に走り、
 *      handler は schedule (default: queueMicrotask) 経由で async に走る。
 *   3. SyntheticEvent.timestamp は emitSynthetic 時点で time.now() を自動補填する。
 *   4. Cooldown は bus の責務ではない（pack level の g.4 PersonaRegistry 責務）。
 *   5. PackSource は register() / emitSynthetic() の引数としてそのまま受け取り、
 *      verbatim で stamping する。binding は呼び出し側（g.4）の責務。
 *
 * Philosophy: docs/PRESENCE_HARNESS.md「Twin-trigger co-emission」+「Synthetic event」
 * SDK surface: src/sdk/reaction.d.ts の DispatchEvent / Trigger / TriggerMatch / ReactionEvent
 */

import type { DispatchEvent, ReactionEvent, SyntheticEvent, Trigger } from "@charminal/sdk";
import type { Time } from "../../core/time";

/** Dispatch chain depth ceiling (revelation 3.19 #1、MVP default)。 */
const DEFAULT_MAX_DEPTH = 4;

/** Default async scheduler — handlers run on the microtask queue after dispatch returns. */
const defaultSchedule = (task: () => void): void => {
  queueMicrotask(task);
};

/** No-op logger used when the caller does not inject one. */
const noopLogger: EventBusLogger = {
  warn: () => {},
  error: () => {},
};

/**
 * Pack identity bound at registration / emit time。bus はこれを生成しない。
 * g.4 PersonaRegistry / HarnessRegistry が pack load 時に closure-bind して渡す。
 */
export interface PackSource {
  readonly type: "persona" | "harness";
  readonly packId: string;
}

/**
 * Bus-facing handler。PersonaRegistry (g.4) が persona / harness の reflex handler を
 * context creation + cooldown + weighted selection で wrap してから register する。
 *
 * `depth` は dispatch chain の現在深度。handler の bound emitEvent closure が child
 * synthetic の parentDepth としてそのまま使える。
 */
export type ReactionHandler = (event: ReactionEvent, depth: number) => void | Promise<void>;

/**
 * Minimal logger contract。production では g.5 LogBridge が実装する。test では spy を渡す。
 */
export interface EventBusLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface EventBusDeps {
  /** SyntheticEvent.timestamp 自動補填のみに使う。 */
  readonly time: Time;
  /** Default: no-op logger. */
  readonly logger?: EventBusLogger;
  /**
   * Handler 実行の async scheduler。Default: `queueMicrotask`。
   * Test は `(task) => task()` を渡して synchronous に実行できる。
   */
  readonly schedule?: (task: () => void) => void;
  /** Dispatch chain depth ceiling。Default 4 (MVP)。 */
  readonly maxDepth?: number;
}

export interface Registration {
  dispose(): void;
}

interface RegistryEntry {
  readonly trigger: Trigger;
  readonly handler: ReactionHandler;
  readonly source: PackSource;
  /** Registration order — used as stable-sort tiebreaker within equal priority. */
  readonly sequence: number;
}

const priorityOf = (trigger: Trigger): number => trigger.priority ?? 0;

/**
 * Stable descending sort by trigger priority。equal priority は registration order
 * （sequence 昇順）を保つ。Array#sort は V8 以降 stable だが、priority が同じときの
 * 挙動を明示するため sequence を secondary key にする。
 */
const byPriorityDesc = (a: RegistryEntry, b: RegistryEntry): number => {
  const diff = priorityOf(b.trigger) - priorityOf(a.trigger);
  if (diff !== 0) return diff;
  return a.sequence - b.sequence;
};

const createSyntheticEvent = (
  source: PackSource,
  name: string,
  payload: unknown,
  timestamp: number,
): SyntheticEvent => ({
  kind: "synthetic",
  source: { type: source.type, packId: source.packId },
  name,
  payload,
  timestamp,
});

export class EventBus {
  private readonly time: Time;
  private readonly logger: EventBusLogger;
  private readonly schedule: (task: () => void) => void;
  private readonly maxDepth: number;

  private readonly entries = new Map<number, RegistryEntry>();
  private nextId = 0;

  constructor(deps: EventBusDeps) {
    this.time = deps.time;
    this.logger = deps.logger ?? noopLogger;
    this.schedule = deps.schedule ?? defaultSchedule;
    this.maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  register(trigger: Trigger, handler: ReactionHandler, source: PackSource): Registration {
    const id = this.nextId++;
    this.entries.set(id, { trigger, handler, source, sequence: id });
    return {
      dispose: () => {
        this.entries.delete(id);
      },
    };
  }

  /** External entrypoint。Depth = 1。 */
  dispatch(event: DispatchEvent): void {
    this.dispatchAtDepth(event, 1);
  }

  /**
   * Synthetic event entrypoint。g.4 が作る per-pack bound ctx.emitEvent closure から呼ばれる。
   * parentDepth + 1 が maxDepth を超える場合、logger.warn して silent drop する（throw しない）。
   */
  emitSynthetic(source: PackSource, name: string, payload: unknown, parentDepth: number): void {
    const newDepth = parentDepth + 1;
    if (newDepth > this.maxDepth) {
      this.logger.warn("EventBus: synthetic event dropped — max depth exceeded", {
        name,
        parentDepth,
        newDepth,
        maxDepth: this.maxDepth,
        source: { type: source.type, packId: source.packId },
      });
      return;
    }

    const event = createSyntheticEvent(source, name, payload, this.time.now());
    this.dispatchAtDepth(event, newDepth);
  }

  // ─── internals ────────────────────────────────────────────────

  private dispatchAtDepth(event: DispatchEvent, depth: number): void {
    // Collect matching (entry, reactionEvent) pairs synchronously.
    const matched: Array<{ entry: RegistryEntry; reactionEvent: ReactionEvent }> = [];
    for (const entry of this.entries.values()) {
      const match = entry.trigger.match(event);
      if (match === null) continue;
      const reactionEvent: ReactionEvent = {
        reaction: match.reaction,
        triggeredBy: event,
        payload: match.payload,
        trigger: entry.trigger,
      };
      matched.push({ entry, reactionEvent });
    }

    // DEBUG: event dispatch tracing (skip high-frequency pty-output/user-input)
    if (event.kind !== "pty-output" && event.kind !== "user-input") {
      console.log(
        `[EventBus] ${event.kind} → matched=${matched.length}`,
        matched.map((m) => m.reactionEvent.reaction),
      );
    }

    if (matched.length === 0) return;

    // Priority sort: stable descending by trigger.priority. Equal priority falls
    // back to registration order (entry.sequence).
    matched.sort((a, b) => byPriorityDesc(a.entry, b.entry));

    // Schedule each handler via the injected async scheduler. queueMicrotask is
    // FIFO, so enqueue order becomes run order.
    for (const { entry, reactionEvent } of matched) {
      this.schedule(() => {
        this.runHandler(entry, reactionEvent, depth);
      });
    }
  }

  private runHandler(entry: RegistryEntry, reactionEvent: ReactionEvent, depth: number): void {
    try {
      const result = entry.handler(reactionEvent, depth);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          this.logError(entry, reactionEvent, err);
        });
      }
    } catch (err) {
      this.logError(entry, reactionEvent, err);
    }
  }

  private logError(entry: RegistryEntry, reactionEvent: ReactionEvent, err: unknown): void {
    this.logger.error("EventBus: handler threw", {
      triggerId: entry.trigger.id,
      reaction: reactionEvent.reaction,
      source: { type: entry.source.type, packId: entry.source.packId },
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
