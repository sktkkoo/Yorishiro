/**
 * ScenePackRegistry の internal な型定義。
 *
 * public な ScenePackManifest / ScenePackDefinition / SceneSpec は SDK 側
 * （`src/sdk/scene.d.ts`、`src/sdk/scene-pack.d.ts`）にある。ここは runtime
 * 実装が使う internal な shape。
 *
 * Internal design-record: specs/2026-04-18-scene-pack-registry.md §3
 */

import type { ComponentType } from "react";
import type { SceneSpec } from "../../sdk/scene";
import type { ScenePackComponentProps, ScenePackManifest } from "../../sdk/scene-pack";

export type PackOrigin = "bundled" | "user";

/**
 * Registry に登録される scene pack の entry。
 *
 * asset path はこの時点で **絶対 URL に解決済み**。Loader が pack 出自に応じて
 * BUNDLED_ASSETS map lookup or convertFileSrc で変換してから push する。
 */
export interface ScenePackEntry {
  readonly id: string;
  readonly manifest: ScenePackManifest;
  readonly scene: SceneSpec;
  readonly origin: PackOrigin;

  /**
   * R3F-component scene pack の場合の component reference。
   * Bundled pack のみ。User pack 由来の場合は loader が undefined を保つ
   * （component field を含む user pack は loader が warn して捨てる）。
   *
   * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §5.2
   */
  readonly component?: ComponentType<ScenePackComponentProps>;
}

export interface Disposable {
  readonly dispose: () => void;
}

/**
 * Registry の public interface。scene-pack-registry.ts が実装する。
 */
export interface ScenePackRegistry {
  /**
   * pack を register。同 id の衝突時：
   *   - incoming が user && existing が bundled → existing を dispose + 置換
   *   - incoming が user && existing が user    → existing を dispose + 置換（hot-reload last-wins）
   *   - incoming が bundled && existing が user → 新 entry を ignore（user を守る）、warning log
   *   - incoming が bundled && existing が bundled → 後勝ち、warning log（開発ミス相当）
   * 返す Disposable は dispose で「その entry を Registry から外す」。
   */
  register(entry: ScenePackEntry): Disposable;

  /** 現在の active scene（asset 解決済み SceneSpec、または null）。 */
  getActiveScene(): SceneSpec | null;

  /**
   * 現在の active scene pack の entry（component を含む完全な entry）または null。
   * R3F-component path の判別に使う。
   */
  getActiveEntry(): ScenePackEntry | null;

  /**
   * active 変更を subscribe。登録時に現 active があれば同期で 1 回 fire。
   * 返す Disposable は unsubscribe。
   */
  subscribeActive(listener: (scene: SceneSpec | null) => void): Disposable;

  /**
   * Active entry 変更を subscribe。登録時に現 active があれば同期で 1 回 fire。
   * 既存 subscribeActive(scene) と並列に存在する。
   */
  subscribeActiveEntry(listener: (entry: ScenePackEntry | null) => void): Disposable;

  /**
   * Active scene を user 選択として設定（`config.json` の `activeScene` 由来）。
   * id が null なら selection クリア（Registry は fallback algorithm で bundled
   * alphabetical 先頭に戻る）。
   * 指定 id が存在しなくても error にせず、fall-through で bundled default を選ぶ。
   */
  setActiveScene(id: string | null): void;

  /** 現在 active な scene pack の id（または null）。 */
  getActiveSceneId(): string | null;

  /** debug / 設定 UI 用：登録済み全 entry を列挙。 */
  listEntries(): ReadonlyArray<ScenePackEntry>;
}
