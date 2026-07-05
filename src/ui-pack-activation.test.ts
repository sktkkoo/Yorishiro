import { describe, expect, it } from "vitest";
import { shouldResumeHostPresenceForUiActivation } from "./ui-pack-activation";

const SETTINGS_PACK_ID = "yorishiro-settings";

describe("shouldResumeHostPresenceForUiActivation", () => {
  it("does not reopen host presence when opening settings", () => {
    expect(
      shouldResumeHostPresenceForUiActivation({
        entryId: SETTINGS_PACK_ID,
        layout: { sidebar: {}, presence: { target: "shell" } },
        presenceLevel: "closed",
        hostDefaultClosed: true,
        settingsPackId: SETTINGS_PACK_ID,
      }),
    ).toBe(false);
  });

  it("keeps reopening host presence for fullscreen UI packs", () => {
    expect(
      shouldResumeHostPresenceForUiActivation({
        entryId: "theater",
        layout: { sidebar: { width: "fullscreen" } },
        presenceLevel: "closed",
        hostDefaultClosed: true,
        settingsPackId: SETTINGS_PACK_ID,
      }),
    ).toBe(true);
  });
});
