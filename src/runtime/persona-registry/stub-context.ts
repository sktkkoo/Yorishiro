/**
 * Stub PersonaContext factory — supplies no-op sub-APIs for every surface
 * a PersonaContext exposes so that g.4 PersonaRegistry can fire handlers
 * without any real Body / Voice / Space / Log / Memory / Terminal / Charm
 * infrastructure in place.
 *
 * Philosophy: docs/INHABITED_INTERFACE_PHILOSOPHY.md「多人格の住人」
 * SDK surface: src/sdk/context.d.ts の PersonaContext（27–97）+ sub-APIs
 *
 * Phase 3.5 swaps this out for a real factory backed by VRM / VoicePlayer /
 * Three.js renderer / jsonl LogBridge / file-backed memory scopes.
 */

import type {
  AnimationHandle,
  AnimationRef,
  CharacterAPI,
  CharmAPI,
  ExpressionHandle,
  ExpressionTarget,
  GazeHandle,
  GazeTarget,
  LogAPI,
  LogEntry,
  MemoryAPI,
  MemoryScope,
  PersonaContext,
  PersonaRef,
  PlayOptions,
  ReactionEvent,
  SayOptions,
  SpaceAPI,
  SpaceEffectHandle,
  SpaceEffectRequest,
  TerminalAPI,
  VoiceAPI,
  VoiceClipRef,
  VoiceHandle,
  VoicePlayOptions,
} from "@charminal/sdk";
import type { Time } from "../../core/time";

/**
 * Inputs the registry hands to a PersonaContextFactory when a handler is
 * about to fire. The factory combines these dynamic parts with whatever
 * static infrastructure it owns (real or stubbed) to produce a full
 * PersonaContext.
 */
export interface PersonaContextInputs {
  readonly event: ReactionEvent;
  readonly persona: PersonaRef;
  readonly time: Time;
  readonly emitEvent: (name: string, payload?: unknown) => void;
  readonly signal: AbortSignal;
}

export type PersonaContextFactory = (inputs: PersonaContextInputs) => PersonaContext;

// ─── stub sub-API builders ────────────────────────────────────────────

const stubAnimationHandle = (animation: AnimationRef): AnimationHandle => ({
  animation,
  startedAt: 0,
  setWeight: () => {},
  stop: () => Promise.resolve(),
  cancel: () => {},
  completion: Promise.resolve(),
});

const stubExpressionHandle = (
  target: ExpressionTarget,
  requestedIntensity: number,
): ExpressionHandle => ({
  target,
  requestedIntensity,
  effectiveWeight: 0,
  setIntensity: () => {},
  release: () => {},
});

const stubGazeHandle = (target: GazeTarget): GazeHandle => ({
  target,
  active: false,
  release: () => {},
});

const stubVoiceHandle = (): VoiceHandle => ({
  startedAt: 0,
  stop: () => Promise.resolve(),
  completion: Promise.resolve(),
});

const stubSpaceEffectHandle = (kind: string): SpaceEffectHandle => ({
  kind,
  startedAt: 0,
  completion: Promise.resolve(),
  cancel: () => {},
});

const createStubCharacterAPI = (): CharacterAPI => ({
  play: (animation: AnimationRef, _options?: PlayOptions) => stubAnimationHandle(animation),
  express: (target: ExpressionTarget, intensity: number) => stubExpressionHandle(target, intensity),
  gaze: (target: GazeTarget) => stubGazeHandle(target),
  interrupt: () => {},
});

const createStubVoiceAPI = (): VoiceAPI => ({
  say: (_text: string, _options?: SayOptions) => stubVoiceHandle(),
  play: (_clipRef: VoiceClipRef, _options?: VoicePlayOptions) => stubVoiceHandle(),
  silence: () => {},
});

const createStubSpaceAPI = (): SpaceAPI => ({
  injectEffect: (request: SpaceEffectRequest) => stubSpaceEffectHandle(request.kind),
});

const createStubLogAPI = (): LogAPI => ({
  write: () => {},
  tail: (_count: number): ReadonlyArray<LogEntry> => [],
  read: (): ReadonlyArray<LogEntry> => [],
});

/** Tiny in-memory MemoryScope backed by a Map. Generic cast is per SDK contract. */
const createStubMemoryScope = (): MemoryScope => {
  const store = new Map<string, unknown>();
  return {
    get: <T = unknown>(key: string): T | undefined => store.get(key) as T | undefined,
    set: <T = unknown>(key: string, value: T): void => {
      store.set(key, value);
    },
    delete: (key: string): void => {
      store.delete(key);
    },
  };
};

const createStubMemoryAPI = (): MemoryAPI => ({
  persona: createStubMemoryScope(),
  core: createStubMemoryScope(),
});

const createStubTerminalAPI = (): TerminalAPI => ({
  output: (): string => "",
  session: { pid: 0, cwd: "", startedAt: 0 },
});

const stubCharm: CharmAPI = async (_command: string): Promise<void> => {};

/**
 * Returns a factory that builds a PersonaContext with every sub-API stubbed
 * out. Handlers can call `ctx.character.play(...)` etc. without crashing,
 * but the calls are silent no-ops that will be swapped for real
 * implementations in Phase 3.5.
 */
export const createStubPersonaContextFactory = (): PersonaContextFactory => {
  return (inputs: PersonaContextInputs): PersonaContext => ({
    event: inputs.event,
    persona: inputs.persona,
    time: inputs.time,
    emitEvent: inputs.emitEvent,
    character: createStubCharacterAPI(),
    voice: createStubVoiceAPI(),
    space: createStubSpaceAPI(),
    log: createStubLogAPI(),
    memory: createStubMemoryAPI(),
    terminal: createStubTerminalAPI(),
    charm: stubCharm,
    signal: inputs.signal,
  });
};
