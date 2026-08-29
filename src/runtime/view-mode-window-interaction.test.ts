// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  nextViewModeHudVisibility,
  shouldRevealViewModeHud,
  shouldStartViewModeWindowDrag,
} from "./view-mode-window-interaction";

describe("chrome-hidden View Mode window interaction", () => {
  it("starts primary drag only in chrome-hidden modes", () => {
    const canvas = document.createElement("canvas");
    expect(shouldStartViewModeWindowDrag(true, 0, canvas)).toBe(true);
    expect(shouldStartViewModeWindowDrag(false, 0, canvas)).toBe(false);
    expect(shouldStartViewModeWindowDrag(true, 2, canvas)).toBe(false);
  });

  it("excludes interactive descendants", () => {
    const button = document.createElement("button");
    const icon = document.createElement("span");
    button.append(icon);
    expect(shouldStartViewModeWindowDrag(true, 0, icon)).toBe(false);
  });

  it("uses secondary click to reveal the HUD", () => {
    expect(shouldRevealViewModeHud(true, 2)).toBe(true);
    expect(shouldRevealViewModeHud(true, 0)).toBe(false);
    expect(shouldRevealViewModeHud(false, 2)).toBe(false);
  });

  it("toggles the HUD off on a second secondary click", () => {
    const shown = nextViewModeHudVisibility(true, 2, false);
    expect(shown).toBe(true);
    expect(nextViewModeHudVisibility(true, 2, shown)).toBe(false);
  });

  it("lets a root capture handler see secondary click before a child stops bubbling", () => {
    const root = document.createElement("div");
    const canvas = document.createElement("canvas");
    root.append(canvas);
    let revealed = false;
    root.addEventListener(
      "contextmenu",
      (event) => {
        revealed = shouldRevealViewModeHud(true, event.button);
      },
      { capture: true },
    );
    canvas.addEventListener("contextmenu", (event) => event.stopPropagation());

    canvas.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, button: 2 }));

    expect(revealed).toBe(true);
  });
});
