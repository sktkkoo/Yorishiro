/**
 * ScenePackRegistryImpl — scene pack の宣言を保管し、active scene を選択する primitive。
 *
 * 実体は `SingleActiveRegistry<ScenePackEntry, SceneSpec>` で、本 class は
 * domain 固有の getter/setter alias（`getActiveScene` / `setActiveScene`）を
 * 提供するだけ。共通 semantic（override pattern, promotion, reference fire,
 * collision warning 等）はすべて base の docstring を参照。
 *
 * Effect pack と Scene pack は概念が違う（event-driven vs declarative）。
 * EffectPackRunner とは別 concept として独立（memory:
 * feedback_separate_conceptually_distinct_systems.md / docs/decisions/
 * separate-distinct-systems.md）。
 *
 * Internal design-record: specs/2026-04-18-scene-pack-registry.md §3
 */

import simpleRoomManifest from "../../../bundled-packs/scenes/simple-room/manifest.json";
import type { SceneSpec } from "../../sdk/scene";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { SingleActiveRegistry } from "../single-active-registry";
import type {
  Disposable,
  ScenePackEntry,
  ScenePackRegistry as ScenePackRegistryInterface,
} from "./types";

export interface ScenePackRegistryOptions {
  /** 診断ログ（bundled-over-user warning、bundled collision 等） */
  readonly warn?: (msg: string) => void;
}

/**
 * fresh-install / activeScene 未指定時に選ぶ既定 bundled scene の id。
 * 落ち着いた抽象空間で「住人がいる場所」を最小限の演出で出すため、
 * alphabetical 先頭ではなく明示的に指定する。
 *
 * 文字列リテラルではなく manifest.id を参照することで、bundled-packs/scenes/
 * simple-room/ がリネームされた時に import path が壊れて compile-time に
 * 検出される（リテラルだと runtime で alphabetical fallback に静かに落ちる）。
 */
export const DEFAULT_BUNDLED_SCENE_ID: string = simpleRoomManifest.id;

export class ScenePackRegistryImpl
  extends SingleActiveRegistry<ScenePackEntry, SceneSpec>
  implements ScenePackRegistryInterface
{
  constructor(opts: ScenePackRegistryOptions = {}) {
    super({
      extractValue: (entry) => entry.scene,
      label: "ScenePackRegistry",
      warn: opts.warn,
      // bundled scene は複数の標準選択肢を持てる。fallback は明示 default → alphabetical 先頭。
      warnOnMultipleBundled: false,
      defaultBundledId: DEFAULT_BUNDLED_SCENE_ID,
    });
  }

  /** Domain alias：base の `getActive()` を scene 名で expose。 */
  getActiveScene(): SceneSpec | null {
    return this.getActive();
  }

  /** Domain alias：base の `setActive()` を scene 名で expose。 */
  setActiveScene(id: string | null): void {
    this.setActive(id);
  }

  /** Domain alias：base の `getActiveId()` を scene 名で expose。 */
  getActiveSceneId(): string | null {
    return this.getActiveId();
  }

  /** 現在の active scene pack の entry。R3F-component path の判別に使う。 */
  getActiveEntry(): ScenePackEntry | null {
    const id = this.getActiveId();
    if (id === null) return null;
    return this.listEntries().find((entry) => entry.id === id) ?? null;
  }

  /**
   * Active entry 変更の subscriber。既存 subscribeActive(SceneSpec) と並列。
   * base の subscribeActive(value) を thin wrapper する。
   */
  subscribeActiveEntry(listener: (entry: ScenePackEntry | null) => void): Disposable {
    return this.subscribeActive(() => {
      listener(this.getActiveEntry());
    });
  }
}

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getSceneRegistry(): ScenePackRegistryInterface {
  return getOrInit(KEYS.SCENE_PACK_REGISTRY, () => new ScenePackRegistryImpl());
}
