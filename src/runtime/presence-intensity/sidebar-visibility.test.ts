// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  readPresenceSidebarWidth,
  SIDEBAR_BORDER_WIDTH_CSS_VAR,
  SIDEBAR_WIDTH_CSS_VAR,
  syncPresenceClosedStyles,
  writePresenceSidebarWidth,
} from "./sidebar-visibility";

describe("presence sidebar visibility styles", () => {
  it("writes width, border width, and closed class together", () => {
    const root = document.documentElement;
    const shell = document.createElement("div");

    writePresenceSidebarWidth(root, shell, 0);
    expect(root.style.getPropertyValue(SIDEBAR_WIDTH_CSS_VAR)).toBe("0px");
    expect(root.style.getPropertyValue(SIDEBAR_BORDER_WIDTH_CSS_VAR)).toBe("0px");
    expect(shell.classList.contains("presence-closed")).toBe(true);

    writePresenceSidebarWidth(root, shell, 120);
    expect(root.style.getPropertyValue(SIDEBAR_WIDTH_CSS_VAR)).toBe("120px");
    expect(root.style.getPropertyValue(SIDEBAR_BORDER_WIDTH_CSS_VAR)).toBe("1px");
    expect(shell.classList.contains("presence-closed")).toBe(false);
  });

  it("keeps the closed seam hidden when a shell node is recreated", () => {
    const root = document.documentElement;
    const shell = document.createElement("div");
    root.style.setProperty(SIDEBAR_WIDTH_CSS_VAR, "0px");

    syncPresenceClosedStyles(root, shell, true);

    expect(root.style.getPropertyValue(SIDEBAR_WIDTH_CSS_VAR)).toBe("0px");
    expect(root.style.getPropertyValue(SIDEBAR_BORDER_WIDTH_CSS_VAR)).toBe("0px");
    expect(shell.classList.contains("presence-closed")).toBe(true);
  });

  it("treats 0 as a real current width instead of falling back", () => {
    const root = document.documentElement;
    root.style.setProperty(SIDEBAR_WIDTH_CSS_VAR, "0px");

    expect(readPresenceSidebarWidth(root)).toBe(0);
  });
});
