/**
 * Scene pack の register ロジックを loader と watcher で共有する helper。
 *
 * 背景：`user-pack-loader.ts` の `loadSingleUserPack` と `watcher.ts` の
 * `reloadPack` は scene kind の処理をほぼ同じ 40 行で重複していた。
 * 差分は「phase タグの文字列」と「convertFileSrc の注入経路」だけであり、
 * それを `SceneRegisterContext` の field として抽象化することで一本化する。
 *
 * Phase 2 carry-over 実装。
 * Internal design-record: 2026-04-18-user-layer-runtime.md Section B2
 */

import type { SubsystemLog } from "../../core/dev-log";
import type { ScenePackManifest } from "../../sdk/scene-pack";
import {
  PackValidationError,
  validateScenePackDefinition,
  validateScenePackManifest,
} from "../../sdk/validators";
import type { ScenePackRegistry } from "../scene-pack-registry";
import { resolveSceneAssets } from "../scene-pack-registry";
import type { UserPackRegistry } from "./user-pack-registry";

/**
 * `registerScenePack` に渡す依存コンテキスト。
 *
 * - `convertFileSrc`: Tauri の同名関数を呼び出し元が注入する。loader では
 *   `@tauri-apps/api/core` を dynamic import して渡す。watcher ではすでに
 *   startPackWatcher の先頭で取得済みのものを渡す。これにより loader 側の
 *   TODO（「dep injection 原則から外れて dynamic import している」）も解消する。
 * - `logPhase`: caller ごとに異なる phase タグを外から指定する。
 */
export interface SceneRegisterContext {
  /** pack ID（list_user_packs が返す id）。 */
  readonly id: string;
  /** pack entry ファイルの絶対パス（`/path/to/<id>/scene.js`）。 */
  readonly entryPath: string;
  /** pack の default export（extractDefault 適用後の unknown 値）。 */
  readonly def: unknown;
  /** 前 Disposable の has / dispose と 新 Disposable の register を管理する registry。 */
  readonly packRegistry: UserPackRegistry;
  /** scene pack の register / getActiveScene / subscribeActive 等を持つ registry。 */
  readonly scenePackRegistry: ScenePackRegistry;
  /** 書き込み先の subsystem log。 */
  readonly devLog: SubsystemLog;
  /**
   * Tauri の convertFileSrc に相当する関数。絶対ファイルパスを asset:// URL に変換する。
   * テストでは `(p) => \`asset://localhost/${p}\`` 等の stub を渡す。
   */
  readonly convertFileSrc: (path: string) => string;
  /**
   * dev-log に書き出す phase タグ。loader と watcher で値が異なる。
   *
   * - `manifestError`: manifest の取得・検証失敗時に使う phase。
   *   loader は `"validate"`、watcher は `"reload"`。
   * - `register`: register 完了時に使う phase。
   *   loader は `"register"`、watcher は `"reload"`。
   */
  readonly logPhase: {
    readonly manifestError: string;
    readonly register: string;
  };
}

/**
 * `registerScenePack` の戻り値。
 *
 * - `"loaded"`: 全工程が成功し registry に登録済み。
 * - `"failed"`: いずれかの工程で失敗。`error` にメッセージが入る。
 */
export type SceneRegisterResult =
  | { readonly status: "loaded" }
  | { readonly status: "failed"; readonly error: string };

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * user scene pack を validate → manifest fetch → asset resolve → register する共通 helper。
 *
 * loader と watcher の scene branch を一本化するために抽出した。呼び出し元は
 * `SceneRegisterContext` を組み立てて渡すだけでよい。
 *
 * 処理順：
 *   1. `validateScenePackDefinition` で default export の shape を確認
 *   2. `entryPath` から packDir を導出（末尾の `/scene.js` を除去）
 *   3. `convertFileSrc` で manifest URL を生成し `fetch` + `validateScenePackManifest`
 *   4. `resolveSceneAssets` で layer src を asset:// URL に変換
 *   5. `packRegistry.has` → dispose → `scenePackRegistry.register` → `packRegistry.register`
 *   6. dev-log に register 完了を書き出す
 *
 * 各工程のエラーは外に throw せず `{ status: "failed", error }` として返す。
 */
export async function registerScenePack(ctx: SceneRegisterContext): Promise<SceneRegisterResult> {
  // 1. default export の shape 確認
  let scenePackDef: ReturnType<typeof validateScenePackDefinition>;
  try {
    scenePackDef = validateScenePackDefinition(ctx.def);
  } catch (err) {
    const error = errorMessage(err);
    ctx.devLog.write({
      phase: ctx.logPhase.manifestError,
      note: `scene "${ctx.id}": ${error}`,
    });
    return { status: "failed", error };
  }

  // 2. packDir = entryPath から末尾の `/scene.js` を除いたディレクトリ
  const packDir = ctx.entryPath.replace(/\/scene\.js$/, "");

  // 3. manifest.json を fetch + validate
  const manifestUrl = ctx.convertFileSrc(`${packDir}/manifest.json`);
  let manifest: ScenePackManifest;
  try {
    const response = await fetch(manifestUrl);
    if (!response.ok) {
      throw new PackValidationError(
        `manifest.json not found (HTTP ${response.status}) at ${packDir}/manifest.json`,
      );
    }
    const rawManifest = (await response.json()) as unknown;
    manifest = validateScenePackManifest(rawManifest, ctx.id);
  } catch (err) {
    const error =
      err instanceof PackValidationError
        ? err.message
        : `manifest.json read/parse failed: ${errorMessage(err)}`;
    ctx.devLog.write({
      phase: ctx.logPhase.manifestError,
      note: `scene "${ctx.id}": ${error}`,
    });
    return { status: "failed", error };
  }

  // 4. layer src を asset:// URL に解決
  const resolved = await resolveSceneAssets(scenePackDef.scene, {
    origin: "user",
    packId: ctx.id,
    packDir,
    onMissing: (layerId, src) => {
      ctx.devLog.write({
        phase: ctx.logPhase.register,
        note: `user scene "${ctx.id}": asset missing for layer "${layerId}" (src="${src}")`,
      });
    },
  });

  // 5. 前登録を dispose してから register
  if (ctx.packRegistry.has(ctx.id, "scene")) {
    ctx.packRegistry.dispose(ctx.id, "scene");
  }
  const handle = ctx.scenePackRegistry.register({
    id: ctx.id,
    manifest,
    scene: resolved,
    origin: "user",
  });
  ctx.packRegistry.register(ctx.id, "scene", handle);

  // 6. 完了ログ
  ctx.devLog.write({
    phase: ctx.logPhase.register,
    note: `registered scene '${scenePackDef.id}'`,
  });

  return { status: "loaded" };
}
