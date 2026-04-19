/**
 * PersonaReflexDispatcher — active persona の reflex（customTriggers + responses）を
 * EventBus に bridge する primitive。
 *
 * 責務：
 *   1. PersonaRegistry.subscribeActive で active persona の変化を購読し、
 *      active persona の customTriggers を bus に register する。active 切替時に
 *      旧 registrations を dispose し、新 persona の triggers を attach する。
 *   2. handler 起動時の wrapper 内で responses-table lookup + cooldown filtering
 *      + weighted random selection + per-pack bound PersonaContext を構築する。
 *   3. `event.triggeredBy.timestamp` を cooldown 基準として使う（revelation 3.19
 *      contract item 4 — synthetic event は producer の timestamp を保持し、bus
 *      が emit 時に補填する）。
 *   4. PackSource を closure-bind して per-handler `ctx.emitEvent` の source を
 *      registration 時に固定する（revelation 3.19 contract item 5）。
 *
 * state 管理 (`PersonaRegistryImpl`) と reflex dispatch を概念的に分離する設計
 * （memory: feedback_separate_conceptually_distinct_systems）。dispatcher は
 * 「今 active な 1 人」だけを面倒見る — single-active semantics と整合する。
 *
 * Philosophy: docs/philosophy/INHABITED_CHARACTER_INTERFACE.md「多人格の住人」
 * Internal design-record: 2026-04-19-persona-registry-unification.md
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
import {
  createStubPersonaContextFactory,
  type PersonaContextFactory,
} from "../persona-registry/stub-context";
import type { Disposable, PersonaRegistry } from "../persona-registry/types";

const noopLogger: EventBusLogger = {
  warn: () => {},
  error: () => {},
};

export interface PersonaReflexDispatcherDeps {
  readonly bus: EventBus;
  readonly time: Time;
  /** active persona の出所。`PersonaRegistryImpl` を本番で渡す。 */
  readonly registry: PersonaRegistry;
  /** Defaults to `createStubPersonaContextFactory()`。VRM 非同期 load 後に setContextFactory で差し替える。 */
  readonly contextFactory?: PersonaContextFactory;
  /** Defaults to a no-op logger. */
  readonly logger?: EventBusLogger;
  /** Defaults to `Math.random`. Used only for weighted handler selection. */
  readonly random?: () => number;
}

interface ActiveState {
  readonly persona: PersonaDefinition;
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

export class PersonaReflexDispatcher {
  private readonly bus: EventBus;
  private readonly time: Time;
  private contextFactory: PersonaContextFactory;
  private readonly logger: EventBusLogger;
  private readonly random: () => number;

  private current: ActiveState | null = null;
  private subscription: Disposable | null = null;
  private disposed = false;

  constructor(deps: PersonaReflexDispatcherDeps) {
    this.bus = deps.bus;
    this.time = deps.time;
    this.contextFactory = deps.contextFactory ?? createStubPersonaContextFactory();
    this.logger = deps.logger ?? noopLogger;
    this.random = deps.random ?? Math.random;

    // subscribeActive は登録時に現 active を同期 fire する（PersonaRegistryImpl の
    // 仕様）。bundled persona が dispatcher 構築前に register されていれば、
    // ここで同期に triggers が bus に attach される。
    this.subscription = deps.registry.subscribeActive((persona) => {
      this.applyPersona(persona);
    });
  }

  /**
   * Replace the context factory. Used when Body becomes available
   * after initial construction (VRM loads asynchronously).
   */
  setContextFactory(factory: PersonaContextFactory): void {
    this.contextFactory = factory;
  }

  /**
   * dispose subscriptions and tear down the current persona's bus registrations.
   * dispose 後の active swap callback は無視される。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.subscription !== null) {
      this.subscription.dispose();
      this.subscription = null;
    }
    this.teardown();
  }

  // ─── internals ────────────────────────────────────────────────────

  private applyPersona(persona: PersonaDefinition | null): void {
    if (this.disposed) return;

    // idempotent guard：同 reference の再 fire は何もしない。
    // PersonaRegistryImpl の lastActivePersona でも同等の guard があるが、
    // dispatcher 側でも防御しておく（subscribeActive の同期 initial fire が
    // 重複したケースなど）。
    const currentPersona = this.current?.persona ?? null;
    if (currentPersona === persona) return;

    this.teardown();

    if (persona === null) return;

    const source: PackSource = { type: "persona", packId: persona.id };
    const state: ActiveState = {
      persona,
      source,
      registrations: [],
      cooldown: new Map(),
      abortController: new AbortController(),
    };

    // reflex / customTriggers が無い persona でも state は track する
    // （次の swap で idempotent guard が機能するため）。
    const triggers = persona.reflex?.customTriggers ?? [];
    if (triggers.length > 0) {
      const wrapper = this.createWrapper(state);
      for (const trigger of triggers) {
        state.registrations.push(this.bus.register(trigger, wrapper, source));
      }
    }

    this.current = state;
  }

  private teardown(): void {
    if (this.current === null) return;
    for (const reg of this.current.registrations) {
      reg.dispose();
    }
    this.current.abortController.abort();
    this.current = null;
  }

  private createWrapper(state: ActiveState): ReactionHandler {
    return (event: ReactionEvent, depth: number) => {
      this.runWrapper(state, event, depth);
    };
  }

  private runWrapper(state: ActiveState, event: ReactionEvent, depth: number): void {
    try {
      const { persona, source } = state;
      // reflex が無い persona は wrapper を attach しない設計のため、
      // 通常は到達しないが防御的に early return。
      if (persona.reflex === undefined) return;
      const set = persona.reflex.responses[event.reaction];
      if (set === undefined) {
        this.logger.warn("PersonaReflexDispatcher: no response entry for reaction", {
          packId: persona.id,
          reaction: event.reaction,
        });
        return;
      }
      if (set.handlers.length === 0) {
        this.logger.warn("PersonaReflexDispatcher: empty handler set for reaction", {
          packId: persona.id,
          reaction: event.reaction,
        });
        return;
      }

      const now = event.triggeredBy.timestamp;
      const lastFiredByIndex = state.cooldown.get(event.reaction);
      const eligible = filterByCooldown(set, now, lastFiredByIndex);
      if (eligible.length === 0) {
        this.logger.warn("PersonaReflexDispatcher: all candidates in cooldown", {
          packId: persona.id,
          reaction: event.reaction,
        });
        return;
      }

      const selected = selectWeighted(eligible, this.random);
      if (selected === undefined) {
        this.logger.warn("PersonaReflexDispatcher: weighted selection produced no candidate", {
          packId: persona.id,
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
        persona: { id: persona.id, name: persona.name },
        time: this.time,
        emitEvent,
        signal: state.abortController.signal,
      });

      this.invokeHandler(state, event.reaction, selected.handler.handler, ctx);
    } catch (err) {
      this.logger.error("PersonaReflexDispatcher: wrapper threw", {
        packId: state.persona.id,
        reaction: event.reaction,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private invokeHandler(
    state: ActiveState,
    reaction: ReactionType,
    handler: PersonaHandler,
    ctx: Parameters<PersonaHandler>[0],
  ): void {
    try {
      const result = handler(ctx);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          this.logger.error("PersonaReflexDispatcher: handler rejected", {
            packId: state.persona.id,
            reaction,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      this.logger.error("PersonaReflexDispatcher: handler threw", {
        packId: state.persona.id,
        reaction,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
