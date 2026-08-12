import { describe, expect, it, vi } from "vitest";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import { reconcileAmbientUiRegistration } from "./ambient-ui-activation";

function registry(active: readonly string[] = []) {
  const activeSet = new Set(active);
  return {
    value: {
      enable: vi.fn((id: string) => activeSet.add(id)),
      disable: vi.fn((id: string) => activeSet.delete(id)),
      getActiveSet: vi.fn(() => [...activeSet]),
    } as unknown as AmbientUiPackRegistry,
    activeSet,
  };
}

const config = (activeAmbientUi: readonly string[], disabledPacks: readonly string[] = []) =>
  JSON.stringify({ activeAmbientUi, disabledPacks });

describe("reconcileAmbientUiRegistration", () => {
  it("enables a newly added selected entry", async () => {
    const { value, activeSet } = registry();
    const result = await reconcileAmbientUiRegistration(
      { id: "new-overlay", replaced: false },
      { registry: value, readConfigText: async () => config(["new-overlay"]) },
    );

    expect(result).toEqual({ status: "enabled" });
    expect(activeSet).toEqual(new Set(["new-overlay"]));
  });

  it("keeps a selected replacement inactive when runtime state suppresses it", async () => {
    const { value, activeSet } = registry();
    const result = await reconcileAmbientUiRegistration(
      { id: "attention-aura", replaced: true },
      { registry: value, readConfigText: async () => config(["attention-aura"]) },
    );

    expect(result).toEqual({ status: "unchanged" });
    expect(value.enable).not.toHaveBeenCalled();
    expect(activeSet.size).toBe(0);
  });

  it("honors explicit host suppression for a newly re-created selected entry", async () => {
    const { value, activeSet } = registry();
    await reconcileAmbientUiRegistration(
      { id: "attention-aura", replaced: false },
      {
        registry: value,
        readConfigText: async () => config(["attention-aura"]),
        isRuntimeSuppressed: (id) => id === "attention-aura",
      },
    );

    expect(value.disable).toHaveBeenCalledWith("attention-aura");
    expect(activeSet.size).toBe(0);
  });

  it("disables only the target when it is disabled in config", async () => {
    const { value, activeSet } = registry(["my-overlay", "other-overlay"]);
    await reconcileAmbientUiRegistration(
      { id: "my-overlay", replaced: true },
      {
        registry: value,
        readConfigText: async () => config(["my-overlay", "other-overlay"], ["my-overlay"]),
      },
    );

    expect(activeSet).toEqual(new Set(["other-overlay"]));
    expect(value.disable).toHaveBeenCalledTimes(1);
    expect(value.disable).toHaveBeenCalledWith("my-overlay");
  });

  it("does not mutate active state when config I/O fails", async () => {
    const { value, activeSet } = registry(["my-overlay", "other-overlay"]);
    const result = await reconcileAmbientUiRegistration(
      { id: "my-overlay", replaced: true },
      {
        registry: value,
        readConfigText: async () => {
          throw new Error("temporary read failure");
        },
      },
    );

    expect(result).toEqual({ status: "skipped", reason: "temporary read failure" });
    expect(value.enable).not.toHaveBeenCalled();
    expect(value.disable).not.toHaveBeenCalled();
    expect(activeSet).toEqual(new Set(["my-overlay", "other-overlay"]));
  });

  it.each([
    "",
    "{ not json",
    "null",
    "[]",
  ])("does not apply defaults for invalid config %j", async (text) => {
    const { value, activeSet } = registry(["other-overlay"]);
    const result = await reconcileAmbientUiRegistration(
      { id: "attention-aura", replaced: false },
      { registry: value, readConfigText: async () => text },
    );

    expect(result.status).toBe("skipped");
    expect(value.enable).not.toHaveBeenCalled();
    expect(value.disable).not.toHaveBeenCalled();
    expect(activeSet).toEqual(new Set(["other-overlay"]));
  });
});
