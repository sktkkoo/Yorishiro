import type {
  AnimationHandle,
  AnimationRef,
  DispatchEvent,
  ExpressionHandle,
  ExpressionTarget,
  HookSignalEvent,
  PersonaContext,
  PlayOptions,
} from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
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

  describe("distressed handler", () => {
    const handler = persona.reflex.responses.distressed?.handlers[0]?.handler;

    it("is registered", () => {
      expect(handler).toBeDefined();
    });

    const buildMockCtx = () => {
      const play = vi.fn<(ref: AnimationRef, opts?: PlayOptions) => AnimationHandle>(
        (animation) => ({
          animation,
          startedAt: 0,
          setWeight: () => {},
          stop: () => Promise.resolve(),
          cancel: () => {},
          completion: Promise.resolve(),
        }),
      );
      const exprRelease = vi.fn<(fadeMs?: number) => void>();
      const express = vi.fn<(t: ExpressionTarget, i: number) => ExpressionHandle>(
        (target, intensity) => ({
          target,
          requestedIntensity: intensity,
          effectiveWeight: 0,
          setIntensity: () => {},
          release: exprRelease,
        }),
      );
      const injectEffect = vi.fn(() => ({
        kind: "shake",
        startedAt: 0,
        completion: Promise.resolve(),
        cancel: () => {},
      }));

      const ctx = {
        character: { play, express, gaze: vi.fn(), interrupt: vi.fn() },
        space: { injectEffect },
        log: { write: vi.fn(), tail: vi.fn(() => []), read: vi.fn(() => []) },
        time: { after: vi.fn(() => Promise.resolve()) },
        signal: { aborted: false, addEventListener: vi.fn() } as unknown as AbortSignal,
      } as unknown as PersonaContext;

      return { ctx, play, express, exprRelease, injectEffect };
    };

    it("frowns with sad expression 0.7 and releases it later", async () => {
      if (!handler) throw new Error("handler not registered");
      const { ctx, express, exprRelease } = buildMockCtx();

      await handler(ctx);

      expect(express).toHaveBeenCalledWith({ kind: "mood", preset: "sad" }, 0.7);
      expect(exprRelease).toHaveBeenCalled();
    });

    it("does not play a body animation — face + shake carry the reaction", async () => {
      if (!handler) throw new Error("handler not registered");
      const { ctx, play } = buildMockCtx();

      await handler(ctx);

      // See docs/philosophy/CHARMINAL.md「意識に先立つ反応」— the canonical
      // example is a frown, and the old Charminal did not bind a VRMA to
      // error either. Body continuity comes from procedural bones.
      expect(play).not.toHaveBeenCalled();
    });

    it("injects a shake effect on the screen", async () => {
      if (!handler) throw new Error("handler not registered");
      const { ctx, injectEffect } = buildMockCtx();

      await handler(ctx);

      expect(injectEffect).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "shake",
          intensity: expect.any(Number),
          durationMs: expect.any(Number),
        }),
      );
    });
  });
});
