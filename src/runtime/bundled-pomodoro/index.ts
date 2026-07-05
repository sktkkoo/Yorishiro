/**
 * Bundled pomodoro amenity の登録 helper。
 *
 * App.tsx から呼ばれ、pomodoro amenity を registry に register する。
 * terminal opacity 制御用の deps は App.tsx 側から注入される。
 */

import type { AmenityContext, HistoryAPI, LoopPhase } from "@yorishiro/sdk";
import pomodoroPack, {
  createPomodoroAmenity,
  type PomodoroActivateContext,
} from "../../../bundled-packs/amenities/pomodoro/amenity";
import type { TweenManager } from "../../core/tween/tween-manager";
import type { AmenityPackRegistry } from "../amenity-pack-registry";

const FALLBACK_AMBIENT_AUDIO: AmenityContext["ambientAudio"] = {
  getState: () => ({ muted: false, volume: 1 }),
  setMuted: () => {},
  setVolume: () => {},
};

export interface RegisterBundledPomodoroDeps {
  readonly registry: AmenityPackRegistry;
  readonly tweenManager: TweenManager;
  readonly setTerminalOpacity: (value: number) => void;
  readonly getTerminalOpacity: () => number;
  readonly emitEvent: (name: string, payload?: unknown) => void;
  /** loop lifecycle phase を観察 stream に announce する（host が agent=null stamp）。 */
  readonly loop: (phase: LoopPhase, detail?: unknown) => void;
  readonly history: HistoryAPI;
}

export function registerBundledPomodoro(deps: RegisterBundledPomodoroDeps) {
  const abortController = new AbortController();

  const ctx: PomodoroActivateContext = {
    time: {
      now: () => Date.now(),
      after: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      schedule: (ms, action) => {
        const id = setTimeout(action, ms);
        return { cancel: () => clearTimeout(id) };
      },
      every: (interval, action) => {
        const id = setInterval(action, interval);
        return { cancel: () => clearInterval(id) };
      },
      probability: (opts) => {
        const id = setInterval(() => {
          if (Math.random() < opts.probability) opts.action();
        }, opts.interval);
        return { cancel: () => clearInterval(id) };
      },
      afterJitter: (min, max) =>
        new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min))),
    },
    persona: { id: "", name: "" },
    emitEvent: deps.emitEvent,
    tween: {
      start: (key, to, durationMs, apply, options) =>
        deps.tweenManager.start(`pomodoro:${key}`, to, durationMs, apply, options),
      startVec3: (key, to, durationMs, apply, options) =>
        deps.tweenManager.startVec3(`pomodoro:${key}`, to, durationMs, apply, options),
      cancel: (key) => deps.tweenManager.cancel(`pomodoro:${key}`),
    },
    ambientAudio: FALLBACK_AMBIENT_AUDIO,
    system: {} as AmenityContext["system"],
    history: deps.history,
    loop: { announce: (phase, detail) => deps.loop(phase, detail) },
    log: { write: () => {}, tail: () => [], read: () => [] },
    memory: {
      persona: { get: () => undefined, set: () => {}, delete: () => {} },
      core: { get: () => undefined, set: () => {}, delete: () => {} },
    },
    terminal: { output: () => "", session: { pid: 0, cwd: "", startedAt: 0 } },
    yori: async () => {},
    signal: abortController.signal,
    resolveAsset: () => "",
    setTerminalOpacity: deps.setTerminalOpacity,
    getTerminalOpacity: deps.getTerminalOpacity,
  };

  const handle = createPomodoroAmenity(ctx);

  const registration = deps.registry.register({
    id: pomodoroPack.id,
    origin: "bundled",
    manifest: {
      id: pomodoroPack.id,
      type: "amenity",
      version: "0.1.0",
      yorishiroVersion: "^0.3.0",
      entry: "amenity.ts",
    },
    handle,
  });

  deps.registry.enable(pomodoroPack.id);

  return {
    dispose: () => {
      abortController.abort();
      registration.dispose();
    },
  };
}
