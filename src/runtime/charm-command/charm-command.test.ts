import type { LogEntry } from "@charminal/sdk";
import { describe, expect, it } from "vitest";
import { CharmCommandDispatcher, type CharmRuntimeView } from "./charm-command";

// ─── Test helpers ─────────────────────────────────────────────

const stubView = (overrides: Partial<CharmRuntimeView> = {}): CharmRuntimeView => ({
  personas: () => [],
  recentLog: () => [],
  logSize: () => 0,
  now: () => 60_000,
  startedAt: 0,
  ...overrides,
});

const makeLogEntry = (overrides: Partial<LogEntry> = {}): LogEntry => ({
  timestamp: 1000,
  personaId: "test-persona",
  reaction: "distressed",
  noticed: false,
  ...overrides,
});

const createDispatcher = (overrides: Partial<CharmRuntimeView> = {}): CharmCommandDispatcher => {
  return new CharmCommandDispatcher(stubView(overrides));
};

// ─── Step 1: Parser + Dispatcher base ─────────────────────────

describe("CharmCommandDispatcher", () => {
  describe("parse", () => {
    it('strips "/charm" prefix', () => {
      const d = createDispatcher();
      expect(d.parse("/charm list")).toEqual({ command: "list", args: [] });
    });

    it('handles "/charm" with no args', () => {
      const d = createDispatcher();
      expect(d.parse("/charm")).toEqual({ command: "", args: [] });
    });

    it("handles empty string", () => {
      const d = createDispatcher();
      expect(d.parse("")).toEqual({ command: "", args: [] });
    });

    it("handles input without /charm prefix", () => {
      const d = createDispatcher();
      expect(d.parse("list")).toEqual({ command: "list", args: [] });
    });

    it("parses command with single arg", () => {
      const d = createDispatcher();
      expect(d.parse("/charm inspect night-owl")).toEqual({
        command: "inspect",
        args: ["night-owl"],
      });
    });

    it("parses command with multiple args", () => {
      const d = createDispatcher();
      expect(d.parse("/charm edit my-pack some text")).toEqual({
        command: "edit",
        args: ["my-pack", "some", "text"],
      });
    });

    it("trims surrounding whitespace", () => {
      const d = createDispatcher();
      expect(d.parse("  /charm   list  ")).toEqual({ command: "list", args: [] });
    });

    it("collapses internal whitespace", () => {
      const d = createDispatcher();
      expect(d.parse("/charm   inspect   night-owl")).toEqual({
        command: "inspect",
        args: ["night-owl"],
      });
    });
  });

  describe("dispatch routing", () => {
    it("routes to registered handler", () => {
      const d = createDispatcher();
      d.registerHandler("ping", {
        description: "test ping",
        execute: () => "pong",
      });
      expect(d.dispatch({ command: "ping", args: [] })).toBe("pong");
    });

    it("passes args to handler", () => {
      const d = createDispatcher();
      d.registerHandler("echo", {
        description: "test echo",
        execute: (args) => args.join(" "),
      });
      expect(d.dispatch({ command: "echo", args: ["hello", "world"] })).toBe("hello world");
    });

    it("returns error message for unknown command", () => {
      const d = createDispatcher();
      const result = d.dispatch({ command: "nonexistent", args: [] });
      expect(result).toContain("見つかりません");
      expect(result).toContain("/charm help");
    });

    it("includes unknown command name in error", () => {
      const d = createDispatcher();
      const result = d.dispatch({ command: "foobar", args: [] });
      expect(result).toContain("foobar");
    });
  });

  describe("execute (parse + dispatch)", () => {
    it("processes full /charm input end-to-end", () => {
      const d = createDispatcher();
      d.registerHandler("ping", {
        description: "test",
        execute: () => "pong",
      });
      expect(d.execute("/charm ping")).toBe("pong");
    });
  });

  describe("registeredCommands", () => {
    it("includes built-in commands", () => {
      const d = createDispatcher();
      const cmds = d.registeredCommands();
      expect(cmds).toContain("");
      expect(cmds).toContain("help");
      expect(cmds).toContain("list");
      expect(cmds).toContain("why");
      expect(cmds).toContain("state");
    });
  });
});

// ─── Step 2: /charm (no args) — status overview ───────────────

describe("/charm (status)", () => {
  it("contains Charminal Pack header", () => {
    const d = createDispatcher();
    const output = d.execute("/charm");
    expect(output).toContain("Charminal Pack");
  });

  it("shows active persona name", () => {
    const d = createDispatcher({
      personas: () => [{ id: "charminal-default", name: "Charminal" }],
    });
    const output = d.execute("/charm");
    expect(output).toContain("active persona:  Charminal");
  });

  it("shows multiple personas", () => {
    const d = createDispatcher({
      personas: () => [
        { id: "a", name: "Alice" },
        { id: "b", name: "Bob" },
      ],
    });
    const output = d.execute("/charm");
    expect(output).toContain("active persona:  Alice, Bob");
  });

  it("shows (none) when no personas registered", () => {
    const d = createDispatcher({ personas: () => [] });
    const output = d.execute("/charm");
    expect(output).toContain("active persona:  (none)");
  });

  it("shows placeholder for harness and effect", () => {
    const d = createDispatcher();
    const output = d.execute("/charm");
    expect(output).toContain("active harness:  (none)");
    expect(output).toContain("active effect:   (none)");
  });

  it("shows command hints", () => {
    const d = createDispatcher();
    const output = d.execute("/charm");
    expect(output).toContain("/charm list");
    expect(output).toContain("/charm why");
    expect(output).toContain("/charm help");
  });
});

// ─── Step 3: /charm help ──────────────────────────────────────

describe("/charm help", () => {
  it("contains header", () => {
    const d = createDispatcher();
    const output = d.execute("/charm help");
    expect(output).toContain("/charm コマンド一覧");
  });

  it("lists implemented commands", () => {
    const d = createDispatcher();
    const output = d.execute("/charm help");
    expect(output).toContain("/charm list");
    expect(output).toContain("/charm why");
    expect(output).toContain("/charm state");
    expect(output).toContain("/charm help");
  });

  it("lists coming-soon commands", () => {
    const d = createDispatcher();
    const output = d.execute("/charm help");
    expect(output).toContain("coming soon");
    expect(output).toContain("/charm inspect");
    expect(output).toContain("/charm create");
    expect(output).toContain("/charm edit");
    expect(output).toContain("/charm preview");
    expect(output).toContain("/charm validate");
    expect(output).toContain("/charm reload");
  });
});

// ─── Step 4: /charm list ──────────────────────────────────────

describe("/charm list", () => {
  it("shows persona section with active marker", () => {
    const d = createDispatcher({
      personas: () => [{ id: "charminal-default", name: "Charminal" }],
    });
    const output = d.execute("/charm list");
    expect(output).toContain("persona:");
    expect(output).toContain("charminal-default");
    expect(output).toContain("[active]");
  });

  it("shows multiple personas", () => {
    const d = createDispatcher({
      personas: () => [
        { id: "alice", name: "Alice" },
        { id: "bob", name: "Bob" },
      ],
    });
    const output = d.execute("/charm list");
    expect(output).toContain("alice");
    expect(output).toContain("bob");
  });

  it("shows (none) when no personas registered", () => {
    const d = createDispatcher({ personas: () => [] });
    const output = d.execute("/charm list");
    expect(output).toMatch(/persona:\n {2}\(none\)/);
  });

  it("shows harness and effect placeholders", () => {
    const d = createDispatcher();
    const output = d.execute("/charm list");
    expect(output).toMatch(/harness:\n {2}\(none\)/);
    expect(output).toMatch(/effect:\n {2}\(none\)/);
  });

  it("shows inspect hint", () => {
    const d = createDispatcher();
    const output = d.execute("/charm list");
    expect(output).toContain("/charm inspect");
  });
});

// ─── Step 5: /charm why ───────────────────────────────────────

describe("/charm why", () => {
  it("shows message when log is empty", () => {
    const d = createDispatcher({ recentLog: () => [] });
    const output = d.execute("/charm why");
    expect(output).toContain("まだ反応の記録がありません");
  });

  it("shows last reaction details", () => {
    const entry = makeLogEntry({
      reaction: "distressed",
      personaId: "night-owl",
      timestamp: new Date("2026-04-12T12:34:56").getTime(),
    });
    const d = createDispatcher({
      recentLog: () => [entry],
    });
    const output = d.execute("/charm why");
    expect(output).toContain("さっきの反応:");
    expect(output).toContain("reaction:  distressed");
    expect(output).toContain("persona:   night-owl");
    expect(output).toContain("時刻:");
  });

  it("includes note when present", () => {
    const entry = makeLogEntry({ note: "compile error detected" });
    const d = createDispatcher({
      recentLog: () => [entry],
    });
    const output = d.execute("/charm why");
    expect(output).toContain("note:      compile error detected");
  });

  it("omits note line when not present", () => {
    const entry = makeLogEntry({ note: undefined });
    const d = createDispatcher({
      recentLog: () => [entry],
    });
    const output = d.execute("/charm why");
    expect(output).not.toContain("note:");
  });
});

// ─── Step 6: /charm state ─────────────────────────────────────

describe("/charm state", () => {
  it("shows formatted uptime", () => {
    const d = createDispatcher({
      now: () => 754_000, // 12m 34s
      startedAt: 0,
    });
    const output = d.execute("/charm state");
    expect(output).toContain("uptime:     12m 34s");
  });

  it("shows seconds-only uptime when under 1 minute", () => {
    const d = createDispatcher({
      now: () => 45_000,
      startedAt: 0,
    });
    const output = d.execute("/charm state");
    expect(output).toContain("uptime:     45s");
  });

  it("shows hours when uptime exceeds 60 minutes", () => {
    const d = createDispatcher({
      now: () => 3_661_000, // 1h 1m 1s
      startedAt: 0,
    });
    const output = d.execute("/charm state");
    expect(output).toContain("uptime:     1h 1m 1s");
  });

  it("shows persona info", () => {
    const d = createDispatcher({
      personas: () => [{ id: "charminal-default", name: "Charminal" }],
    });
    const output = d.execute("/charm state");
    expect(output).toContain("persona:    charminal-default (1 registered)");
  });

  it("shows (none) when no personas", () => {
    const d = createDispatcher({ personas: () => [] });
    const output = d.execute("/charm state");
    expect(output).toContain("persona:    (none) (0 registered)");
  });

  it("shows log entry count", () => {
    const d = createDispatcher({ logSize: () => 42 });
    const output = d.execute("/charm state");
    expect(output).toContain("log:        42 entries");
  });

  it("shows harness and effect placeholders", () => {
    const d = createDispatcher();
    const output = d.execute("/charm state");
    expect(output).toContain("harnesses:  0");
    expect(output).toContain("effects:    0");
  });
});
