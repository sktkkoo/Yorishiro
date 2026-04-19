import type { PersonaEntry } from "./types";

/**
 * Active persona を選ぶ pure 関数。scene-pack-registry の computeActive と対称。
 *
 * Priority:
 *   1. primaryPersonaId が entries に hit → それ
 *   2. 無ければ bundled tier の alphabetical 先頭（fresh install fallback）
 *   3. bundled なし → null
 *
 * user tier を自動選択しない。pack 自己申告の defaultActive も使わない。
 * user が複数 pack を置いても alphabetical の threshold 争いは起きない
 * （誰も自薦しないので）。
 *
 * Internal design-record: 2026-04-19-persona-single-active.md
 */
export function computeActivePersona(
  entries: ReadonlyArray<PersonaEntry>,
  primaryPersonaId: string | null,
): PersonaEntry | null {
  if (primaryPersonaId !== null) {
    const hit = entries.find((e) => e.id === primaryPersonaId);
    if (hit !== undefined) return hit;
  }

  const bundledCandidates = entries
    .filter((e) => e.origin === "bundled")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (bundledCandidates.length > 0) return bundledCandidates[0];

  return null;
}
