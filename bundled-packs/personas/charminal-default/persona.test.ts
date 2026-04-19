import type {
  AnimationHandle,
  AnimationRef,
  DispatchEvent,
  ExpressionHandle,
  ExpressionTarget,
  HookSignalEvent,
  PersonaContext,
  PlayOptions,
  PtyOutputEvent,
} from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import persona from "./persona";

const hookSignal = (name: HookSignalEvent["signal"]["name"]): HookSignalEvent => ({
  kind: "hook-signal",
  signal: { name, payload: {} },
  timestamp: 0,
});

/** tool_name を持つ PostToolUseFailure payload を生成する */
const postToolFailure = (toolName: string): HookSignalEvent => ({
  kind: "hook-signal",
  signal: {
    name: "post-tool-failure",
    payload: {
      session_id: "test-session",
      hook_event_name: "PostToolUseFailure",
      tool_name: toolName,
      tool_input: {},
      tool_response: {},
    },
  },
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

    it("skips shake for Grep post-tool-failure (no-match は benign)", () => {
      if (!trigger) throw new Error("trigger not registered");
      // ripgrep exit 1 = マッチなし。user にとってエラーではない。
      expect(trigger.match(postToolFailure("Grep"))).toBeNull();
    });

    it("skips shake for Glob post-tool-failure", () => {
      if (!trigger) throw new Error("trigger not registered");
      // ファイル列挙のみで副作用なし。failure も benign。
      expect(trigger.match(postToolFailure("Glob"))).toBeNull();
    });

    it("fires shake for Bash post-tool-failure", () => {
      if (!trigger) throw new Error("trigger not registered");
      const match = trigger.match(postToolFailure("Bash"));
      expect(match).not.toBeNull();
      expect(match?.reaction).toBe("distressed");
    });

    it("fires shake for Read post-tool-failure (filter 対象外・user 判断に委ねる)", () => {
      if (!trigger) throw new Error("trigger not registered");
      // Read の failure は legitimate な mistake の可能性もあるため抑止しない。
      const match = trigger.match(postToolFailure("Read"));
      expect(match).not.toBeNull();
      expect(match?.reaction).toBe("distressed");
    });
  });

  describe("git-push-success → celebrate trigger", () => {
    const trigger = triggers.find((t) => t.id === "charminal-default:git-push-success");

    it("is registered in customTriggers", () => {
      expect(trigger).toBeDefined();
    });

    const ptyOutput = (text: string): PtyOutputEvent => ({
      kind: "pty-output",
      text,
      timestamp: 0,
    });

    it("matches branch update pattern (abc123..def456 main -> main)", () => {
      if (!trigger) throw new Error("trigger not registered");
      const match = trigger.match(ptyOutput("   abc1234..def5678  main -> main\n"));
      expect(match).not.toBeNull();
      expect(match?.reaction).toBe("celebrate");
    });

    it("matches force push pattern (abc123...def456 main -> main)", () => {
      if (!trigger) throw new Error("trigger not registered");
      const match = trigger.match(ptyOutput("   abc1234...def5678  main -> main\n"));
      expect(match).not.toBeNull();
      expect(match?.reaction).toBe("celebrate");
    });

    it("matches [new branch] pattern", () => {
      if (!trigger) throw new Error("trigger not registered");
      const match = trigger.match(ptyOutput(" * [new branch]      feat/foo -> feat/foo\n"));
      expect(match).not.toBeNull();
      expect(match?.reaction).toBe("celebrate");
    });

    it("matches [new tag] pattern", () => {
      if (!trigger) throw new Error("trigger not registered");
      const match = trigger.match(ptyOutput(" * [new tag]         v1.0.0 -> v1.0.0\n"));
      expect(match).not.toBeNull();
      expect(match?.reaction).toBe("celebrate");
    });

    it("does not match unrelated pty output", () => {
      if (!trigger) throw new Error("trigger not registered");
      expect(trigger.match(ptyOutput("npm test\n"))).toBeNull();
      expect(trigger.match(ptyOutput("Compiling charminal v0.0.1\n"))).toBeNull();
    });

    it("does not match hook-signal events", () => {
      if (!trigger) throw new Error("trigger not registered");
      expect(trigger.match(hookSignal("post-tool-use"))).toBeNull();
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

      const samplePayload = {
        session_id: "test-session",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_input: { command: "exit 1" },
        tool_response: {},
      };

      const ctx = {
        event: {
          reaction: "distressed",
          triggeredBy: postToolFailure("Bash"),
          payload: samplePayload,
          trigger: null,
        },
        character: { play, express, gaze: vi.fn(), interrupt: vi.fn() },
        space: { injectEffect },
        log: { write: vi.fn(), tail: vi.fn(() => []), read: vi.fn(() => []) },
        time: { after: vi.fn(() => Promise.resolve()) },
        signal: { aborted: false, addEventListener: vi.fn() } as unknown as AbortSignal,
      } as unknown as PersonaContext;

      return { ctx, play, express, exprRelease, injectEffect, samplePayload };
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

    it("injects a screen-shake effect that reaches the terminal too", async () => {
      if (!handler) throw new Error("handler not registered");
      const { ctx, injectEffect } = buildMockCtx();

      await handler(ctx);

      expect(injectEffect).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "screen-shake",
          intensity: expect.any(Number),
          durationMs: expect.any(Number),
        }),
      );
    });

    it("writes a log entry with the full payload for observation", async () => {
      if (!handler) throw new Error("handler not registered");
      const { ctx, samplePayload } = buildMockCtx();
      const logWrite = ctx.log.write as ReturnType<typeof vi.fn>;

      await handler(ctx);

      // 観察ログが必ず書かれること、かつ payload が data として含まれることを確認。
      // これが regression すると「なぜ shake したか」の診断ができなくなる。
      expect(logWrite).toHaveBeenCalledWith(
        expect.objectContaining({
          reaction: "distressed",
          data: samplePayload,
        }),
      );
    });
  });
});
