/**
 * Production-side wiring for loadUserPacks / loadInitScript.
 *
 * 本 module は Tauri invoke + convertFileSrc + native import() を実際に叩く
 * wrapper。pure logic 側（user-pack-loader.ts / init-script.ts）は dep
 * injection で受け取る pattern を保つので、ここは純粋な配線のみ。
 *
 * Test はしない——Tauri invoke と dynamic import は vitest で mock する
 * value が無く、Phase 1-a では配線の正しさは起動時の dev-log で目視確認する。
 */

import type { SubsystemLog } from "../../core/dev-log";
import { type LoadInitScriptResult, loadInitScript } from "./init-script";
import {
  type EffectRegistrar,
  type LoadUserPacksResult,
  loadUserPacks,
  type PersonaRegistrar,
  type UserPackEntry,
} from "./user-pack-loader";

export interface LoadUserLayerDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly userPackLog: SubsystemLog;
  readonly initScriptLog: SubsystemLog;
}

export interface LoadUserLayerResult {
  readonly packs: LoadUserPacksResult;
  readonly init: LoadInitScriptResult;
}

/**
 * ~/.charminal/ の pack と init.js を一度に読み込む。起動時に 1 回だけ呼ぶ。
 *
 * pack → init の順で実行する。init script からは既に register された pack が
 * 見える（現状 API では直接参照できないが、将来の拡張で registry 照会を追加
 * する場合の先送り）。
 */
export async function loadUserLayer(deps: LoadUserLayerDeps): Promise<LoadUserLayerResult> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");

  const packs = await loadUserPacks({
    effectPackRunner: deps.effectPackRunner,
    personaRegistry: deps.personaRegistry,
    devLog: deps.userPackLog,
    fetchPackEntries: async () => {
      await invoke("ensure_charminal_dirs");
      return invoke<UserPackEntry[]>("list_user_packs");
    },
    importModule: async (entryPath) => {
      const url = convertFileSrc(entryPath);
      return await import(/* @vite-ignore */ url);
    },
  });

  const init = await loadInitScript({
    effectPackRunner: deps.effectPackRunner,
    personaRegistry: deps.personaRegistry,
    devLog: deps.initScriptLog,
    fetchInitScriptPath: () => invoke<string | null>("user_init_script_path"),
    importModule: async (path) => {
      const url = convertFileSrc(path);
      return await import(/* @vite-ignore */ url);
    },
  });

  return { packs, init };
}
