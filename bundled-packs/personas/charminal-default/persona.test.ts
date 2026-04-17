import type { DispatchEvent, HookSignalEvent } from "@charminal/sdk";
import { describe, expect, it } from "vitest";
import persona from "./persona";

const hookSignal = (name: HookSignalEvent["signal"]["name"]): HookSignalEvent => ({
  kind: "hook-signal",
  signal: { name, payload: {} },
  timestamp: 0,
});

describe("charminal-default persona triggers", () => {
  const triggers = persona.reflex.customTriggers ?? [];

  describe("error → distressed trigger", () => {
    const trigger = triggers.find((t) => t.id === "charminal-default:error");

    it("is registered in customTriggers", () => {
      expect(trigger).toBeDefined();
    });

    it("matches hook-signal post-tool-failure with reaction=distressed", () => {
      if (!trigger) throw new Error("trigger not registered");
      const match = trigger.match(hookSignal("post-tool-failure"));
      expect(match).not.toBeNull();
      expect(match?.reaction).toBe("distressed");
    });

    it("does not match unrelated hook signals", () => {
      if (!trigger) throw new Error("trigger not registered");
      expect(trigger.match(hookSignal("pre-tool-use"))).toBeNull();
      expect(trigger.match(hookSignal("post-tool-use"))).toBeNull();
      expect(trigger.match(hookSignal("stop"))).toBeNull();
    });

    it("does not match non-hook events", () => {
      if (!trigger) throw new Error("trigger not registered");
      const ptyEvent: DispatchEvent = { kind: "pty-output", text: "whatever", timestamp: 0 };
      expect(trigger.match(ptyEvent)).toBeNull();
    });
  });
});
