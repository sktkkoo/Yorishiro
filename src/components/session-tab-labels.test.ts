import { describe, expect, it } from "vitest";
import {
  compactHomePath,
  formatMainSessionTabLabel,
  formatPathLabel,
  formatShellSessionTabLabel,
  truncateMiddle,
} from "./session-tab-labels";

describe("session tab labels", () => {
  it("uses the persona name for the main session", () => {
    expect(formatMainSessionTabLabel("Yori")).toBe("Yori");
  });

  it("falls back to Agent when the persona name is blank", () => {
    expect(formatMainSessionTabLabel(" ")).toBe("Agent");
  });

  it("compacts home paths for shell sessions", () => {
    expect(formatShellSessionTabLabel(null)).toBe("~");
    expect(formatShellSessionTabLabel("/Users/alice", { homeDir: "/Users/alice" })).toBe("~");
    expect(formatShellSessionTabLabel("/Users/alice/Yorishiro", { homeDir: "/Users/alice" })).toBe(
      "~/Yorishiro",
    );
    expect(
      formatShellSessionTabLabel("/home/alice/projects/Yorishiro", { homeDir: "/home/alice" }),
    ).toBe("~/projects/Yorishiro");
  });

  it("does not compact paths without the OS home directory", () => {
    expect(formatShellSessionTabLabel("/Users/alice")).toBe("/Users/alice");
    expect(formatPathLabel("/home/alice/projects/Yorishiro")).toBe(
      "/home/alice/projects/Yorishiro",
    );
  });

  it("uses the same path label for project folders", () => {
    expect(formatPathLabel(null)).toBe("~");
    expect(formatPathLabel("/Users/alice", { homeDir: "/Users/alice" })).toBe("~");
    expect(formatPathLabel("/Users/alice/Yorishiro", { homeDir: "/Users/alice" })).toBe(
      "~/Yorishiro",
    );
  });

  it("does not treat sibling paths as home", () => {
    expect(formatPathLabel("/Users/Shared", { homeDir: "/Users/alice" })).toBe("/Users/Shared");
    expect(formatPathLabel("/Users/alice-shared/project", { homeDir: "/Users/alice" })).toBe(
      "/Users/alice-shared/project",
    );
    expect(formatShellSessionTabLabel("/Users/Shared/project", { homeDir: "/Users/alice" })).toBe(
      "/Users/Shared/project",
    );
  });

  it("keeps already compact paths compact", () => {
    expect(compactHomePath("~/Yorishiro")).toBe("~/Yorishiro");
  });

  it("truncates long labels from the middle", () => {
    expect(truncateMiddle("abcdefghijklmnopqrstuvwxyz", 10)).toBe("abcde…wxyz");
  });
});
