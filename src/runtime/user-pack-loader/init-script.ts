/**
 * User init.js runner — Emacs の `init.el` 相当。
 *
 * 起動時に ~/.charminal/init.js があれば dynamic import して default 関数を
 * 実行する。default は CharminalInitContext を受け取って、その上で register*
 * を呼ぶ形。loader は validator を内部で通してから registrar に渡すので、
 * user 側は型違反だと PackValidationError を受け取る（init 内で catch しなければ
 * 上まで伝播し、init は failed として記録される）。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-a: 最小限の user pack load」
 */

import type { EffectDefinition, PersonaDefinition, SpaceEffectRequest } from "@charminal/sdk";
import type { SubsystemLog } from "../../core/dev-log";
import { validateEffectDefinition, validatePersonaDefinition } from "../../sdk/validators";
import type { PersonaEntry } from "../persona-registry";
import { applyPersonaDefaults } from "./persona-defaults";
import type { EffectRegistrar, PersonaRegistrar } from "./user-pack-loader";

/**
 * EffectDispatcher が満たす最小構造。dispatchEffect 経由で init.js が自発的に
 * effect を発火できる——persona の reflex 経路とは別の、「user が押したから走る」
 * 起動パス。philosophy「触れるものと、触れないもの」の user surface を広げる。
 */
export interface EffectRequester {
  dispatch(request: SpaceEffectRequest): unknown;
}

/**
 * init.js の default 関数に渡される context。
 *
 * - registerEffect / registerPersona: pack を Charminal に提出する。validator を
 *   内部で通す契約なので、型を外れた値を渡すと synchronously throw する。
 * - dispatchEffect: 既に register 済みの effect を 1 回走らせる。keyboard
 *   shortcut や startup animation など、persona の reflex 外の発火経路で使う。
 * - setActiveUi: keyboard shortcut などから active UI pack を切り替える。
 */
export interface CharminalInitContext {
  registerEffect(pack: EffectDefinition): void;
  registerPersona(pack: PersonaDefinition): void;
  dispatchEffect(request: SpaceEffectRequest): void;
  setActiveUi(id: string | null): void;
}

export interface LoadInitScriptDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly devLog: SubsystemLog;
  readonly effectDispatcher: EffectRequester;
  readonly personaDefaults?: PersonaDefinition;
  readonly setActiveUi?: (id: string | null) => void;
  /**
   * Tauri の user_init_script_path を叩いて init.js の absolute path を返す。
   * 見つからなければ null。
   */
  readonly fetchInitScriptPath: () => Promise<string | null>;
  readonly importModule: (path: string) => Promise<unknown>;
}

export interface LoadInitScriptResult {
  /** default() が throw せずに最後まで走ったか。 */
  readonly ran: boolean;
  /** ran が false のとき、理由を説明する文字列。 */
  readonly error?: string;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const extractDefault = (mod: unknown): unknown => {
  if (mod === null || typeof mod !== "object") return undefined;
  return (mod as { default?: unknown }).default;
};

const makeInitContext = (deps: LoadInitScriptDeps): CharminalInitContext => ({
  registerEffect(pack) {
    const validated = validateEffectDefinition(pack);
    deps.effectPackRunner.register(validated);
  },
  registerPersona(pack) {
    const validated = validatePersonaDefinition(pack);
    const withDefaults = applyPersonaDefaults(validated, deps.personaDefaults);
    const entry: PersonaEntry = {
      id: withDefaults.id,
      manifest: {
        id: withDefaults.id,
        type: "persona",
        version: "0.0.0",
        charminalVersion: "*",
        entry: "persona.js",
      },
      persona: withDefaults,
      origin: "user",
    };
    deps.personaRegistry.register(entry);
  },
  dispatchEffect(request) {
    deps.effectDispatcher.dispatch(request);
  },
  setActiveUi(id) {
    if (deps.setActiveUi === undefined) {
      throw new Error("setActiveUi is not available in this runtime");
    }
    deps.setActiveUi(id);
  },
});

/**
 * 起動時に 1 回呼ぶ。loadUserPacks の後で呼ぶことを想定——init.js 側から
 * pack を追加 register できるようにするため。
 *
 * init.js が無い / import に失敗 / default が function でない / default が
 * throw する、いずれのケースも Charminal 本体を落とさず dev-log に痕跡を残して
 * 続行する（philosophy「壊さないこと」）。
 */
export async function loadInitScript(deps: LoadInitScriptDeps): Promise<LoadInitScriptResult> {
  const { devLog, fetchInitScriptPath, importModule } = deps;

  let path: string | null;
  try {
    path = await fetchInitScriptPath();
  } catch (err) {
    const error = errorMessage(err);
    devLog.write({ phase: "locate", note: "failed to locate init.js", data: { error } });
    return { ran: false, error };
  }

  if (path === null) {
    devLog.write({ phase: "locate", note: "no init.js present" });
    return { ran: false };
  }

  devLog.write({ phase: "locate", note: "found init.js", data: { path } });

  let mod: unknown;
  try {
    mod = await importModule(path);
  } catch (err) {
    const error = errorMessage(err);
    devLog.write({ phase: "import", note: "init.js import failed", data: { path, error } });
    return { ran: false, error };
  }

  const def = extractDefault(mod);
  if (typeof def !== "function") {
    const error = "init.js default export is not a function";
    devLog.write({ phase: "import", note: error, data: { path } });
    return { ran: false, error };
  }

  const ctx = makeInitContext(deps);
  try {
    // user's default may be sync or async. Await always — Promise.resolve wraps
    // plain returns and keeps synchronous throws catchable in the same block.
    await (def as (ctx: CharminalInitContext) => unknown)(ctx);
  } catch (err) {
    const error = errorMessage(err);
    devLog.write({ phase: "run", note: "init.js default threw", data: { error } });
    return { ran: false, error };
  }

  devLog.write({ phase: "run", note: "init.js completed" });
  return { ran: true };
}
