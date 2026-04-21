/**
 * UiPackRegistryImpl — UI pack の宣言を保管し、active UI を選択する registry。
 *
 * `SingleActiveRegistry<UiPackEntry, UiPackEntry>` を extend。scene pack が
 * SceneSpec を外に expose するのに対し、UI pack は mount を外から呼ぶ必要が
 * あるので extractValue は entry 全体を返す（TValue = TEntry）。
 *
 * 同 id override / promotion / reference fire 等の semantics は SingleActiveRegistry
 * の docstring を参照。
 *
 * Internal design-record: specs/2026-04-21-ui-pack-design.md §3
 */

import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { SingleActiveRegistry } from "../single-active-registry";
import type { UiPackEntry, UiPackRegistry } from "./types";

export class UiPackRegistryImpl
  extends SingleActiveRegistry<UiPackEntry, UiPackEntry>
  implements UiPackRegistry
{
  constructor() {
    super({
      extractValue: (entry) => entry,
      label: "UiPackRegistry",
      warnOnMultipleBundled: false,
    });
  }

  /** Domain alias：base の `getActive()` を UI pack 名で expose。 */
  getActiveUi(): UiPackEntry | null {
    return this.getActive();
  }

  /** Domain alias：base の `setActive()` を UI pack 名で expose。 */
  setActiveUi(id: string | null): void {
    this.setActive(id);
  }
}

/** factory function（test 用の new instance 生成） */
export function createUiPackRegistry(): UiPackRegistry {
  return new UiPackRegistryImpl();
}

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getUiRegistry(): UiPackRegistry {
  return getOrInit(KEYS.UI_PACK_REGISTRY, () => new UiPackRegistryImpl());
}
