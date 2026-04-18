/**
 * Production-side wiring for loadUserPacks / loadInitScript / startPackWatcher.
 *
 * 本 module は Tauri invoke + convertFileSrc + native import() を実際に叩く
 * wrapper。pure logic 側（user-pack-loader.ts / init-script.ts / watcher-logic.ts）
 * は dep injection で受け取る pattern を保つので、ここは純粋な配線のみ。
 *
 * Test はしない——Tauri invoke と dynamic import は vitest で mock する
 * value が無く、配線の正しさは起動時の dev-log で目視確認する。
 *
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-a / 1-b」
 */

import type { SubsystemLog } from "../../core/dev-log";
import { type EffectRequester, type LoadInitScriptResult, loadInitScript } from "./init-script";
import {
  type EffectRegistrar,
  type LoadUserPacksResult,
  loadUserPacks,
  type PersonaRegistrar,
  type UserPackEntry,
} from "./user-pack-loader";
import type { UserPackRegistry } from "./user-pack-registry";
import { type PackWatcherHandle, startPackWatcher } from "./watcher";

export interface LoadUserLayerDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly effectDispatcher: EffectRequester;
  readonly packRegistry: UserPackRegistry;
  readonly userPackLog: SubsystemLog;
  readonly initScriptLog: SubsystemLog;
}

export interface LoadUserLayerResult {
  readonly packs: LoadUserPacksResult;
  readonly init: LoadInitScriptResult;
  readonly watcher: PackWatcherHandle;
}

/**
 * ~/.charminal/ の pack と init.js を一度に読み込み、file watcher を起動する。
 * 起動時に 1 回だけ呼ぶ。
 *
 * 順序は「pack → init → watcher」。init script が実行された後に watcher を
 * 張るので、init 中に作られた register は watcher 経由の reload path を通らない
 * ことが保証される。
 */
export async function loadUserLayer(deps: LoadUserLayerDeps): Promise<LoadUserLayerResult> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");

  // ?v=<mtime> を URL に混ぜて engine の module registry cache を毎回 bust する
  // （pitfall #11）。mtime の取得に失敗したときは base URL に fallback ——
  // 初回 load では cache hit の影響はないため、落とすより続ける方がよい。
  const buildCacheBustUrl = async (path: string): Promise<string> => {
    const base = convertFileSrc(path);
    try {
      const mtime = await invoke<number>("stat_file_mtime", { path });
      return `${base}?v=${mtime}`;
    } catch {
      return base;
    }
  };

  const packs = await loadUserPacks({
    effectPackRunner: deps.effectPackRunner,
    personaRegistry: deps.personaRegistry,
    packRegistry: deps.packRegistry,
    devLog: deps.userPackLog,
    fetchPackEntries: async () => {
      await invoke("ensure_charminal_dirs");
      return invoke<UserPackEntry[]>("list_user_packs");
    },
    importModule: async (entryPath) => {
      const url = await buildCacheBustUrl(entryPath);
      return await import(/* @vite-ignore */ url);
    },
  });

  const init = await loadInitScript({
    effectPackRunner: deps.effectPackRunner,
    personaRegistry: deps.personaRegistry,
    effectDispatcher: deps.effectDispatcher,
    devLog: deps.initScriptLog,
    fetchInitScriptPath: () => invoke<string | null>("user_init_script_path"),
    importModule: async (path) => {
      const url = await buildCacheBustUrl(path);
      return await import(/* @vite-ignore */ url);
    },
  });

  const watcher = await startPackWatcher({
    effectPackRunner: deps.effectPackRunner,
    personaRegistry: deps.personaRegistry,
    packRegistry: deps.packRegistry,
    userPackLog: deps.userPackLog,
    initScriptLog: deps.initScriptLog,
  });

  return { packs, init, watcher };
}
