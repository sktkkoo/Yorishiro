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
  /** ~/.charminal/ を ensure してから list_user_packs を呼ぶ関数。production は Tauri invoke で実装。 */
  readonly fetchPackEntries: () => Promise<ReadonlyArray<UserPackEntry>>;
  /** entryPath を asset URL に変換しつつ dynamic import する関数。 */
  readonly importModule: (entryPath: string) => Promise<unknown>;
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
 * Phase 1-a では effect と persona のみ register 先がある。voice / body /
 * scene は存在しないので skip + devLog に warn（design-record 「段階的に下ろす」）。
 */
const SUPPORTED_KINDS = new Set<string>(["effect", "persona"]);

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
 * TODO(phase-1-b): hot reload 導入時、register 結果の Disposable を保持して
 * 再 load 時に dispose する必要がある。現状は起動 1 回しか呼ばないので未対応。
 */
export async function loadUserPacks(deps: LoadUserPacksDeps): Promise<LoadUserPacksResult> {
  const { effectPackRunner, personaRegistry, devLog, fetchPackEntries, importModule } = deps;
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
  devLog.write({
    phase: "list",
    note: `discovered ${entries.length} user pack entr${entries.length === 1 ? "y" : "ies"}`,
  });

  for (const entry of entries) {
    if (!SUPPORTED_KINDS.has(entry.kind)) {
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
        effectPackRunner.register(pack);
        loaded.push({ id: entry.id, kind: entry.kind });
        devLog.write({ phase: "register", note: `registered effect '${pack.id}'` });
      } else if (entry.kind === "persona") {
        const pack = validatePersonaDefinition(def);
        try {
          personaRegistry.register(pack);
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

  return { loaded, failed };
}
