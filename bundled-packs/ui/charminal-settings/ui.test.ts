import { describe, expect, it } from "vitest";

import { PREVIOUS_ACTIVE_UI_KEY, resolveCloseTarget, SETTINGS_PACK_ID } from "./ui";

describe("定数", () => {
  it("PREVIOUS_ACTIVE_UI_KEY はキー文字列として export されている", () => {
    expect(typeof PREVIOUS_ACTIVE_UI_KEY).toBe("string");
  });
});

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
