import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { AmbientUiPackRegistryImpl, createAmbientUiPackRegistry } from "./ambient-ui-pack-registry";
import type { AmbientUiPackEntry, AmbientUiPackRegistry } from "./types";

export type { AmbientUiPackEntry, AmbientUiPackRegistry };
export { AmbientUiPackRegistryImpl, createAmbientUiPackRegistry };

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getAmbientUiPackRegistry(): AmbientUiPackRegistry {
  return getOrInit(KEYS.AMBIENT_UI_PACK_REGISTRY, () => new AmbientUiPackRegistryImpl());
}
