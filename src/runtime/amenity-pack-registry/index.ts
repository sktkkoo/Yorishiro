import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { AmenityPackRegistryImpl } from "./amenity-pack-registry";
import type { AmenityPackEntry, AmenityPackRegistry } from "./types";

export type { AmenityPackEntry, AmenityPackRegistry };
export { AmenityPackRegistryImpl };

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getAmenityPackRegistry(): AmenityPackRegistry {
  return getOrInit(KEYS.AMENITY_PACK_REGISTRY, () => new AmenityPackRegistryImpl());
}
