import { describe, expect, it } from "vitest";
import { parseOscNotification } from "./osc-notification";

describe("parseOscNotification", () => {
  it("parses OSC 9 as a body-only notification", () => {
    expect(parseOscNotification(9, "approval requested")).toEqual({
      title: null,
      body: "approval requested",
    });
  });

  it("ignores empty notifications", () => {
    expect(parseOscNotification(9, "  ")).toBeNull();
    expect(parseOscNotification(777, "notify;;")).toBeNull();
  });

  it("parses OSC 777 notify title and body", () => {
    expect(parseOscNotification(777, "notify;Claude;Permission needed;Bash(ls)")).toEqual({
      title: "Claude",
      body: "Permission needed;Bash(ls)",
    });
  });

  it("ignores non-notify OSC 777 commands", () => {
    expect(parseOscNotification(777, "precmd;ignored")).toBeNull();
  });

  it("parses OSC 99 with metadata prefix", () => {
    expect(parseOscNotification(99, "i=42:d=0;Agent turn complete")).toEqual({
      title: null,
      body: "Agent turn complete",
    });
  });

  it("keeps semicolon bodies when OSC 99 head is not metadata", () => {
    expect(parseOscNotification(99, "Claude;needs input")).toEqual({
      title: null,
      body: "Claude;needs input",
    });
  });
});
