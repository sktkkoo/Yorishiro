import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectRoot } from "../../bindings/tauri-commands";
import { EMPTY_CONFIG } from "../user-pack-loader/config";
import {
  applyCurrentProjectSceneSelection,
  resolveCurrentProjectRoot,
  withCurrentProjectSceneSet,
} from "./project-context";

vi.mock("../../bindings/tauri-commands", () => ({
  resolveProjectRoot: vi.fn(),
}));

describe("resolveCurrentProjectRoot", () => {
  beforeEach(() => {
    vi.mocked(resolveProjectRoot).mockReset();
  });

  it("returns null without invoking Rust when cwd is null", async () => {
    await expect(resolveCurrentProjectRoot(null)).resolves.toBeNull();
    expect(resolveProjectRoot).not.toHaveBeenCalled();
  });

  it("returns the resolved project root for a cwd", async () => {
    vi.mocked(resolveProjectRoot).mockResolvedValue("/repo/main");

    await expect(resolveCurrentProjectRoot("/repo/main/src")).resolves.toBe("/repo/main");
    expect(resolveProjectRoot).toHaveBeenCalledWith({ cwd: "/repo/main/src" });
  });

  it("degrades to null when Rust project resolution fails", async () => {
    vi.mocked(resolveProjectRoot).mockRejectedValue(new Error("missing cwd"));

    await expect(resolveCurrentProjectRoot("/missing")).resolves.toBeNull();
  });
});

describe("withCurrentProjectSceneSet", () => {
  it("writes sceneByProject when projectRoot is resolved", () => {
    const updated = withCurrentProjectSceneSet(EMPTY_CONFIG, "/repo/main", "factory");

    expect(updated.activeScene).toBeNull();
    expect(updated.sceneByProject).toEqual({ "/repo/main": "factory" });
  });

  it("removes sceneByProject entry when projectRoot is resolved and scene is null", () => {
    const base = {
      ...EMPTY_CONFIG,
      activeScene: "fallback",
      sceneByProject: { "/repo/main": "factory" },
    };

    const updated = withCurrentProjectSceneSet(base, "/repo/main", null);

    expect(updated.activeScene).toBe("fallback");
    expect(updated.sceneByProject).toEqual({});
  });

  it("writes activeScene when projectRoot is unresolved", () => {
    const updated = withCurrentProjectSceneSet(EMPTY_CONFIG, null, "factory");

    expect(updated.activeScene).toBe("factory");
    expect(updated.sceneByProject).toEqual({});
  });
});

describe("applyCurrentProjectSceneSelection", () => {
  it("returns global fallback as runtime scene when a project override is cleared", () => {
    const base = {
      ...EMPTY_CONFIG,
      activeScene: "fallback",
      sceneByProject: { "/repo/main": "factory" },
    };

    const result = applyCurrentProjectSceneSelection(base, "/repo/main", null);

    expect(result.config.sceneByProject).toEqual({});
    expect(result.activeScene).toBe("fallback");
  });
});
