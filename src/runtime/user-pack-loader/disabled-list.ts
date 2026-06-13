/**
 * disabledPacks による pack entries filter — pure fn。
 *
 * pack id の集合として扱い、同 id の全 kind（effect / persona / ...）が
 * 同時に disabled になる。unknown id は no-op。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「生きた系」
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.3
 */

import type { UserPackEntry } from "./user-pack-loader";

export function filterDisabledPacks(
  entries: ReadonlyArray<UserPackEntry>,
  disabledPacks: ReadonlyArray<string>,
): UserPackEntry[] {
  if (disabledPacks.length === 0) {
    return Array.from(entries);
  }
  const disabled = new Set(disabledPacks);
  return entries.filter((entry) => !disabled.has(entry.id));
}
