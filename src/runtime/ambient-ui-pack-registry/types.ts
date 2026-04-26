/**
 * AmbientUiPackRegistry の types。
 *
 * UiPackRegistry が SingleActiveRegistry 派生なのに対し、ambient は
 * multi-active なので独自の interface。同 id を user/bundled で override する
 * semantic は持つが、active 集合は 0..n 個。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 * 「Surface / SDK 設計」section
 */

import type { AmbientUiContext, AmbientUiPackManifest, Disposable } from "@charminal/sdk";
import type { PackOrigin } from "../single-active-registry/types";

export interface AmbientUiPackEntry {
  readonly id: string;
  readonly origin: PackOrigin;
  readonly manifest: AmbientUiPackManifest;
  readonly pack: {
    readonly mount: (ctx: AmbientUiContext, container: HTMLDivElement) => Disposable;
  };
}

export interface AmbientUiPackRegistry {
  /**
   * entry を登録する。同 id の origin 違いは "user-over-bundled" で
   * override する semantic。同 id 同 origin の重複登録は同様に replace
   * (旧 entry は dispose せず entries map から落ちる、active 集合 membership は維持)。
   */
  register(entry: AmbientUiPackEntry): Disposable;

  /** 登録されている全 entry を返す（順序は registration 順）。 */
  listEntries(): ReadonlyArray<AmbientUiPackEntry>;

  /** id を active 集合に追加。未登録 id は no-op + console.warn。 */
  enable(id: string): void;

  /** id を active 集合から外す。未登録 / inactive は no-op。 */
  disable(id: string): void;

  /** 現在 active な id 集合（順序は enable 順）。 */
  getActiveSet(): ReadonlyArray<string>;

  /**
   * active 集合の変化を購読。listener は subscribe 時に最新集合で
   * 即時 fire（immediate-fire pattern）。listener は同期的に呼ばれる。
   * dispose 後は listener が呼ばれないことが保証される。
   */
  subscribeActiveSet(listener: (ids: ReadonlyArray<string>) => void): Disposable;
}
