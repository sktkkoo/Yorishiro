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

import type { SceneSpec } from "../../sdk/scene";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { SingleActiveRegistry } from "../single-active-registry";
import type { ScenePackEntry, ScenePackRegistry as ScenePackRegistryInterface } from "./types";

export interface ScenePackRegistryOptions {
  /** 診断ログ（bundled-over-user warning、bundled collision 等） */
  readonly warn?: (msg: string) => void;
}

export class ScenePackRegistryImpl
  extends SingleActiveRegistry<ScenePackEntry, SceneSpec>
  implements ScenePackRegistryInterface
{
  constructor(opts: ScenePackRegistryOptions = {}) {
    super({
      extractValue: (entry) => entry.scene,
      label: "ScenePackRegistry",
      warn: opts.warn,
      // bundled scene は複数の標準選択肢を持てる。fallback は alphabetical 先頭。
      warnOnMultipleBundled: false,
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
}

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getSceneRegistry(): ScenePackRegistryInterface {
  return getOrInit(KEYS.SCENE_PACK_REGISTRY, () => new ScenePackRegistryImpl());
}
