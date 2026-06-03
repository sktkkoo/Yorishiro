import type { AmenityContext, AmenityPackDefinition, HistoryAPI } from "@charminal/sdk";
import type { TweenManager } from "../../core/tween/tween-manager";
import type { AmenityPackRegistry } from "../amenity-pack-registry";

/** user amenity の activate に渡す AmenityContext を組む factory。 */
export type AmenityContextFactory = (input: {
  readonly packId: string;
  readonly signal: AbortSignal;
}) => AmenityContext;

export interface UserAmenityContextDeps {
  readonly tweenManager: TweenManager;
  /**
   * synthetic event を投入する。第 1 引数に発火元 pack id を取る。
   * EventBus は source をそのまま stamp するので、全 amenity が同じ source に
   * 潰れないよう実 pack id（registryId）を閉じ込める。
   */
  readonly emitEvent: (packId: string, name: string, payload?: unknown) => void;
  readonly history: HistoryAPI;
}

/**
 * user amenity 用の AmenityContext factory。bundled pomodoro と同じ stub レベル
 * （system/log/memory/terminal/charm は stub、time/tween/emitEvent/history/signal
 * は実体）。tween key は packId で namespace する。
 */
export function createUserAmenityContextFactory(
  deps: UserAmenityContextDeps,
): AmenityContextFactory {
  return ({ packId, signal }) => ({
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
    // amenity に persona は無い。発火元の識別は emitEvent の source stamp 側で行う。
    persona: { id: "", name: "" },
    // 発火元 pack id（packId = registryId）を閉じ込めて EventBus に渡す。
    emitEvent: (name, payload) => deps.emitEvent(packId, name, payload),
    tween: {
      start: (key, to, durationMs, apply, options) =>
        deps.tweenManager.start(`${packId}:${key}`, to, durationMs, apply, options),
      startVec3: (key, to, durationMs, apply, options) =>
        deps.tweenManager.startVec3(`${packId}:${key}`, to, durationMs, apply, options),
      cancel: (key) => deps.tweenManager.cancel(`${packId}:${key}`),
    },
    system: {} as AmenityContext["system"],
    log: { write: () => {}, tail: () => [], read: () => [] },
    memory: {
      persona: { get: () => undefined, set: () => {}, delete: () => {} },
      core: { get: () => undefined, set: () => {}, delete: () => {} },
    },
    terminal: { output: () => "", session: { pid: 0, cwd: "", startedAt: 0 } },
    charm: async () => {},
    signal,
    history: deps.history,
  });
}

/** packRegistry の register だけを構造的に要求する（cross-import 回避）。 */
interface AmenityDisposableSink {
  register(id: string, kind: string, disposable: { dispose(): void }): void;
}

export interface ActivateAndRegisterAmenityArgs {
  /**
   * discovery / directory id（`packs/<registryId>/`）。runtime の正準 id。
   * disable / remove / reload はこの id で動くので、amenityPackRegistry と
   * packRegistry の登録キー・ctx.packId・emitEvent source を全てこれで揃える
   * （export default の `def.id` とは独立）。
   */
  readonly registryId: string;
  readonly def: AmenityPackDefinition;
  readonly entryPath: string;
  readonly amenityPackRegistry: AmenityPackRegistry;
  readonly packRegistry: AmenityDisposableSink;
  readonly createAmenityContext: AmenityContextFactory;
}

/**
 * user amenity を activate → registry.register + enable → packRegistry に dispose
 * 格納。loader（起動 load / enable_pack）と watcher（hot-reload）の両方から呼ぶ。
 * 同 registryId+kind の再登録時は packRegistry.register が旧 disposable を auto-dispose。
 *
 * dispose は registration.dispose() に一本化する。AmenityPackRegistryImpl.register()
 * が返す Disposable は内部で entry.handle.dispose() を呼ぶので、ここで重ねて
 * handle.dispose() を呼ぶと二重 dispose になる。signal の abort だけ別途行う。
 */
export async function activateAndRegisterAmenity(
  args: ActivateAndRegisterAmenityArgs,
): Promise<void> {
  const { registryId, def, entryPath, amenityPackRegistry, packRegistry, createAmenityContext } =
    args;
  const abort = new AbortController();
  const ctx = createAmenityContext({ packId: registryId, signal: abort.signal });
  const handle = await def.activate(ctx);
  const registration = amenityPackRegistry.register({
    id: registryId,
    origin: "user",
    manifest: {
      id: def.id,
      name: def.name,
      type: "amenity",
      version: "0.0.0",
      charminalVersion: "*",
      entry: entryPath.endsWith(".tsx") ? "amenity.tsx" : "amenity.js",
    },
    handle,
  });
  amenityPackRegistry.enable(registryId);
  packRegistry.register(registryId, "amenity", {
    dispose: () => {
      abort.abort();
      registration.dispose();
    },
  });
}
