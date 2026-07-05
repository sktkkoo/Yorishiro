/**
 * disabledPacks による pack entries の filter logic — pure fn。
 *
 * config.json の disabledPacks: string[] は pack id の集合として扱う。
 * 同 id の全 kind が disabled になる（effect も persona も両方落ちる）。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.3
 */

import { describe, expect, it } from "vitest";
import { filterDisabledPacks } from "./disabled-list";
import type { UserPackEntry } from "./user-pack-loader";

const entry = (id: string, kind: string): UserPackEntry => ({
  id,
  kind,
  entryPath: `/home/.yorishiro/packs/${id}/${kind}.js`,
});

describe("filterDisabledPacks", () => {
  it("returns the original list when disabledPacks is empty", () => {
    const entries = [entry("a", "effect"), entry("b", "persona")];
    expect(filterDisabledPacks(entries, [])).toEqual(entries);
  });

  it("removes entries whose id is in disabledPacks", () => {
    const entries = [entry("a", "effect"), entry("b", "persona"), entry("c", "effect")];
    const result = filterDisabledPacks(entries, ["b"]);
    expect(result).toEqual([entry("a", "effect"), entry("c", "effect")]);
  });

  it("removes all kinds under a disabled pack id", () => {
    const entries = [entry("multi", "effect"), entry("multi", "persona"), entry("keep", "effect")];
    const result = filterDisabledPacks(entries, ["multi"]);
    expect(result).toEqual([entry("keep", "effect")]);
  });

  it("tolerates unknown ids in disabledPacks (no-op for missing)", () => {
    const entries = [entry("a", "effect")];
    const result = filterDisabledPacks(entries, ["phantom", "a", "ghost"]);
    expect(result).toEqual([]);
  });

  it("returns empty when every entry is disabled", () => {
    const entries = [entry("a", "effect"), entry("b", "effect")];
    expect(filterDisabledPacks(entries, ["a", "b"])).toEqual([]);
  });
});
