import type { ScenePackEntry } from "./types";

/**
 * Active scene を選ぶ pure 関数。Design B（memory:
 * feedback_single_active_config_picks）。
 *
 * Priority:
 *   1. activeSceneId が entries に hit → それ
 *   2. 無ければ bundled tier の alphabetical 先頭（fresh install fallback）
 *   3. bundled なし → null
 *
 * user tier を自動選択しない。pack 自己申告の `defaultActive` も使わない。
 * user が複数 pack を置いても alphabetical の threshold 争いは起きない
 * （誰も自薦しないので）。
 *
 * Internal design-record: specs/2026-04-18-scene-pack-registry.md §3.4
 */
export function computeActive(
  entries: ReadonlyArray<ScenePackEntry>,
  activeSceneId: string | null,
): ScenePackEntry | null {
  if (activeSceneId !== null) {
    const hit = entries.find((e) => e.id === activeSceneId);
    if (hit !== undefined) return hit;
  }

  const bundledCandidates = entries
    .filter((e) => e.origin === "bundled")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (bundledCandidates.length > 0) return bundledCandidates[0];

  return null;
}
