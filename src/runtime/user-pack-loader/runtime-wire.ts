/**
 * Production-side wiring for loadUserPacks / loadInitScript / startPackWatcher.
 *
 * Tauri invoke + convertFileSrc + native import() を実際に叩く wrapper。
 * pure logic 側は dep injection で受け取る pattern を保ち、ここは配線のみ。
 *
 * Phase 1-c 追加：
 * - 起動時 safe-mode 判定 → true なら pack discovery を skip、last-startup.json も
 *   上書きしない（= 前回通常起動時の snapshot を保持）
 * - config.json の disabledPacks を loadUserPacks に渡す
 * - loadUserPacks 末尾で LoadReport を last-startup.json に atomic write
 *
 * Test はしない——Tauri invoke と dynamic import は vitest で mock する
 * value が無く、配線の正しさは起動時の dev-log で目視確認する。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 5
 */

import type { SubsystemLog } from "../../core/dev-log";
import { fetchSafeModeFlag, readCharminalConfigText, writeLastStartupReport } from "./charminal-io";
import { parseConfig } from "./config";
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
  readonly safeMode: boolean;
}

/**
 * ~/.charminal/ の pack と init.js を一度に読み込み、file watcher を起動する。
 * 起動時に 1 回だけ呼ぶ。
 *
 * 順序は「safe-mode 判定 → config 読み込み → pack → init → watcher」。
 * safe-mode 時は pack / init を skip し last-startup.json を触らない
 * （= 前回通常起動時の snapshot を保持し、rescue 経路で読める状態を守る）。
 */
export async function loadUserLayer(deps: LoadUserLayerDeps): Promise<LoadUserLayerResult> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");

  const safeMode = await fetchSafeModeFlag().catch(() => false);
  if (safeMode) {
    deps.userPackLog.write({
      phase: "list",
      note: "CHARMINAL_SAFE_MODE=1 detected — skipping user pack discovery and init.js",
    });
  }

  const configText = await readCharminalConfigText();
  const config = parseConfig(configText);

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

  let packs: LoadUserPacksResult;
  if (safeMode) {
    packs = { loaded: [], failed: [] };
  } else {
    packs = await loadUserPacks({
      effectPackRunner: deps.effectPackRunner,
      personaRegistry: deps.personaRegistry,
      packRegistry: deps.packRegistry,
      devLog: deps.userPackLog,
      disabledPacks: config.disabledPacks,
      fetchPackEntries: async () => {
        await invoke("ensure_charminal_dirs");
        return invoke<UserPackEntry[]>("list_user_packs");
      },
      importModule: async (entryPath) => {
        const url = await buildCacheBustUrl(entryPath);
        return await import(/* @vite-ignore */ url);
      },
      writeLoadReport: async (_timestamp, _safeMode, report) => {
        await writeLastStartupReport(`${JSON.stringify(report, null, 2)}\n`);
      },
      timestamp: new Date().toISOString(),
      safeMode: false,
    });
  }

  // safe-mode 時は LoadInitScriptResult の「skip」相当として { ran: false } を返す。
  // LoadInitScriptResult は { ran: boolean; error?: string } なので literal で足りる。
  const init: LoadInitScriptResult = safeMode
    ? { ran: false }
    : await loadInitScript({
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

  return { packs, init, watcher, safeMode };
}
