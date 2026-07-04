import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectRoot } from "../../bindings/tauri-commands";
import { resolveCurrentProjectRoot } from "./project-context";

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
