import { describe, expect, it } from "vitest";
import { computeActivePersona } from "./select-active";
import type { PersonaEntry } from "./types";

const makeEntry = (id: string, origin: "bundled" | "user"): PersonaEntry => ({
  id,
  origin,
  manifest: {
    id,
    type: "persona",
    version: "0.1.0",
    charminalVersion: "^0.1.0",
    entry: "persona.js",
  },
  persona: {
    id,
    name: id,
    reflex: { responses: {} },
    world: { body: "", voice: "", space: "" },
    logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
  },
});

describe("computeActivePersona", () => {
  it("returns null when no entries", () => {
    expect(computeActivePersona([], null)).toBeNull();
  });

  it("returns bundled alphabetical first when no primaryPersonaId set", () => {
    const entries = [makeEntry("zzz", "bundled"), makeEntry("aaa", "bundled")];
    const result = computeActivePersona(entries, null);
    expect(result?.id).toBe("aaa");
  });

  it("does NOT auto-select user pack when primaryPersonaId is null", () => {
    const entries = [makeEntry("user-a", "user"), makeEntry("bundled-b", "bundled")];
    const result = computeActivePersona(entries, null);
    expect(result?.origin).toBe("bundled");
  });

  it("returns the pack whose id matches primaryPersonaId", () => {
    const entries = [makeEntry("bundled-a", "bundled"), makeEntry("user-b", "user")];
    const result = computeActivePersona(entries, "user-b");
    expect(result?.id).toBe("user-b");
  });

  it("falls through to bundled fallback when primaryPersonaId does not exist", () => {
    const entries = [makeEntry("bundled-a", "bundled")];
    const result = computeActivePersona(entries, "missing-id");
    expect(result?.id).toBe("bundled-a");
  });

  it("returns null when no bundled pack exists and primaryPersonaId is null", () => {
    const entries = [makeEntry("user-only", "user")];
    const result = computeActivePersona(entries, null);
    expect(result).toBeNull();
  });
});
