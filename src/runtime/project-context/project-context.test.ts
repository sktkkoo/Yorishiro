import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectRoot } from "../../bindings/tauri-commands";
import { EMPTY_CONFIG } from "../user-pack-loader/config";
import {
  applyCurrentProjectSceneSelection,
  applyCurrentProjectSceneSelectionWithResolution,
  resolveCurrentProjectRoot,
  resolveProjectRootIfUnresolved,
  withCurrentProjectSceneSet,
} from "./project-context";

vi.mock("../../bindings/tauri-commands", () => ({
  resolveProjectRoot: vi.fn(),
}));

describe("resolveCurrentProjectRoot", () => {
  beforeEach(() => {
    vi.mocked(resolveProjectRoot).mockReset();
  });

  it("returns none without invoking Rust when cwd is null", async () => {
    await expect(resolveCurrentProjectRoot(null)).resolves.toEqual({ kind: "none" });
    expect(resolveProjectRoot).not.toHaveBeenCalled();
  });

  it("returns the resolved project root for a cwd", async () => {
    vi.mocked(resolveProjectRoot).mockResolvedValue("/repo/main");

    await expect(resolveCurrentProjectRoot("/repo/main/src")).resolves.toEqual({
      kind: "resolved",
      root: "/repo/main",
    });
    expect(resolveProjectRoot).toHaveBeenCalledWith({ cwd: "/repo/main/src" });
  });

  it("keeps unresolved distinct from no project when Rust project resolution fails", async () => {
    vi.mocked(resolveProjectRoot).mockRejectedValue(new Error("missing cwd"));

    await expect(resolveCurrentProjectRoot("/missing")).resolves.toEqual({
      kind: "unresolved",
      cwd: "/missing",
      error: "missing cwd",
    });
  });
});

describe("resolveProjectRootIfUnresolved", () => {
  beforeEach(() => {
    vi.mocked(resolveProjectRoot).mockReset();
  });

  it("retries unresolved project root resolution once", async () => {
    vi.mocked(resolveProjectRoot).mockResolvedValue("/repo/main");

    await expect(
      resolveProjectRootIfUnresolved({
        kind: "unresolved",
        cwd: "/repo/main/src",
        error: "temporary failure",
      }),
    ).resolves.toEqual({ kind: "resolved", root: "/repo/main" });

    expect(resolveProjectRoot).toHaveBeenCalledWith({ cwd: "/repo/main/src" });
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

describe("applyCurrentProjectSceneSelectionWithResolution", () => {
  beforeEach(() => {
    vi.mocked(resolveProjectRoot).mockReset();
  });

  it("does not dirty global activeScene when project resolution still fails", async () => {
    vi.mocked(resolveProjectRoot).mockRejectedValue(new Error("missing cwd"));
    const projectRoot = await resolveCurrentProjectRoot("/missing");
    const base = { ...EMPTY_CONFIG, activeScene: "global" };

    const result = await applyCurrentProjectSceneSelectionWithResolution(
      base,
      projectRoot,
      "factory",
    );

    expect(resolveProjectRoot).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      kind: "runtime-only",
      activeScene: "factory",
      projectRoot: { kind: "unresolved", cwd: "/missing", error: "missing cwd" },
    });
    expect(result).not.toHaveProperty("config");
    expect(base.activeScene).toBe("global");
  });

  it("writes sceneByProject when retry resolves the project root", async () => {
    vi.mocked(resolveProjectRoot)
      .mockRejectedValueOnce(new Error("temporary failure"))
      .mockResolvedValueOnce("/repo/main");
    const projectRoot = await resolveCurrentProjectRoot("/repo/main/src");
    const base = { ...EMPTY_CONFIG, activeScene: "global" };

    const result = await applyCurrentProjectSceneSelectionWithResolution(
      base,
      projectRoot,
      "factory",
    );

    expect(resolveProjectRoot).toHaveBeenCalledTimes(2);
    expect(result.kind).toBe("persisted");
    if (result.kind !== "persisted") throw new Error("expected persisted result");
    expect(result.config.activeScene).toBe("global");
    expect(result.config.sceneByProject).toEqual({ "/repo/main": "factory" });
    expect(result.activeScene).toBe("factory");
    expect(result.projectRoot).toEqual({ kind: "resolved", root: "/repo/main" });
  });
});
