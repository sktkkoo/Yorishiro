/**
 * User pack loader — Phase 1-a の static load。
 *
 * 起動時に一度だけ ~/.charminal/packs/ を scan し、見つかった `.js` を dynamic
 * import → validator で shape を確認 → 対応する registrar に register する。
 *
 * Path A + BYOC 方針なので、user の TS → JS transpile は Charminal 側では行わ
 * ない。loader が見るのは `.js` のみ（Rust の list_user_packs が返す entryPath
 * もすべて絶対パスの `.js`）。
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
import type { SubsystemLog } from "../../core/dev-log";
import {
  PackValidationError,
  validateEffectDefinition,
  validatePersonaDefinition,
} from "../../sdk/validators";
import { buildLoadReport, type LoadReport } from "./load-report";
import { SUPPORTED_PACK_KINDS } from "./supported-kinds";
import type { UserPackRegistry } from "./user-pack-registry";

/** Rust 側 list_user_packs が返す entry 形（1 pack の 1 kind）。 */
export interface UserPackEntry {
  readonly id: string;
  readonly kind: string;
  readonly entryPath: string;
}

/** EffectPackRunner が満たす最小構造。loader は dispose を保持しないが将来の hot reload で使う。 */
export interface EffectRegistrar {
  register(pack: EffectDefinition): { readonly dispose: () => void };
}

/** PersonaRegistry が満たす最小構造。 */
export interface PersonaRegistrar {
  register(def: PersonaDefinition): { readonly dispose: () => void };
}

export interface LoadUserPacksDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly devLog: SubsystemLog;
  /**
   * Hot-reload 用の idempotency 層。register 結果の Disposable をここに格納し、
   * 後続の load / watcher event で同 id+kind が再 register された際に旧登録を
   * dispose する。Phase 1-b で pitfall #8 / #9 を受ける隔壁（design-record
   * 2026-04-18-user-layer-runtime.md「Phase 1-b」Section B2）。
   */
  readonly packRegistry: UserPackRegistry;
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

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const extractDefault = (mod: unknown): unknown => {
  if (mod === null || typeof mod !== "object") return undefined;
  return (mod as { default?: unknown }).default;
};

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
    devLog,
    packRegistry,
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
    if (!SUPPORTED_PACK_KINDS.has(entry.kind)) {
      devLog.write({
        phase: "register",
        note: `skipping unsupported kind '${entry.kind}' for pack '${entry.id}'`,
      });
      continue;
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
      failed.push({ id: entry.id, kind: entry.kind, error });
      continue;
    }

    const def = extractDefault(mod);
    if (def === undefined) {
      const error = "module has no default export";
      devLog.write({
        phase: "import",
        note: `${error} for '${entry.id}' (${entry.kind})`,
        data: { entryPath: entry.entryPath },
      });
      failed.push({ id: entry.id, kind: entry.kind, error });
      continue;
    }

    try {
      if (entry.kind === "effect") {
        const pack = validateEffectDefinition(def);
        const handle = effectPackRunner.register(pack);
        packRegistry.register(entry.id, entry.kind, handle);
        loaded.push({ id: entry.id, kind: entry.kind });
        devLog.write({ phase: "register", note: `registered effect '${pack.id}'` });
      } else if (entry.kind === "persona") {
        const pack = validatePersonaDefinition(def);
        // PersonaRegistry は duplicate id で throw するので、loader 層では事前に
        // 前登録を dispose しておく（pitfall #8）。hot reload で watcher が同 id
        // を再投入する場合もこの経路を通る。
        if (packRegistry.has(entry.id, entry.kind)) {
          packRegistry.dispose(entry.id, entry.kind);
        }
        try {
          const handle = personaRegistry.register(pack);
          packRegistry.register(entry.id, entry.kind, handle);
          loaded.push({ id: entry.id, kind: entry.kind });
          devLog.write({ phase: "register", note: `registered persona '${pack.id}'` });
        } catch (regErr) {
          const error = errorMessage(regErr);
          devLog.write({
            phase: "register",
            note: `persona register failed for '${pack.id}'`,
            data: { error },
          });
          failed.push({ id: entry.id, kind: entry.kind, error });
        }
      }
    } catch (err) {
      const error = errorMessage(err);
      const phase = err instanceof PackValidationError ? "validate" : "register";
      devLog.write({
        phase,
        note: `${phase} failed for '${entry.id}' (${entry.kind})`,
        data: { error },
      });
      failed.push({ id: entry.id, kind: entry.kind, error });
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
