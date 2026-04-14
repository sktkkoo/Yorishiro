/**
 * PersonaRegistry — bridges PersonaDefinition objects into the EventBus.
 *
 * Phase 3.3(g.4) implementation. Responsibilities:
 *
 *   1. Register each persona's custom triggers against the bus, paired with a
 *      wrapper handler that owns responses-table lookup + cooldown filtering
 *      + weighted random selection + per-pack bound PersonaContext creation.
 *   2. Use `event.triggeredBy.timestamp` (not `time.now()`) as the cooldown
 *      reference — matches revelation 3.19 contract item 4 (synthetic events
 *      have the producer's timestamp; the bus auto-fills it at emit time).
 *   3. Closure-capture `{ type: 'persona', packId }` as the source for every
 *      per-handler `ctx.emitEvent` call — revelation 3.19 contract item 5
 *      (source is bound at registration time and cannot be forged from the
 *      handler side).
 *
 * Philosophy: docs/INHABITED_INTERFACE_PHILOSOPHY.md「多人格の住人」
 * SDK surface: src/sdk/persona.d.ts の PersonaDefinition + WeightedPersonaHandler
 */

import type {
  PersonaDefinition,
  PersonaHandler,
  PersonaReactionSet,
  ReactionEvent,
  ReactionType,
  WeightedPersonaHandler,
} from "@charminal/sdk";
import type { Time } from "../../core/time";
import type {
  EventBus,
  EventBusLogger,
  PackSource,
  ReactionHandler,
  Registration,
} from "../event-bus";
import { createStubPersonaContextFactory, type PersonaContextFactory } from "./stub-context";

const noopLogger: EventBusLogger = {
  warn: () => {},
  error: () => {},
};

export interface PersonaRegistryDeps {
  readonly bus: EventBus;
  readonly time: Time;
  /** Defaults to `createStubPersonaContextFactory()`. */
  readonly contextFactory?: PersonaContextFactory;
  /** Defaults to a no-op logger. */
  readonly logger?: EventBusLogger;
  /** Defaults to `Math.random`. Used only for weighted handler selection. */
  readonly random?: () => number;
}

interface PersonaState {
  readonly def: PersonaDefinition;
  readonly source: PackSource;
  readonly registrations: Registration[];
  /** cooldown[reaction][handlerIndex] = lastFiredAt (ms) */
  readonly cooldown: Map<ReactionType, number[]>;
  readonly abortController: AbortController;
}

/**
 * Weighted random pick. Missing `weight` is treated as 1. Returns undefined
 * when the list is empty or all weights sum to zero.
 */
const selectWeighted = <T extends { readonly weight?: number }>(
  candidates: ReadonlyArray<T>,
  random: () => number,
): T | undefined => {
  if (candidates.length === 0) return undefined;
  let total = 0;
  for (const candidate of candidates) {
    total += candidate.weight ?? 1;
  }
  if (total <= 0) return undefined;
  let threshold = random() * total;
  for (const candidate of candidates) {
    threshold -= candidate.weight ?? 1;
    if (threshold < 0) return candidate;
  }
  // Floating-point fallback: return the last candidate.
  return candidates[candidates.length - 1];
};

interface EligibleCandidate {
  readonly handler: WeightedPersonaHandler;
  readonly index: number;
  readonly weight: number;
}

/**
 * Returns the subset of handlers whose cooldown has elapsed at `now`.
 * Parallel-indexed with the original set so the caller can write back to
 * the cooldown array after a fire.
 */
const filterByCooldown = (
  set: PersonaReactionSet,
  now: number,
  lastFiredByIndex: ReadonlyArray<number> | undefined,
): EligibleCandidate[] => {
  const eligible: EligibleCandidate[] = [];
  for (let i = 0; i < set.handlers.length; i++) {
    const candidate = set.handlers[i];
    if (candidate.cooldownMs === undefined || candidate.cooldownMs <= 0) {
      eligible.push({ handler: candidate, index: i, weight: candidate.weight ?? 1 });
      continue;
    }
    const lastFired = lastFiredByIndex?.[i];
    if (lastFired === undefined) {
      eligible.push({ handler: candidate, index: i, weight: candidate.weight ?? 1 });
      continue;
    }
    if (now - lastFired >= candidate.cooldownMs) {
      eligible.push({ handler: candidate, index: i, weight: candidate.weight ?? 1 });
    }
  }
  return eligible;
};

export class PersonaRegistry {
  private readonly bus: EventBus;
  private readonly time: Time;
  private contextFactory: PersonaContextFactory;
  private readonly logger: EventBusLogger;
  private readonly random: () => number;
  private readonly personas = new Map<string, PersonaState>();

  constructor(deps: PersonaRegistryDeps) {
    this.bus = deps.bus;
    this.time = deps.time;
    this.contextFactory = deps.contextFactory ?? createStubPersonaContextFactory();
    this.logger = deps.logger ?? noopLogger;
    this.random = deps.random ?? Math.random;
  }

  /**
   * Replace the context factory. Used when Body becomes available
   * after initial construction (VRM loads asynchronously).
   */
  setContextFactory(factory: PersonaContextFactory): void {
    this.contextFactory = factory;
  }

  register(def: PersonaDefinition): Registration {
    if (this.personas.has(def.id)) {
      throw new Error(`PersonaRegistry: packId already registered: ${def.id}`);
    }

    const source: PackSource = { type: "persona", packId: def.id };
    const state: PersonaState = {
      def,
      source,
      registrations: [],
      cooldown: new Map(),
      abortController: new AbortController(),
    };
    this.personas.set(def.id, state);

    const wrapper = this.createWrapper(state);
    const triggers = def.reflex.customTriggers ?? [];
    for (const trigger of triggers) {
      const reg = this.bus.register(trigger, wrapper, source);
      state.registrations.push(reg);
    }

    return {
      dispose: () => {
        const current = this.personas.get(def.id);
        if (current !== state) return; // Already disposed / replaced.
        for (const reg of state.registrations) {
          reg.dispose();
        }
        state.abortController.abort();
        this.personas.delete(def.id);
      },
    };
  }

  has(packId: string): boolean {
    return this.personas.has(packId);
  }

  size(): number {
    return this.personas.size;
  }

  // ─── internals ────────────────────────────────────────────────────

  private createWrapper(state: PersonaState): ReactionHandler {
    return (event: ReactionEvent, depth: number) => {
      this.runWrapper(state, event, depth);
    };
  }

  private runWrapper(state: PersonaState, event: ReactionEvent, depth: number): void {
    try {
      const { def, source } = state;
      const set = def.reflex.responses[event.reaction];
      if (set === undefined) {
        this.logger.warn("PersonaRegistry: no response entry for reaction", {
          packId: def.id,
          reaction: event.reaction,
        });
        return;
      }
      if (set.handlers.length === 0) {
        this.logger.warn("PersonaRegistry: empty handler set for reaction", {
          packId: def.id,
          reaction: event.reaction,
        });
        return;
      }

      const now = event.triggeredBy.timestamp;
      const lastFiredByIndex = state.cooldown.get(event.reaction);
      const eligible = filterByCooldown(set, now, lastFiredByIndex);
      if (eligible.length === 0) {
        this.logger.warn("PersonaRegistry: all candidates in cooldown", {
          packId: def.id,
          reaction: event.reaction,
        });
        return;
      }

      const selected = selectWeighted(eligible, this.random);
      if (selected === undefined) {
        this.logger.warn("PersonaRegistry: weighted selection produced no candidate", {
          packId: def.id,
          reaction: event.reaction,
        });
        return;
      }

      // Record fire time before invoking the handler so synchronous throws
      // still count toward the cooldown (prevents hot-loop retries on bad
      // handlers).
      let lastFired = lastFiredByIndex;
      if (lastFired === undefined) {
        lastFired = new Array<number>(set.handlers.length);
        state.cooldown.set(event.reaction, lastFired);
      }
      lastFired[selected.index] = now;

      const emitEvent = (name: string, payload?: unknown): void => {
        this.bus.emitSynthetic(source, name, payload, depth);
      };

      const ctx = this.contextFactory({
        event,
        persona: { id: def.id, name: def.name },
        time: this.time,
        emitEvent,
        signal: state.abortController.signal,
      });

      this.invokeHandler(state, event.reaction, selected.handler.handler, ctx);
    } catch (err) {
      this.logger.error("PersonaRegistry: wrapper threw", {
        packId: state.def.id,
        reaction: event.reaction,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private invokeHandler(
    state: PersonaState,
    reaction: ReactionType,
    handler: PersonaHandler,
    ctx: Parameters<PersonaHandler>[0],
  ): void {
    try {
      const result = handler(ctx);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          this.logger.error("PersonaRegistry: handler rejected", {
            packId: state.def.id,
            reaction,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      this.logger.error("PersonaRegistry: handler threw", {
        packId: state.def.id,
        reaction,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
