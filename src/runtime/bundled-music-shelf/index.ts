/**
 * Bundled music-shelf amenity の登録 helper。
 *
 * App.tsx から呼ばれ、music-shelf amenity を registry に register する。
 * system.exec は Tauri command 経由で実体化する。
 */

import type { AmenityContext, ExecOptions, HistoryAPI } from "@charminal/sdk";
import musicShelfPack from "../../../bundled-packs/amenities/music-shelf/amenity";
import { systemExec } from "../../bindings/tauri-commands";
import type { TweenManager } from "../../core/tween/tween-manager";
import type { AmenityPackRegistry } from "../amenity-pack-registry";

export interface RegisterBundledMusicShelfDeps {
  readonly registry: AmenityPackRegistry;
  readonly tweenManager: TweenManager;
  readonly emitEvent: (name: string, payload?: unknown) => void;
  readonly history: HistoryAPI;
  /**
   * true / undefined なら登録後に active にする。config.disabledPacks で明示的に
   * disable されている場合だけ caller が false を渡す。
   */
  readonly defaultEnabled?: boolean;
}

export function registerBundledMusicShelf(deps: RegisterBundledMusicShelfDeps) {
  const abortController = new AbortController();

  const ctx: AmenityContext = {
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
        deps.tweenManager.start(`music-shelf:${key}`, to, durationMs, apply, options),
      startVec3: (key, to, durationMs, apply, options) =>
        deps.tweenManager.startVec3(`music-shelf:${key}`, to, durationMs, apply, options),
      cancel: (key) => deps.tweenManager.cancel(`music-shelf:${key}`),
    },
    system: {
      exec: async (command: string, options?: ExecOptions) => {
        const result = await systemExec({
          packId: "music-shelf",
          command,
          options: options
            ? {
                cwd: options.cwd,
                env: options.env,
                timeoutMs: options.timeoutMs,
                input: options.input,
              }
            : undefined,
        });
        return {
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: result.stderr,
          durationMs: result.durationMs,
        };
      },
      spawn: () => {
        throw new Error("system.spawn is not yet implemented");
      },
      fs: {
        read: async () => {
          throw new Error("system.fs is not yet implemented");
        },
        write: async () => {
          throw new Error("system.fs is not yet implemented");
        },
        exists: async () => {
          throw new Error("system.fs is not yet implemented");
        },
      },
      notify: async () => {
        throw new Error("system.notify is not yet implemented");
      },
    },
    history: deps.history,
    log: { write: () => {}, tail: () => [], read: () => [] },
    memory: {
      persona: { get: () => undefined, set: () => {}, delete: () => {} },
      core: { get: () => undefined, set: () => {}, delete: () => {} },
    },
    terminal: { output: () => "", session: { pid: 0, cwd: "", startedAt: 0 } },
    charm: async () => {},
    signal: abortController.signal,
    resolveAsset: () => "",
  };

  const handlePromise = musicShelfPack.activate(ctx);

  handlePromise.then((handle) => {
    const registration = deps.registry.register({
      id: musicShelfPack.id,
      origin: "bundled",
      manifest: {
        id: musicShelfPack.id,
        type: "amenity",
        version: "0.1.0",
        charminalVersion: "^0.4.0",
        entry: "amenity.ts",
      },
      handle,
    });

    if (deps.defaultEnabled !== false) {
      deps.registry.enable(musicShelfPack.id);
    }

    abortController.signal.addEventListener("abort", () => {
      registration.dispose();
    });
  });

  return {
    dispose: () => {
      abortController.abort();
    },
  };
}
