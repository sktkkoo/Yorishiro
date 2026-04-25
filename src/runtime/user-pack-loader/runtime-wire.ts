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
import type { PersonaDefinition } from "../../sdk/persona";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import type { ScenePackRegistry } from "../scene-pack-registry";
import type { UiPackRegistry } from "../ui-pack-registry";
import { fetchSafeModeFlag, readCharminalConfigText, writeLastStartupReport } from "./charminal-io";
import { parseConfig } from "./config";
import { type EffectRequester, type LoadInitScriptResult, loadInitScript } from "./init-script";
import {
  type EffectRegistrar,
  type LoadUserPacksResult,
  loadSingleUserPack,
  loadUserPacks,
  type PersonaRegistrar,
  type UserPackEntry,
} from "./user-pack-loader";
import type { UserPackRegistry } from "./user-pack-registry";
import { type PackWatcherHandle, startPackWatcher } from "./watcher";

export interface LoadUserLayerDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly scenePackRegistry: ScenePackRegistry;
  readonly uiPackRegistry: UiPackRegistry;
  readonly ambientUiPackRegistry: AmbientUiPackRegistry;
  readonly effectDispatcher: EffectRequester;
  readonly emitEvent?: (name: string, payload?: unknown) => void;
  readonly packRegistry: UserPackRegistry;
  readonly personaDefaults?: PersonaDefinition;
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
  const importUserPackModule = async (entryPath: string): Promise<unknown> => {
    if (entryPath.endsWith(".tsx")) {
      const { importUiTsxEntry } = await import("./tsx-transpiler");
      const cacheKey = await invoke<number>("stat_file_mtime", { path: entryPath }).catch(
        () => undefined,
      );
      return importUiTsxEntry(entryPath, { convertFileSrc }, { cacheKey });
    }
    const url = await buildCacheBustUrl(entryPath);
    return await import(/* @vite-ignore */ url);
  };

  let packs: LoadUserPacksResult;
  if (safeMode) {
    packs = { loaded: [], failed: [] };
  } else {
    packs = await loadUserPacks({
      effectPackRunner: deps.effectPackRunner,
      personaRegistry: deps.personaRegistry,
      scenePackRegistry: deps.scenePackRegistry,
      uiPackRegistry: deps.uiPackRegistry,
      ambientUiPackRegistry: deps.ambientUiPackRegistry,
      packRegistry: deps.packRegistry,
      personaDefaults: deps.personaDefaults,
      devLog: deps.userPackLog,
      disabledPacks: config.disabledPacks,
      fetchPackEntries: async () => {
        await invoke("ensure_charminal_dirs");
        return invoke<UserPackEntry[]>("list_user_packs");
      },
      importModule: importUserPackModule,
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
        personaDefaults: deps.personaDefaults,
        effectDispatcher: deps.effectDispatcher,
        emitEvent: deps.emitEvent,
        devLog: deps.initScriptLog,
        setActiveUi: (id) => deps.uiPackRegistry.setActiveUi(id),
        fetchInitScriptPath: () => invoke<string | null>("user_init_script_path"),
        importModule: async (path) => {
          const url = await buildCacheBustUrl(path);
          return await import(/* @vite-ignore */ url);
        },
      });

  const watcher = await startPackWatcher({
    effectPackRunner: deps.effectPackRunner,
    personaRegistry: deps.personaRegistry,
    scenePackRegistry: deps.scenePackRegistry,
    uiPackRegistry: deps.uiPackRegistry,
    ambientUiPackRegistry: deps.ambientUiPackRegistry,
    packRegistry: deps.packRegistry,
    personaDefaults: deps.personaDefaults,
    userPackLog: deps.userPackLog,
    initScriptLog: deps.initScriptLog,
  });

  return { packs, init, watcher, safeMode };
}

export interface ReloadSingleUserPackDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly scenePackRegistry: ScenePackRegistry;
  readonly uiPackRegistry: UiPackRegistry;
  readonly ambientUiPackRegistry: AmbientUiPackRegistry;
  readonly packRegistry: UserPackRegistry;
  readonly personaDefaults?: PersonaDefinition;
  readonly userPackLog: SubsystemLog;
}

/**
 * 単体 pack を file system から再 load する。enable_pack MCP tool や
 * 将来の手動 reload 経路から呼ばれる。
 *
 * list_user_packs で該当 id を探し、見つかれば cache-bust import 経路を
 * 通して register する。見つからなければ {ok: false, reason} を返す。
 *
 * Task 16 で reloadPack は file 存在確認しか行わない最小実装だったため、
 * disable → enable の後に runtime registry に pack が戻らない limitation
 * があった。Task 21 でこの helper を介して直接 register する経路を完成
 * させた（`loadSingleUserPack` を共用）。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.6
 */
export async function reloadSingleUserPack(
  id: string,
  deps: ReloadSingleUserPackDeps,
): Promise<{ ok: boolean; reason?: string }> {
  const { invoke, convertFileSrc } = await import("@tauri-apps/api/core");

  const buildCacheBustUrl = async (path: string): Promise<string> => {
    const base = convertFileSrc(path);
    try {
      const mtime = await invoke<number>("stat_file_mtime", { path });
      return `${base}?v=${mtime}`;
    } catch {
      return base;
    }
  };
  const importUserPackModule = async (entryPath: string): Promise<unknown> => {
    if (entryPath.endsWith(".tsx")) {
      const { importUiTsxEntry } = await import("./tsx-transpiler");
      const cacheKey = await invoke<number>("stat_file_mtime", { path: entryPath }).catch(
        () => undefined,
      );
      return importUiTsxEntry(entryPath, { convertFileSrc }, { cacheKey });
    }
    const url = await buildCacheBustUrl(entryPath);
    return await import(/* @vite-ignore */ url);
  };

  let entries: UserPackEntry[];
  try {
    entries = await invoke<UserPackEntry[]>("list_user_packs");
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  const match = entries.find((e) => e.id === id);
  if (!match) {
    return { ok: false, reason: "pack file not found" };
  }

  const result = await loadSingleUserPack(match, {
    effectPackRunner: deps.effectPackRunner,
    personaRegistry: deps.personaRegistry,
    scenePackRegistry: deps.scenePackRegistry,
    uiPackRegistry: deps.uiPackRegistry,
    ambientUiPackRegistry: deps.ambientUiPackRegistry,
    packRegistry: deps.packRegistry,
    personaDefaults: deps.personaDefaults,
    devLog: deps.userPackLog,
    importModule: importUserPackModule,
  });

  if (result.status === "failed") {
    return { ok: false, reason: result.error };
  }
  return { ok: true };
}
