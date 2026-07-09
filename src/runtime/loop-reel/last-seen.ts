import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";

/** hot-data Map。catch-up 視聴位置はアプリ再起動では消えてよい。 */
export function getLoopReelLastSeenMap(): Map<string, number> {
  return getOrInit(KEYS.LOOP_REEL_LAST_SEEN, () => new Map<string, number>());
}
