/**
 * User pack watcher — Rust 側の `watch_charminal_layer` から file event を受けて
 * `packRegistry` と各 registrar を同期する hot-reload の主動脈。
 *
 * 純粋 logic（path parse / action mapping）は `watcher-logic.ts` に切り出して
 * vitest で検証しているので、本 module は Tauri invoke + dynamic import の
 * 組み立てに責任を限定する。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-b」Section B4
 */

import type { EffectDefinition, PersonaDefinition } from "@charminal/sdk";
import type { SubsystemLog } from "../../core/dev-log";
import { validateEffectDefinition, validatePersonaDefinition } from "../../sdk/validators";
import type { EffectRegistrar, PersonaRegistrar } from "./user-pack-loader";
import type { UserPackRegistry } from "./user-pack-registry";
import { type CharminalLayerEvent, mapEventToAction, type WatcherAction } from "./watcher-logic";

export interface StartPackWatcherDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly packRegistry: UserPackRegistry;
  readonly userPackLog: SubsystemLog;
  readonly initScriptLog: SubsystemLog;
}

export interface PackWatcherHandle {
  /** 現状の Tauri command は停止 API を持たないので noop だが、interface は保つ。 */
  readonly dispose: () => void;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const extractDefault = (mod: unknown): unknown => {
  if (mod === null || typeof mod !== "object") return undefined;
  return (mod as { default?: unknown }).default;
};

/**
 * watcher を張って event loop を開始する。`Promise` が resolve した時点で Rust
 * 側 watcher は起動済みで、以降の event は Channel 経由で受け取る。
 *
 * 起動失敗時は dev-log に痕跡を残して reject せず、noop handle を返す。watcher
 * が止まっていても Charminal 本体は動く——philosophy「壊さないこと」の典型適用。
 */
export async function startPackWatcher(deps: StartPackWatcherDeps): Promise<PackWatcherHandle> {
  const { invoke, convertFileSrc, Channel } = await import("@tauri-apps/api/core");

  let charminalHome: string;
  try {
    charminalHome = await invoke<string>("charminal_home_dir");
  } catch (err) {
    deps.userPackLog.write({
      phase: "watch",
      note: "failed to resolve ~/.charminal/ path; watcher disabled",
      data: { error: errorMessage(err) },
    });
    return { dispose: () => {} };
  }

  const channel = new Channel<CharminalLayerEvent>();
  channel.onmessage = (event) => {
    void handleLayerEvent(event, charminalHome, deps, { invoke, convertFileSrc });
  };

  try {
    await invoke("watch_charminal_layer", { onEvent: channel });
    deps.userPackLog.write({
      phase: "watch",
      note: `watching ${charminalHome}`,
    });
  } catch (err) {
    deps.userPackLog.write({
      phase: "watch",
      note: "watcher failed to start; hot reload disabled for this session",
      data: { error: errorMessage(err) },
    });
  }

  return { dispose: () => {} };
}

interface TauriBindings {
  readonly invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  readonly convertFileSrc: (filePath: string, protocol?: string) => string;
}

async function handleLayerEvent(
  event: CharminalLayerEvent,
  charminalHome: string,
  deps: StartPackWatcherDeps,
  tauri: TauriBindings,
): Promise<void> {
  const action = mapEventToAction(event, charminalHome);

  switch (action.type) {
    case "ignore":
      return;

    case "init-changed":
      // Phase 1-b では init.js の reload は扱わない。keydown listener などの
      // side effect が hot swap 経路を用意しないと leak するため、Phase 1-c で
      // 正面から設計する。ここでは存在だけ認知する。
      deps.initScriptLog.write({
        phase: "reload",
        note: "init.js changed; reload not supported in Phase 1-b",
        data: { path: action.path },
      });
      return;

    case "remove-pack": {
      if (!deps.packRegistry.has(action.id, action.kind)) {
        return;
      }
      deps.packRegistry.dispose(action.id, action.kind);
      deps.userPackLog.write({
        phase: "reload",
        note: `disposed ${action.kind} '${action.id}'`,
      });
      return;
    }

    case "reload-pack":
      await reloadPack(action, deps, tauri);
      return;
  }
}

async function reloadPack(
  action: Extract<WatcherAction, { type: "reload-pack" }>,
  deps: StartPackWatcherDeps,
  tauri: TauriBindings,
): Promise<void> {
  // ?v=<mtime> で engine の module registry を bust しないと、同じ URL で 2 度目
  // の import は cache hit を返す（pitfall #11）。watcher からの mtimeMs が 0
  // だった場合は stat_file_mtime で取り直す。
  let cacheKey = action.mtimeMs;
  if (cacheKey <= 0) {
    try {
      cacheKey = await tauri.invoke<number>("stat_file_mtime", { path: action.entryPath });
    } catch (err) {
      deps.userPackLog.write({
        phase: "reload",
        note: `failed to stat mtime for '${action.id}' (${action.kind})`,
        data: { entryPath: action.entryPath, error: errorMessage(err) },
      });
      return;
    }
  }

  const url = `${tauri.convertFileSrc(action.entryPath)}?v=${cacheKey}`;

  let mod: unknown;
  try {
    mod = await import(/* @vite-ignore */ url);
  } catch (err) {
    deps.userPackLog.write({
      phase: "reload",
      note: `dynamic import failed for '${action.id}' (${action.kind})`,
      data: { entryPath: action.entryPath, error: errorMessage(err) },
    });
    return;
  }

  const def = extractDefault(mod);
  if (def === undefined) {
    deps.userPackLog.write({
      phase: "reload",
      note: `module has no default export for '${action.id}' (${action.kind})`,
      data: { entryPath: action.entryPath },
    });
    return;
  }

  try {
    if (action.kind === "effect") {
      const pack: EffectDefinition = validateEffectDefinition(def);
      // 旧 Disposable を先に畳んでから新しい register を走らせる。registry.register
      // 内部でも prev dispose が走るが、register の失敗（persona で duplicate
      // throw 等）を早く検知できるように先出しする。
      deps.packRegistry.dispose(action.id, action.kind);
      const handle = deps.effectPackRunner.register(pack);
      deps.packRegistry.register(action.id, action.kind, handle);
      deps.userPackLog.write({
        phase: "reload",
        note: `re-registered effect '${pack.id}'`,
      });
    } else if (action.kind === "persona") {
      const pack: PersonaDefinition = validatePersonaDefinition(def);
      deps.packRegistry.dispose(action.id, action.kind);
      const handle = deps.personaRegistry.register(pack);
      deps.packRegistry.register(action.id, action.kind, handle);
      deps.userPackLog.write({
        phase: "reload",
        note: `re-registered persona '${pack.id}'`,
      });
    }
  } catch (err) {
    deps.userPackLog.write({
      phase: "reload",
      note: `reload failed for '${action.id}' (${action.kind})`,
      data: { error: errorMessage(err) },
    });
  }
}
