/**
 * config.json の shape と pure 変換 helper のテスト。
 *
 * Tauri invoke を介した file I/O は test しない（stub できる value が無く、
 * production 側の dev-log で目視確認する——runtime-wire と同じ方針）。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.3
 */

import { describe, expect, it } from "vitest";
import {
  type CharminalConfig,
  EMPTY_CONFIG,
  parseConfig,
  serializeConfig,
  withDisabledPackAdded,
  withDisabledPackRemoved,
} from "./config";

describe("parseConfig", () => {
  it("returns EMPTY_CONFIG for empty input", () => {
    expect(parseConfig("")).toEqual(EMPTY_CONFIG);
  });

  it("returns EMPTY_CONFIG for malformed JSON", () => {
    expect(parseConfig("{ not json")).toEqual(EMPTY_CONFIG);
  });

  it("reads disabledPacks array", () => {
    const json = JSON.stringify({ disabledPacks: ["a", "b"] });
    expect(parseConfig(json)).toEqual({
      disabledPacks: ["a", "b"],
      activePersonas: [],
      mcpPort: null,
    });
  });

  it("reads activePersonas array", () => {
    const json = JSON.stringify({ activePersonas: ["charminal-default"] });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      activePersonas: ["charminal-default"],
      mcpPort: null,
    });
  });

  it("reads mcpPort number", () => {
    const json = JSON.stringify({ mcpPort: 12345 });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      activePersonas: [],
      mcpPort: 12345,
    });
  });

  it("ignores unknown fields and unexpected types silently", () => {
    const json = JSON.stringify({
      disabledPacks: ["ok"],
      disabledPacksLegacy: "should be ignored",
      unknownField: 42,
      mcpPort: "not a number",
    });
    expect(parseConfig(json)).toEqual({
      disabledPacks: ["ok"],
      activePersonas: [],
      mcpPort: null,
    });
  });
});

describe("serializeConfig", () => {
  it("omits empty arrays and null port for minimal JSON", () => {
    const cfg: CharminalConfig = EMPTY_CONFIG;
    const text = serializeConfig(cfg);
    expect(JSON.parse(text)).toEqual({});
  });

  it("writes disabledPacks when non-empty", () => {
    const cfg: CharminalConfig = {
      disabledPacks: ["a"],
      activePersonas: [],
      mcpPort: null,
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ disabledPacks: ["a"] });
  });

  it("writes mcpPort when set", () => {
    const cfg: CharminalConfig = {
      disabledPacks: [],
      activePersonas: [],
      mcpPort: 18743,
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ mcpPort: 18743 });
  });

  it("round-trips a populated config", () => {
    const cfg: CharminalConfig = {
      disabledPacks: ["a", "b"],
      activePersonas: ["p"],
      mcpPort: 18743,
    };
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });
});

describe("withDisabledPackAdded / withDisabledPackRemoved", () => {
  it("adds an id to disabledPacks", () => {
    const next = withDisabledPackAdded(EMPTY_CONFIG, "bad");
    expect(next.disabledPacks).toEqual(["bad"]);
  });

  it("is idempotent — adding the same id twice stays unique", () => {
    const once = withDisabledPackAdded(EMPTY_CONFIG, "x");
    const twice = withDisabledPackAdded(once, "x");
    expect(twice.disabledPacks).toEqual(["x"]);
  });

  it("removes an id from disabledPacks", () => {
    const base: CharminalConfig = {
      disabledPacks: ["a", "b"],
      activePersonas: [],
      mcpPort: null,
    };
    const next = withDisabledPackRemoved(base, "a");
    expect(next.disabledPacks).toEqual(["b"]);
  });

  it("is idempotent — removing an absent id is a no-op", () => {
    const base: CharminalConfig = {
      disabledPacks: ["a"],
      activePersonas: [],
      mcpPort: null,
    };
    const next = withDisabledPackRemoved(base, "phantom");
    expect(next.disabledPacks).toEqual(["a"]);
  });
});
