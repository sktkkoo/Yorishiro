import { describe, expect, it, vi } from "vitest";

import {
  applyConfigUpdate,
  configPrimaryPersonaForSelection,
  filterPersonaOptionsForLanguage,
  packWorkbenchKey,
  resolveCloseTarget,
  resolvePersonaSelectValue,
  SETTINGS_PACK_ID,
  selectWorkbenchPack,
  summarizePackDiagnosis,
} from "./ui";

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

describe("localized CLAI persona options", () => {
  const personas = [
    { id: "clai", name: "CLAI", origin: "bundled" as const },
    { id: "clai-en", name: "CLAI", origin: "bundled" as const },
    { id: "clai-ja", name: "CLAI", origin: "bundled" as const },
    { id: "my-persona", name: "Mine", origin: "user" as const },
  ];

  it("shows only English CLAI for English UI language", () => {
    expect(filterPersonaOptionsForLanguage(personas, "en").map((p) => p.id)).toEqual([
      "clai-en",
      "my-persona",
    ]);
  });

  it("shows only Japanese CLAI for Japanese UI language", () => {
    expect(filterPersonaOptionsForLanguage(personas, "ja").map((p) => p.id)).toEqual([
      "clai-ja",
      "my-persona",
    ]);
  });

  it("shows the localized CLAI selection for unset or legacy CLAI config", () => {
    expect(resolvePersonaSelectValue(null, "ja")).toBe("clai-ja");
    expect(resolvePersonaSelectValue("clai", "en")).toBe("clai-en");
    expect(resolvePersonaSelectValue("clai-en", "ja")).toBe("clai-ja");
  });

  it("stores localized CLAI selection as null so language changes keep following", () => {
    expect(configPrimaryPersonaForSelection("clai-en")).toBeNull();
    expect(configPrimaryPersonaForSelection("clai-ja")).toBeNull();
    expect(configPrimaryPersonaForSelection("my-persona")).toBe("my-persona");
  });
});

describe("Pack Workbench helpers", () => {
  const packs = [
    {
      id: "ok-scene",
      kind: "scene",
      origin: "user" as const,
      status: "loaded" as const,
      isActive: false,
    },
    {
      id: "broken-effect",
      kind: "effect",
      origin: "user" as const,
      status: "failed" as const,
      isActive: false,
    },
  ];

  it("builds stable row keys from kind and id", () => {
    expect(packWorkbenchKey(packs[0])).toBe("scene:ok-scene");
  });

  it("keeps the previous selection when it still exists", () => {
    expect(selectWorkbenchPack("scene:ok-scene", packs)).toBe("scene:ok-scene");
  });

  it("selects the first problem pack when previous selection is gone", () => {
    expect(selectWorkbenchPack("scene:missing", packs)).toBe("effect:broken-effect");
  });

  it("summarizes diagnosis errors for the detail panel", () => {
    expect(
      summarizePackDiagnosis({
        id: "broken-effect",
        ok: false,
        diagnoses: [],
        diagnostics: [
          {
            severity: "error",
            code: "pack-load-failed",
            message: "module has no default export",
          },
        ],
        recommendations: [],
      }),
    ).toEqual({
      state: "error",
      title: "Pack needs attention",
      detail: "module has no default export",
    });
  });

  it("summarizes active healthy packs", () => {
    expect(
      summarizePackDiagnosis({
        id: "ok-scene",
        ok: true,
        diagnoses: [
          {
            id: "ok-scene",
            kind: "scene",
            origin: "user",
            status: "loaded",
            isActive: true,
          },
        ],
        diagnostics: [
          {
            severity: "info",
            code: "pack-loaded",
            message: "scene pack 'ok-scene' is loaded and active",
          },
        ],
        recommendations: [],
      }),
    ).toEqual({
      state: "healthy",
      title: "Pack looks healthy",
      detail: "The pack is loaded and active.",
    });
  });
});
