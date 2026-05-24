/**
 * User pack loader — Phase 1-a の static load。
 *
 * 起動時に一度だけ ~/.charminal/packs/ を scan し、見つかった entry を dynamic
 * import → validator で shape を確認 → 対応する registrar に register する。
 *
 * effect / persona / scene は Path A + BYOC 方針の `.js` entry。UI pack は
 * Plan 4 MVP で `ui.tsx` を runtime transpile できる。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-18-user-layer-runtime.md Section 「結論: Path A + BYOC」
 *
 * Tauri invoke と dynamic import() は runtime 依存なので、本 loader は dep
 * injection で受け取る。production では App.tsx 側で invoke + convertFileSrc
 * + native import を wrap して渡す。test では stub を渡して純粋に shape /
 * isolation だけ検証する。
 */

import type { EffectDefinition, PersonaDefinition } from "@charminal/sdk";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { SubsystemLog } from "../../core/dev-log";
import {
  PackValidationError,
  validateAmbientUiPackDefinition,
  validateAmenityDefinition,
  validateEffectDefinition,
  validatePersonaDefinition,
  validateUiPackDefinition,
} from "../../sdk/validators";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import type { AmenityPackRegistry } from "../amenity-pack-registry";
import type { PersonaEntry } from "../persona-registry";
import type { ScenePackRegistry } from "../scene-pack-registry";
import type { UiPackRegistry } from "../ui-pack-registry";
import { buildLoadReport, type LoadReport } from "./load-report";
import { validatePackExecutionPolicy } from "./pack-execution-policy";
import { applyPersonaDefaults } from "./persona-defaults";
import { injectPersonaPrompt } from "./persona-md-injection";
import { registerScenePack } from "./scene-pack-integration";
import { SUPPORTED_PACK_KINDS } from "./supported-kinds";
import type { UserPackRegistry } from "./user-pack-registry";

/** Rust 側 list_user_packs が返す entry 形（1 pack の 1 kind）。 */
export interface UserPackEntry {
  readonly id: string;
  readonly kind: string;
  readonly entryPath: string;
  readonly source?: "local" | "community" | "curated" | "bundled";
  readonly manifest?: {
    readonly id: string;
    readonly type: string;
    readonly entry: string;
    readonly executionClass?: string;
    readonly description?: string;
    readonly author?: string;
  };
}

/** EffectPackRunner が満たす最小構造。loader は dispose を保持しないが将来の hot reload で使う。 */
export interface EffectRegistrar {
  register(pack: EffectDefinition): { readonly dispose: () => void };
}

/**
 * PersonaRegistry が満たす最小構造。
 * persona single-active plan の PersonaRegistryInterface.register と同じ shape。
 * origin は loader が "user" で固定する。
 */
export interface PersonaRegistrar {
  register(entry: PersonaEntry): { readonly dispose: () => void };
}

export interface LoadUserPacksDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly scenePackRegistry: ScenePackRegistry;
  readonly uiPackRegistry?: UiPackRegistry;
  readonly ambientUiPackRegistry: AmbientUiPackRegistry;
  readonly amenityPackRegistry: AmenityPackRegistry;
  readonly devLog: SubsystemLog;
  /**
   * Hot-reload 用の idempotency 層。register 結果の Disposable をここに格納し、
   * 後続の load / watcher event で同 id+kind が再 register された際に旧登録を
   * dispose する。Phase 1-b で pitfall #8 / #9 を受ける隔壁（design-record
   * 2026-04-18-user-layer-runtime.md「Phase 1-b」Section B2）。
   */
  readonly packRegistry: UserPackRegistry;
  readonly personaDefaults?: PersonaDefinition;
  /** ~/.charminal/ を ensure してから list_user_packs を呼ぶ関数。production は Tauri invoke で実装。 */
  readonly fetchPackEntries: () => Promise<ReadonlyArray<UserPackEntry>>;
  /** entryPath を asset URL に変換しつつ dynamic import する関数。 */
  readonly importModule: (entryPath: string) => Promise<unknown>;
  /**
   * config.json の disabledPacks。同 id の全 kind を skip する。
   * 未指定なら空配列と同等（無効化無し）。
   */
  readonly disabledPacks?: ReadonlyArray<string>;
  /**
   * LoadReport を atomic に書き出す writer。未指定なら report write を skip
   * （test でも production でも pure fn は呼ぶので build のみは行う）。
   */
  readonly writeLoadReport?: (
    timestamp: string,
    safeMode: boolean,
    report: LoadReport,
  ) => Promise<void>;
  readonly timestamp?: string;
  readonly safeMode?: boolean;
}

export interface LoadedPackInfo {
  readonly id: string;
  readonly kind: string;
}

export interface FailedPackInfo {
  readonly id: string;
  readonly kind: string;
  readonly error: string;
}

export interface LoadUserPacksResult {
  readonly loaded: ReadonlyArray<LoadedPackInfo>;
  readonly failed: ReadonlyArray<FailedPackInfo>;
}

/**
 * `loadSingleUserPack` の依存。`loadUserPacks` が持つ list / disabled / report
 * といった「集合の面倒を見る」責務は含まず、単体 entry を import → validate →
 * register するのに必要なものだけを受け取る。
 *
 * Task 21: enable_pack から直接 re-register する経路を完成させるために、
 * loop body を helper として抽出した。
 */
export interface LoadSingleUserPackDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly scenePackRegistry: ScenePackRegistry;
  readonly uiPackRegistry?: UiPackRegistry;
  readonly ambientUiPackRegistry: AmbientUiPackRegistry;
  readonly amenityPackRegistry: AmenityPackRegistry;
  readonly packRegistry: UserPackRegistry;
  readonly devLog: SubsystemLog;
  readonly importModule: (entryPath: string) => Promise<unknown>;
  readonly personaDefaults?: PersonaDefinition;
}

/**
 * 単体 pack の load 結果。`loadUserPacks` が loaded / failed 配列に振り分ける
 * ときはこの status で分岐する。
 */
export type LoadSingleResult =
  | { readonly status: "loaded"; readonly id: string; readonly kind: string }
  | {
      readonly status: "failed";
      readonly id: string;
      readonly kind: string;
      readonly error: string;
    };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const extractDefault = (mod: unknown): unknown => {
  if (mod === null || typeof mod !== "object") return undefined;
  return (mod as { default?: unknown }).default;
};

/**
 * 単体 pack を import → validate → register する per-entry load logic。
 *
 * `loadUserPacks` の loop body をそのまま抽出したもの。dev-log への書き出し、
 * packRegistry 経由の dispose-then-register（pitfall #8 の隔壁）もここで行う。
 *
 * enable_pack MCP tool は `reloadSingleUserPack` 経由でこの helper を呼び、
 * config.json から id を除外したあとに runtime registry へ直接 register
 * し直す（Task 16 で flag した limitation を Task 21 で fix）。
 *
 * Internal design-record: 2026-04-18-user-layer-runtime.md Section B2
 */
export async function loadSingleUserPack(
  entry: UserPackEntry,
  deps: LoadSingleUserPackDeps,
): Promise<LoadSingleResult> {
  const {
    effectPackRunner,
    personaRegistry,
    scenePackRegistry,
    uiPackRegistry,
    ambientUiPackRegistry,
    amenityPackRegistry,
    packRegistry,
    personaDefaults,
    devLog,
    importModule,
  } = deps;

  if (!SUPPORTED_PACK_KINDS.has(entry.kind)) {
    const error = `unsupported kind '${entry.kind}'`;
    devLog.write({
      phase: "register",
      note: `skipping unsupported kind '${entry.kind}' for pack '${entry.id}'`,
    });
    return { status: "failed", id: entry.id, kind: entry.kind, error };
  }

  const policyError = validatePackExecutionPolicy(entry);
  if (policyError !== null) {
    devLog.write({
      phase: "policy",
      note: `blocked '${entry.id}' (${entry.kind}): ${policyError}`,
      data: { entryPath: entry.entryPath, source: entry.source ?? "local" },
    });
    return { status: "failed", id: entry.id, kind: entry.kind, error: policyError };
  }

  let mod: unknown;
  try {
    mod = await importModule(entry.entryPath);
  } catch (err) {
    const error = errorMessage(err);
    devLog.write({
      phase: "import",
      note: `dynamic import failed for '${entry.id}' (${entry.kind})`,
      data: { entryPath: entry.entryPath, error },
    });
    return { status: "failed", id: entry.id, kind: entry.kind, error };
  }

  const def = extractDefault(mod);
  if (def === undefined) {
    const error = "module has no default export";
    devLog.write({
      phase: "import",
      note: `${error} for '${entry.id}' (${entry.kind})`,
      data: { entryPath: entry.entryPath },
    });
    return { status: "failed", id: entry.id, kind: entry.kind, error };
  }

  try {
    if (entry.kind === "effect") {
      const pack = validateEffectDefinition(def);
      const handle = effectPackRunner.register(pack);
      packRegistry.register(entry.id, entry.kind, handle);
      devLog.write({ phase: "register", note: `registered effect '${pack.id}'` });
      return { status: "loaded", id: entry.id, kind: entry.kind };
    }
    if (entry.kind === "persona") {
      const personaDef = validatePersonaDefinition(def);

      // persona.md を fetch して thinking.systemPromptAddition に inject する。
      // .js 側で明示している場合は injectPersonaPrompt が no-op を返す。
      // 404 / fetch 失敗は「md 無し」として扱い load は継続する。
      const packDir = entry.entryPath.replace(/\/persona\.js$/, "");
      const mdUrl = convertFileSrc(`${packDir}/persona.md`);
      let mdText = "";
      try {
        const response = await fetch(mdUrl);
        if (response.ok) {
          mdText = await response.text();
        }
        // 404 = md 無し = OK（.js で thinking 明示している前提）
      } catch (err) {
        devLog.write({
          phase: "validate",
          note: `persona "${entry.id}": persona.md fetch failed (${
            err instanceof Error ? err.message : String(err)
          })`,
        });
      }
      const injected = applyPersonaDefaults(
        injectPersonaPrompt(personaDef, mdText),
        personaDefaults,
      );

      // PersonaRegistryImpl は user-over-bundled / user-over-user 衝突を
      // register 内で解決する。packRegistry 経由の dispose は
      // 「hot reload で同 id を再投入する場合の隔壁」として残す（pitfall #8）。
      if (packRegistry.has(entry.id, entry.kind)) {
        packRegistry.dispose(entry.id, entry.kind);
      }
      try {
        const personaEntry: PersonaEntry = {
          id: injected.id,
          manifest: {
            id: injected.id,
            type: "persona",
            version: "0.0.0",
            charminalVersion: "*",
            entry: "persona.js",
          },
          persona: injected,
          origin: "user",
          entryPath: entry.entryPath,
        };
        const handle = personaRegistry.register(personaEntry);
        packRegistry.register(entry.id, entry.kind, handle);
        devLog.write({ phase: "register", note: `registered persona '${injected.id}'` });
        return { status: "loaded", id: entry.id, kind: entry.kind };
      } catch (regErr) {
        const error = errorMessage(regErr);
        devLog.write({
          phase: "register",
          note: `persona register failed for '${injected.id}'`,
          data: { error },
        });
        return { status: "failed", id: entry.id, kind: entry.kind, error };
      }
    }
    if (entry.kind === "scene") {
      const sceneResult = await registerScenePack({
        id: entry.id,
        entryPath: entry.entryPath,
        def,
        packRegistry,
        scenePackRegistry,
        devLog,
        convertFileSrc,
        logPhase: { manifestError: "validate", register: "register" },
      });
      if (sceneResult.status === "failed") {
        return { status: "failed", id: entry.id, kind: entry.kind, error: sceneResult.error };
      }
      return { status: "loaded", id: entry.id, kind: entry.kind };
    }
    if (entry.kind === "ui") {
      if (uiPackRegistry === undefined) {
        throw new Error("UiPackRegistry is required to register UI packs");
      }
      const pack = validateUiPackDefinition(def);
      const handle = uiPackRegistry.register({
        id: pack.id,
        manifest: {
          id: pack.id,
          type: "ui",
          version: "0.0.0",
          charminalVersion: "*",
          entry: entry.entryPath.endsWith(".tsx") ? "ui.tsx" : "ui.js",
        },
        origin: "user",
        pack: {
          layout: pack.layout,
          mount: pack.mount,
        },
      });
      packRegistry.register(entry.id, entry.kind, handle);
      devLog.write({ phase: "register", note: `registered ui '${pack.id}'` });
      return { status: "loaded", id: entry.id, kind: entry.kind };
    }
    if (entry.kind === "ambient-ui") {
      const pack = validateAmbientUiPackDefinition(def);
      const handle = ambientUiPackRegistry.register({
        id: pack.id,
        origin: "user",
        manifest: {
          id: pack.id,
          type: "ambient-ui",
          version: "0.0.0",
          charminalVersion: "*",
          entry: entry.entryPath.endsWith(".tsx") ? "ui.tsx" : "ui.js",
        },
        pack: { mount: pack.mount },
      });
      packRegistry.register(entry.id, entry.kind, handle);
      devLog.write({ phase: "register", note: `registered ambient-ui '${pack.id}'` });
      return { status: "loaded", id: entry.id, kind: entry.kind };
    }
    if (entry.kind === "amenity") {
      const pack = validateAmenityDefinition(def);
      void amenityPackRegistry;
      devLog.write({
        phase: "register",
        note: `validated amenity '${pack.id}' (user amenity activate is deferred)`,
      });
      return { status: "loaded", id: entry.id, kind: entry.kind };
    }
    // SUPPORTED_PACK_KINDS に含まれるが分岐にない kind が来た場合の fallback。
    const error = `handler missing for kind '${entry.kind}'`;
    return { status: "failed", id: entry.id, kind: entry.kind, error };
  } catch (err) {
    const error = errorMessage(err);
    const phase = err instanceof PackValidationError ? "validate" : "register";
    devLog.write({
      phase,
      note: `${phase} failed for '${entry.id}' (${entry.kind})`,
      data: { error },
    });
    return { status: "failed", id: entry.id, kind: entry.kind, error };
  }
}

/**
 * Phase 1-a 段階の static loader。起動時に 1 回呼ぶ。
 *
 * 1 個の pack が落ちても loop は止めず、dev-log に痕跡を残して続行する。
 * 「姿の見えない pack が Charminal 本体を道連れにしない」は philosophy 側の要請
 * （docs/philosophy/CHARMINAL.md「壊さないこと」）と直結。
 *
 * 起動後の再 load（watcher からの reload 経由）でも同じ path を通る。register
 * 結果の Disposable は `packRegistry` に格納されるので、同 id+kind の前 entry
 * は自動で dispose される。
 */
export async function loadUserPacks(deps: LoadUserPacksDeps): Promise<LoadUserPacksResult> {
  const {
    effectPackRunner,
    personaRegistry,
    scenePackRegistry,
    uiPackRegistry,
    ambientUiPackRegistry,
    amenityPackRegistry,
    devLog,
    packRegistry,
    personaDefaults,
    fetchPackEntries,
    importModule,
    disabledPacks,
  } = deps;
  const loaded: LoadedPackInfo[] = [];
  const failed: FailedPackInfo[] = [];

  let entries: ReadonlyArray<UserPackEntry>;
  try {
    entries = await fetchPackEntries();
  } catch (err) {
    devLog.write({
      phase: "list",
      note: "failed to list user packs",
      data: { error: errorMessage(err) },
    });
    return { loaded, failed };
  }
  const disabled = disabledPacks ?? [];
  const filteredEntries =
    disabled.length > 0 ? entries.filter((e) => !disabled.includes(e.id)) : entries;
  if (filteredEntries.length !== entries.length) {
    const skipped = entries.length - filteredEntries.length;
    devLog.write({
      phase: "list",
      note: `filtered ${skipped} disabled pack entr${skipped === 1 ? "y" : "ies"}`,
      data: { disabledPacks: [...disabled] },
    });
  }
  devLog.write({
    phase: "list",
    note: `discovered ${filteredEntries.length} user pack entr${filteredEntries.length === 1 ? "y" : "ies"}`,
  });

  for (const entry of filteredEntries) {
    // Unsupported kind は failed にも loaded にも入れず「skipped」扱いにする
    // （Phase 1-a から続く既存 behaviour）。loadSingleUserPack は同 case で
    // failed を返すので、ここでは helper を通さず skip する。
    if (!SUPPORTED_PACK_KINDS.has(entry.kind)) {
      devLog.write({
        phase: "register",
        note: `skipping unsupported kind '${entry.kind}' for pack '${entry.id}'`,
      });
      continue;
    }

    const result = await loadSingleUserPack(entry, {
      effectPackRunner,
      personaRegistry,
      scenePackRegistry,
      uiPackRegistry,
      ambientUiPackRegistry,
      amenityPackRegistry,
      packRegistry,
      personaDefaults,
      devLog,
      importModule,
    });
    if (result.status === "loaded") {
      loaded.push({ id: result.id, kind: result.kind });
    } else {
      failed.push({ id: result.id, kind: result.kind, error: result.error });
    }
  }

  if (deps.writeLoadReport !== undefined) {
    const timestamp = deps.timestamp ?? new Date().toISOString();
    const safeMode = deps.safeMode ?? false;
    const report = buildLoadReport({
      timestamp,
      safeMode,
      result: { loaded, failed },
    });
    try {
      await deps.writeLoadReport(timestamp, safeMode, report);
    } catch (err) {
      devLog.write({
        phase: "register",
        note: "failed to write last-startup.json",
        data: { error: errorMessage(err) },
      });
    }
  }

  return { loaded, failed };
}
