/**
 * User init.js runner — Emacs の `init.el` 相当。
 *
 * 起動時に ~/.charminal/init.js があれば dynamic import して default 関数を
 * 実行する。default は CharminalInitContext を受け取って、その上で register*
 * を呼ぶ形。loader は validator を内部で通してから registrar に渡すので、
 * user 側は型違反だと PackValidationError を受け取る（init 内で catch しなければ
 * 上まで伝播し、init は failed として記録される）。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「生きた系」
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-a: 最小限の user pack load」
 */

import type {
  EffectDefinition,
  PersonaDefinition,
  SpaceEffectRequest,
  TweenAPI,
} from "@charminal/sdk";
import type { SubsystemLog } from "../../core/dev-log";
import type { TweenManager } from "../../core/tween/tween-manager";
import { validateEffectDefinition, validatePersonaDefinition } from "../../sdk/validators";
import type { PersonaEntry } from "../persona-registry";
import { type InitDisposable, InitScope, type InitShortcutSpec, matchShortcut } from "./init-scope";
import { applyPersonaDefaults } from "./persona-defaults";
import type { EffectRegistrar, PersonaRegistrar } from "./user-pack-loader";

/**
 * EffectDispatcher が満たす最小構造。dispatchEffect 経由で init.js が自発的に
 * effect を発火できる——persona の reflex 経路とは別の、「user が押したから走る」
 * 起動パス。philosophy「生きた系」の user surface を広げる。
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
 * - emitEvent: persona / amenity trigger loop に synthetic event を流す。
 * - setActiveUi: keyboard shortcut などから active UI pack を切り替える。
 */
export interface CharminalInitContext {
  registerEffect(pack: EffectDefinition): void;
  registerPersona(pack: PersonaDefinition): void;
  dispatchEffect(request: SpaceEffectRequest): void;
  emitEvent(name: string, payload?: unknown): void;
  setActiveUi(id: string | null): void;
  /**
   * 現在 active な UI pack の id（無ければ null）。F3/F4 のようなトグルを、ローカル真偽値で
   * はなく実状態から決めたいとき使う（ボタンで全画面を閉じても次のキーで即トグルできる）。
   */
  getActiveUi(): string | null;
  /** Per-frame parameter 補間。init scope で開始した tween はアプリ終了まで有効。 */
  tween: TweenAPI;
  /**
   * この init 実行（scope）が dispose されるときに呼ぶ cleanup を登録する。
   * hot reload で次の init.js に差し替わる直前、またはアプリ終了時に走る。
   * 自前で `window.addEventListener` / `setInterval` 等を仕掛けたときの後始末に使う。
   */
  onDispose(cleanup: () => void): void;
  /**
   * keyboard shortcut を登録する。`window` の keydown を capture phase で拾い、
   * spec が一致したら（既定で preventDefault + stopImmediatePropagation して）
   * handler を呼ぶ。返り値 Disposable で個別解除でき、init scope dispose 時にも
   * 自動解除される。手書きの `window.addEventListener` より短く、reload 安全。
   */
  registerShortcut(spec: InitShortcutSpec, handler: (event: KeyboardEvent) => void): InitDisposable;
}

export interface LoadInitScriptDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly devLog: SubsystemLog;
  readonly effectDispatcher: EffectRequester;
  readonly personaDefaults?: PersonaDefinition;
  readonly emitEvent?: (name: string, payload?: unknown) => void;
  readonly setActiveUi?: (id: string | null) => void;
  readonly getActiveUi?: () => string | null;
  readonly tweenManager?: TweenManager;
  /**
   * Tauri の user_init_script_path を叩いて init.js の absolute path を返す。
   * 見つからなければ null。
   */
  readonly fetchInitScriptPath: () => Promise<string | null>;
  readonly importModule: (path: string) => Promise<unknown>;
  /**
   * `ctx.registerShortcut` が使う listener installer。未指定なら `window` ベースの
   * 既定実装を使い、`window` が無い環境（node test 等）では noop に劣化する。
   * test では fake を渡して handler を直接叩ける。
   */
  readonly installShortcutListener?: ShortcutInstaller;
}

/**
 * 1 つの shortcut spec を実際の入力源に bind する installer。返り値の dispose で
 * 解除する。production の既定は `window` の keydown(capture)。
 */
export type ShortcutInstaller = (
  spec: InitShortcutSpec,
  handler: (event: KeyboardEvent) => void,
) => InitDisposable;

export interface LoadInitScriptResult {
  /** default() が throw せずに最後まで走ったか。 */
  readonly ran: boolean;
  /** ran が false のとき、理由を説明する文字列。 */
  readonly error?: string;
  /**
   * この run が確保した scope。reload 時に旧 run を畳むため呼び出し側が保持する。
   * `ran` が false（未実行 / import 失敗 / throw）でも、その時点までに積まれた
   * cleanup を畳めるよう常に返す。
   */
  readonly handle: InitScope;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const extractDefault = (mod: unknown): unknown => {
  if (mod === null || typeof mod !== "object") return undefined;
  return (mod as { default?: unknown }).default;
};

/**
 * `window` が使えるなら keydown(capture) を張る既定 installer。無ければ noop。
 */
const defaultShortcutInstaller: ShortcutInstaller = (spec, handler) => {
  const target: EventTarget | undefined = typeof window !== "undefined" ? window : undefined;
  if (target === undefined) {
    return { dispose: () => {} };
  }
  const capture = spec.capture ?? true;
  const listener = (event: Event): void => {
    const keyEvent = event as KeyboardEvent;
    if (!matchShortcut(spec, keyEvent)) return;
    if (spec.preventDefault ?? true) keyEvent.preventDefault();
    if (spec.stopPropagation ?? true) keyEvent.stopImmediatePropagation();
    handler(keyEvent);
  };
  target.addEventListener("keydown", listener, { capture });
  return {
    dispose: () => {
      target.removeEventListener("keydown", listener, { capture });
    },
  };
};

const makeInitContext = (
  deps: LoadInitScriptDeps,
  initScriptPath: string,
  scope: InitScope,
): CharminalInitContext => ({
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
      entryPath: initScriptPath,
    };
    deps.personaRegistry.register(entry);
  },
  dispatchEffect(request) {
    deps.effectDispatcher.dispatch(request);
  },
  emitEvent(name, payload) {
    if (deps.emitEvent === undefined) {
      throw new Error("emitEvent is not available in this runtime");
    }
    deps.emitEvent(name, payload);
  },
  setActiveUi(id) {
    if (deps.setActiveUi === undefined) {
      throw new Error("setActiveUi is not available in this runtime");
    }
    deps.setActiveUi(id);
  },
  getActiveUi() {
    return deps.getActiveUi ? deps.getActiveUi() : null;
  },
  tween: {
    start(key, to, durationMs, apply, options) {
      if (!deps.tweenManager) throw new Error("tweenManager is not available");
      return deps.tweenManager.start(`init:${key}`, to, durationMs, apply, options);
    },
    startVec3(key, to, durationMs, apply, options) {
      if (!deps.tweenManager) throw new Error("tweenManager is not available");
      return deps.tweenManager.startVec3(`init:${key}`, to, durationMs, apply, options);
    },
    cancel(key) {
      if (!deps.tweenManager) throw new Error("tweenManager is not available");
      deps.tweenManager.cancel(`init:${key}`);
    },
  },
  onDispose(cleanup) {
    scope.addCleanup(cleanup);
  },
  registerShortcut(spec, handler) {
    const installer = deps.installShortcutListener ?? defaultShortcutInstaller;
    const disposable = installer(spec, handler);
    scope.add(disposable);
    return disposable;
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
  const scope = new InitScope();

  let path: string | null;
  try {
    path = await fetchInitScriptPath();
  } catch (err) {
    const error = errorMessage(err);
    devLog.write({ phase: "locate", note: "failed to locate init.js", data: { error } });
    return { ran: false, error, handle: scope };
  }

  if (path === null) {
    devLog.write({ phase: "locate", note: "no init.js present" });
    return { ran: false, handle: scope };
  }

  devLog.write({ phase: "locate", note: "found init.js", data: { path } });

  let mod: unknown;
  try {
    mod = await importModule(path);
  } catch (err) {
    const error = errorMessage(err);
    devLog.write({ phase: "import", note: "init.js import failed", data: { path, error } });
    return { ran: false, error, handle: scope };
  }

  const def = extractDefault(mod);
  if (typeof def !== "function") {
    const error = "init.js default export is not a function";
    devLog.write({ phase: "import", note: error, data: { path } });
    return { ran: false, error, handle: scope };
  }

  const ctx = makeInitContext(deps, path, scope);
  try {
    // user's default may be sync or async. Await always — Promise.resolve wraps
    // plain returns and keeps synchronous throws catchable in the same block.
    await (def as (ctx: CharminalInitContext) => unknown)(ctx);
  } catch (err) {
    const error = errorMessage(err);
    devLog.write({ phase: "run", note: "init.js default threw", data: { error } });
    return { ran: false, error, handle: scope };
  }

  devLog.write({ phase: "run", note: "init.js completed" });
  return { ran: true, handle: scope };
}

/**
 * init.js を hot reload する。`startPackWatcher` が `init.js` の変更を受けたとき
 * に呼ぶ。
 *
 * 契約:
 * - 新しい init.js を staging scope で実行する（`loadInitScript` を再利用）。
 * - 成功（`ran === true`）したら **旧 active scope を dispose** してから、新 scope
 *   を返す。これで listener / timer の二重化を防ぎつつ新 shortcut が即有効になる。
 * - 失敗したら **staging scope だけ dispose** し、旧 active scope はそのまま残す。
 *   壊れた編集で動いていた shortcut を失わない（philosophy「壊さないこと」）。
 *
 * 返り値の `handle` は「次に active であるべき scope」。成功なら新 scope、失敗なら
 * 旧 scope（`previousHandle`）を返すので、呼び出し側はそれを保持し続ければよい。
 */
export async function reloadInitScript(
  deps: LoadInitScriptDeps,
  previousHandle: InitScope | null,
): Promise<LoadInitScriptResult> {
  const result = await loadInitScript(deps);

  if (result.ran) {
    // 新 init が最後まで走った。旧 scope を畳んで差し替える。
    previousHandle?.dispose();
    deps.devLog.write({ phase: "reload", note: "init.js reloaded" });
    return result;
  }

  // 失敗。staging scope を畳んで旧 scope を温存する。
  result.handle.dispose();
  deps.devLog.write({
    phase: "reload",
    note: "init.js reload failed; keeping previous init scope",
    data: result.error ? { error: result.error } : undefined,
  });
  return {
    ran: false,
    error: result.error,
    handle: previousHandle ?? new InitScope(),
  };
}
