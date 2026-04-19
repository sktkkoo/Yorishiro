/**
 * PersonaRegistry の internal 型定義。
 *
 * Scene pack registry と対称な single-active semantics で retrofit
 * （2026-04-19 persona single-active plan）。
 * active 選択は config.primaryPersona で user が picks、pack 自己申告はしない。
 *
 * Internal design-record: 2026-04-19-persona-single-active.md
 */

import type { PersonaDefinition } from "../../sdk/persona";
import type { PersonaPackManifest } from "../../sdk/persona-pack";

export type PackOrigin = "bundled" | "user";

/**
 * Registry に登録される persona pack の entry。
 */
export interface PersonaEntry {
  readonly id: string;
  readonly manifest: PersonaPackManifest;
  readonly persona: PersonaDefinition;
  readonly origin: PackOrigin;
}

export interface Disposable {
  readonly dispose: () => void;
}

/**
 * Registry の public interface。persona-registry-impl.ts が実装する。
 *
 * Scene pack registry と対称な single-active semantics：
 *   - register / getActivePersona / subscribeActive / setPrimaryPersona /
 *     listEntries / Disposable 返却 / override pattern
 *
 * override 挙動（scene と同じ）：
 *   - user が bundled を同 id で dispose + 置換
 *   - bundled-over-user → ignore + warn
 *   - bundled-over-bundled → 後勝ち + warn（開発ミス相当）
 */
export interface PersonaRegistry {
  /**
   * persona pack を register。同 id 衝突時の挙動は ScenePackRegistry と同じ：
   *   - incoming が user && existing が bundled → existing を dispose + 置換
   *   - incoming が user && existing が user    → existing を dispose + 置換（hot-reload last-wins）
   *   - incoming が bundled && existing が user → incoming を ignore、warning log
   *   - incoming が bundled && existing が bundled → 後勝ち、warning log（開発ミス相当）
   * 返す Disposable は dispose で「その entry を Registry から外す」。
   */
  register(entry: PersonaEntry): Disposable;

  /** 現在の active persona（PersonaDefinition、または null）。 */
  getActivePersona(): PersonaDefinition | null;

  /**
   * active 変更を subscribe。登録時に現 active があれば同期で 1 回 fire。
   * 返す Disposable は unsubscribe。
   */
  subscribeActive(listener: (persona: PersonaDefinition | null) => void): Disposable;

  /**
   * Active persona を user 選択として設定（`config.json` の `primaryPersona` 由来）。
   * id が null なら selection クリア（Registry は fallback algorithm で bundled
   * alphabetical 先頭に戻る）。
   * 指定 id が存在しなくても error にせず、fall-through で bundled default を選ぶ。
   */
  setPrimaryPersona(id: string | null): void;

  /** debug / 設定 UI 用：登録済み全 entry を列挙。 */
  listEntries(): ReadonlyArray<PersonaEntry>;
}
