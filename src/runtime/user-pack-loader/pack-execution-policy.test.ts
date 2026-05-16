import { describe, expect, it } from "vitest";
import { validatePackExecutionPolicy } from "./pack-execution-policy";
import type { UserPackEntry } from "./user-pack-loader";

const entry = (overrides: Partial<UserPackEntry> = {}): UserPackEntry => ({
  id: "pack-a",
  kind: "effect",
  entryPath: "/home/user/.charminal/packs/pack-a/effect.js",
  source: "local",
  ...overrides,
});

describe("validatePackExecutionPolicy", () => {
  it("allows local legacy packs without a manifest", () => {
    expect(validatePackExecutionPolicy(entry({ manifest: undefined }))).toBeNull();
  });

  it("requires community packs to provide a manifest", () => {
    expect(validatePackExecutionPolicy(entry({ source: "community", manifest: undefined }))).toBe(
      "community pack requires manifest.json with executionClass",
    );
  });

  it("blocks declarative packs that point at JavaScript", () => {
    const error = validatePackExecutionPolicy(
      entry({
        manifest: {
          id: "pack-a",
          type: "effect",
          entry: "effect.js",
          executionClass: "declarative",
        },
      }),
    );

    expect(error).toContain("declarative pack entry");
  });

  it("blocks isolated-js until the runtime exists", () => {
    expect(
      validatePackExecutionPolicy(
        entry({
          manifest: {
            id: "pack-a",
            type: "effect",
            entry: "effect.js",
            executionClass: "isolated-js",
          },
        }),
      ),
    ).toBe("isolated-js runtime is not implemented yet");
  });

  it("blocks community trusted-main-thread-js", () => {
    expect(
      validatePackExecutionPolicy(
        entry({
          source: "community",
          manifest: {
            id: "pack-a",
            type: "effect",
            entry: "effect.js",
            executionClass: "trusted-main-thread-js",
          },
        }),
      ),
    ).toBe("trusted-main-thread-js is only allowed for local, curated, or bundled packs");
  });

  it("allows local trusted-main-thread-js", () => {
    expect(
      validatePackExecutionPolicy(
        entry({
          manifest: {
            id: "pack-a",
            type: "effect",
            entry: "effect.js",
            executionClass: "trusted-main-thread-js",
          },
        }),
      ),
    ).toBeNull();
  });

  it("checks manifest id, type, and entry before import", () => {
    expect(
      validatePackExecutionPolicy(
        entry({
          manifest: {
            id: "other",
            type: "effect",
            entry: "effect.js",
            executionClass: "trusted-main-thread-js",
          },
        }),
      ),
    ).toContain("manifest id");

    expect(
      validatePackExecutionPolicy(
        entry({
          manifest: {
            id: "pack-a",
            type: "scene",
            entry: "effect.js",
            executionClass: "trusted-main-thread-js",
          },
        }),
      ),
    ).toContain("manifest type");

    expect(
      validatePackExecutionPolicy(
        entry({
          manifest: {
            id: "pack-a",
            type: "effect",
            entry: "other.js",
            executionClass: "trusted-main-thread-js",
          },
        }),
      ),
    ).toContain("manifest entry");
  });
});
