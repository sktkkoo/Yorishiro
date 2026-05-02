/**
 * UiPackRegistry の types。SingleActiveRegistry<UiPackEntry, UiPackEntry> 上に
 * domain alias（getActiveUi / setActiveUi）を被せる形で実装する。
 *
 * extractValue は entry 全体を返す（TValue = TEntry）。scene pack が
 * SceneSpec だけを expose するのに対し、UI pack は mount を外から呼ぶ必要が
 * あるので entry 全体が必要。
 */

import type { Disposable, UiContext, UiLayout, UiPackManifest } from "@charminal/sdk";
import type { PackOrigin } from "../single-active-registry/types";

export interface UiPackEntry {
  readonly id: string;
  readonly origin: PackOrigin;
  readonly manifest: UiPackManifest;
  readonly pack: {
    readonly layout: UiLayout;
    readonly mount: (ctx: UiContext, container: HTMLDivElement) => Disposable;
  };
}

export interface UiPackRegistry {
  register(entry: UiPackEntry): Disposable;
  getActiveUi(): UiPackEntry | null;
  setActiveUi(id: string | null): void;
  subscribeActive(listener: (entry: UiPackEntry | null) => void): Disposable;
  /** 現在 active な ui pack の id（または null）。 */
  getActiveUiId(): string | null;

  listEntries(): ReadonlyArray<UiPackEntry>;
}
