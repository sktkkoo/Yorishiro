/**
 * AmenityPackRegistry の types。
 *
 * multi-active registry（ambient-ui と同じ semantic）。
 * 複数の amenity を同時に active にできる（pomodoro + weather + music）。
 * 同 id を user/bundled で override する semantic を持つ。
 */

import type { AmenityHandle, AmenityPackManifest, Disposable } from "@yorishiro/sdk";
import type { PackOrigin } from "../single-active-registry/types";

export interface AmenityPackEntry {
  readonly id: string;
  readonly origin: PackOrigin;
  readonly manifest: AmenityPackManifest;
  readonly handle: AmenityHandle;
}

export interface AmenityPackRegistry {
  /**
   * entry を登録する。同 id の origin 違いは "user-over-bundled" で
   * override する semantic。同 id 同 origin の重複登録は replace
   * （旧 entry の handle.dispose() を呼び、active 集合 membership は維持）。
   */
  register(entry: AmenityPackEntry): Disposable;

  /** 登録されている全 entry を返す（順序は registration 順）。 */
  listEntries(): ReadonlyArray<AmenityPackEntry>;

  /** id を active 集合に追加。未登録 id は no-op + console.warn。 */
  enable(id: string): void;

  /** id を active 集合から外す。entry の handle.dispose() も呼ぶ。 */
  disable(id: string): void;

  /** 現在 active な id 集合。 */
  getActiveSet(): ReadonlyArray<string>;

  /** active な amenity の handle を取得する（MCP tool routing 用）。 */
  getActiveHandle(id: string): AmenityHandle | null;

  /**
   * active 集合の変化を購読。listener は subscribe 時に最新集合で
   * 即時 fire（immediate-fire pattern）。
   */
  subscribeActiveSet(listener: (ids: ReadonlyArray<string>) => void): Disposable;
}
