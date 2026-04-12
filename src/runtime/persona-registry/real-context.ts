/**
 * Real PersonaContext factory — wires PersonaContext to live Body / LogBridge.
 *
 * Replaces stub-context.ts's createStubPersonaContextFactory with a factory
 * that delegates to real implementations where available:
 *
 *   - ctx.character → Body.createCharacterAPI()   (real VRM control)
 *   - ctx.log       → createLogAPI(logBridge, id)  (real log bridge)
 *   - ctx.memory    → in-memory Map                (same as stub for now)
 *   - ctx.voice     → stub                         (VoicePlayer is post-MVP)
 *   - ctx.space     → stub                         (Effect pipeline is post-MVP)
 *   - ctx.terminal  → stub                         (PTY observation is post-MVP)
 *   - ctx.charm     → stub                         (CharmCommand is post-MVP)
 */

import type {
  CharmAPI,
  MemoryAPI,
  MemoryScope,
  PersonaContext,
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
import type { Body } from "../../core/body";
import type { LogBridge } from "../../core/log-bridge";
import { createLogAPI } from "../../core/log-bridge";
import type { PersonaContextFactory, PersonaContextInputs } from "./stub-context";

export interface RealContextDeps {
  /** Body instance for CharacterAPI. */
  readonly body: Body;
  /** LogBridge instance for LogAPI. */
  readonly logBridge: LogBridge;
}

/**
 * Create a PersonaContextFactory backed by real Body + LogBridge.
 * Voice / Space / Terminal / Charm remain stubbed for now.
 */
export function createRealPersonaContextFactory(deps: RealContextDeps): PersonaContextFactory {
  const characterAPI = deps.body.createCharacterAPI();

  return (inputs: PersonaContextInputs): PersonaContext => ({
    event: inputs.event,
    persona: inputs.persona,
    time: inputs.time,
    emitEvent: inputs.emitEvent,

    // Real implementations
    character: characterAPI,
    log: createLogAPI(deps.logBridge, inputs.persona.id),

    // Stubbed for now (same as stub-context.ts)
    voice: createStubVoiceAPI(),
    space: createStubSpaceAPI(),
    memory: createStubMemoryAPI(),
    terminal: createStubTerminalAPI(),
    charm: stubCharm,
    signal: inputs.signal,
  });
}

// ─── Stubs for not-yet-implemented APIs ─────────────────

const stubVoiceHandle = (): VoiceHandle => ({
  startedAt: 0,
  stop: () => Promise.resolve(),
  completion: Promise.resolve(),
});

const createStubVoiceAPI = (): VoiceAPI => ({
  say: (_text: string, _options?: SayOptions) => stubVoiceHandle(),
  play: (_clipRef: VoiceClipRef, _options?: VoicePlayOptions) => stubVoiceHandle(),
  silence: () => {},
});

const createStubSpaceAPI = (): SpaceAPI => ({
  injectEffect: (request: SpaceEffectRequest): SpaceEffectHandle => ({
    kind: request.kind,
    startedAt: 0,
    completion: Promise.resolve(),
    cancel: () => {},
  }),
});

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
 * Stub factory — fallback when no Body is available yet.
 * Re-exported from stub-context.ts for backward compatibility.
 */
export { createStubPersonaContextFactory } from "./stub-context";
