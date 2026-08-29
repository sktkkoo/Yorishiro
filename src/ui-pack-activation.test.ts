import { describe, expect, it, vi } from "vitest";
import {
  isUiPackHostReady,
  resolvePersistedUiId,
  shouldAnimateTheaterTransition,
  shouldResumeHostPresenceForUiActivation,
  subscribeAndActivateCurrentUi,
} from "./ui-pack-activation";

const SETTINGS_PACK_ID = "yorishiro-settings";

describe("shouldResumeHostPresenceForUiActivation", () => {
  it("waits to activate persisted UI until terminal layout targets can mount", () => {
    expect(isUiPackHostReady(true, false, true)).toBe(false);
    expect(isUiPackHostReady(true, true, false)).toBe(false);
    expect(isUiPackHostReady(true, true, true)).toBe(true);
  });

  it("falls removed Overlay persistence back to Terminal", () => {
    expect(resolvePersistedUiId("overlay")).toBeNull();
    expect(resolvePersistedUiId("portrait")).toBe("portrait");
  });

  it("uses the Theater transition only when moving directly to or from Terminal", () => {
    expect(shouldAnimateTheaterTransition(null, "theater")).toBe(true);
    expect(shouldAnimateTheaterTransition("theater", null)).toBe(true);
    expect(shouldAnimateTheaterTransition("portrait", "theater")).toBe(false);
    expect(shouldAnimateTheaterTransition("theater", "companion")).toBe(false);
    expect(shouldAnimateTheaterTransition("immersive", "theater")).toBe(false);
  });

  it("activates a persisted UI immediately even when it predates subscription", () => {
    const persisted = { id: "companion" };
    const subscribed: { current: ((entry: typeof persisted | null) => void) | null } = {
      current: null,
    };
    const activate = vi.fn();
    const dispose = vi.fn();
    const subscription = subscribeAndActivateCurrentUi(
      {
        getActiveUi: () => persisted,
        subscribeActive: (listener) => {
          subscribed.current = listener;
          return { dispose };
        },
      },
      activate,
    );

    expect(activate).toHaveBeenCalledWith(persisted);
    subscribed.current?.(null);
    expect(activate).toHaveBeenLastCalledWith(null);
    subscription.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

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
