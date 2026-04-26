import { describe, expect, it, vi } from "vitest";

import { applyConfigUpdate, resolveCloseTarget, SETTINGS_PACK_ID } from "./ui";

describe("resolveCloseTarget", () => {
  it("returns the saved previous id when valid", () => {
    expect(resolveCloseTarget({ saved: "attention-aura", availableIds: ["attention-aura"] })).toBe(
      "attention-aura",
    );
  });

  it("returns null when no previous id is saved", () => {
    expect(resolveCloseTarget({ saved: null, availableIds: ["attention-aura"] })).toBeNull();
  });

  it("returns null when saved id refers to settings itself (init.js mistake)", () => {
    expect(
      resolveCloseTarget({ saved: SETTINGS_PACK_ID, availableIds: [SETTINGS_PACK_ID] }),
    ).toBeNull();
  });

  it("returns null when saved id is no longer in available ids (disabled / hot reload removal)", () => {
    expect(resolveCloseTarget({ saved: "old-pack", availableIds: ["attention-aura"] })).toBeNull();
  });
});

describe("applyConfigUpdate", () => {
  it("commits the next value when write succeeds", async () => {
    const setLocal = vi.fn();
    const write = vi.fn().mockResolvedValue(undefined);
    const emitEvent = vi.fn();
    await applyConfigUpdate({
      next: "scene-a",
      prev: null,
      setLocal,
      write,
      emitEvent,
      field: "activeScene",
    });
    expect(setLocal).toHaveBeenCalledWith("scene-a");
    expect(setLocal).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith("scene-a");
    expect(emitEvent).not.toHaveBeenCalled();
  });

  it("rolls back and emits write-failed when write rejects", async () => {
    const setLocal = vi.fn();
    const write = vi.fn().mockRejectedValue(new Error("disk full"));
    const emitEvent = vi.fn();
    await applyConfigUpdate({
      next: "scene-a",
      prev: "scene-quiet",
      setLocal,
      write,
      emitEvent,
      field: "activeScene",
    });
    expect(setLocal).toHaveBeenNthCalledWith(1, "scene-a");
    expect(setLocal).toHaveBeenNthCalledWith(2, "scene-quiet");
    expect(emitEvent).toHaveBeenCalledWith("charminal-settings:write-failed", {
      field: "activeScene",
      reason: "disk full",
    });
  });
});
