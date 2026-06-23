import type { ExpressionHandle } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import type { Body } from "../../core/body";
import type { AttentionRuntime } from "../attention-runtime/types";
import { startWorkspaceAttentionPresenceBridge } from "./presence-bridge";
import { createWorkspaceAttentionStore } from "./workspace-attention-store";

type BodyExpressionSlotAcquirer = Pick<Body, "acquireExpressionSlot">;

function createAttentionFake(): {
  readonly attention: AttentionRuntime;
  readonly setSourceTarget: ReturnType<typeof vi.fn>;
} {
  const setSourceTarget = vi.fn();
  return {
    attention: {
      get: () => ({ target: null }),
      subscribe: () => ({ dispose: vi.fn() }),
      setSourceTarget,
    },
    setSourceTarget,
  };
}

function createBodyFake(): {
  readonly body: BodyExpressionSlotAcquirer;
  readonly handle: ExpressionHandle;
} {
  const handle = {
    target: { kind: "preset", preset: "sad" },
    requestedIntensity: 0,
    effectiveWeight: 0,
    setIntensity: vi.fn(),
    release: vi.fn(),
  } as unknown as ExpressionHandle;
  const acquireExpressionSlot = vi.fn<BodyExpressionSlotAcquirer["acquireExpressionSlot"]>(
    () => handle,
  );
  return {
    body: {
      acquireExpressionSlot,
    },
    handle,
  };
}

function createTimerFake(): {
  readonly setTimeout: (fn: () => void, delay: number) => number;
  readonly clearTimeout: (id: unknown) => void;
  readonly fire: (index?: number) => void;
  readonly delays: number[];
} {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  return {
    setTimeout: (fn, delay) => {
      callbacks.push(fn);
      delays.push(delay);
      return callbacks.length - 1;
    },
    clearTimeout: vi.fn<(id: unknown) => void>(),
    fire: (index = callbacks.length - 1) => {
      callbacks[index]?.();
    },
    delays,
  };
}

describe("workspace attention presence bridge", () => {
  it("primary terminal-region を aura source に投影し、severity で表情を pulse する", () => {
    const store = createWorkspaceAttentionStore();
    const attention = createAttentionFake();
    const body = createBodyFake();
    const timer = createTimerFake();

    startWorkspaceAttentionPresenceBridge({
      store,
      attention: attention.attention,
      getBody: () => body.body,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
      now: () => 123,
    });

    store.upsert({
      sessionId: "session-1",
      locus: {
        kind: "terminal-region",
        sessionId: "session-1",
        commandRunId: 4,
        rect: { x: 20, y: 30, width: 500, height: 80 },
        range: { startRow: 2, endRow: 6, startCol: 0, endCol: 79 },
      },
      type: "run-failed",
      severity: "high",
      producer: { kind: "host", id: "test" },
      producerKey: "test:failed",
    });

    expect(attention.setSourceTarget).toHaveBeenLastCalledWith("workspace-attention:primary", {
      kind: "terminal-region",
      source: "workspace-attention:primary",
      rect: { x: 20, y: 30, width: 500, height: 80 },
      confidence: 0.95,
      priority: 9,
      timestamp: 123,
      reason: "workspace-attention:run-failed",
    });
    expect(body.body.acquireExpressionSlot).toHaveBeenCalledWith("persona", "mood", "sad", 0.26);
    expect(timer.delays).toEqual([2400]);

    timer.fire();
    expect(body.handle.release).toHaveBeenCalledWith(600);
  });

  it("同じ primary item の更新では表情を再 acquire しない", () => {
    const store = createWorkspaceAttentionStore();
    const attention = createAttentionFake();
    const body = createBodyFake();

    startWorkspaceAttentionPresenceBridge({
      store,
      attention: attention.attention,
      getBody: () => body.body,
      setTimeout: (fn) => {
        void fn;
        return 1;
      },
      clearTimeout: vi.fn<(id: unknown) => void>(),
    });

    const base = {
      sessionId: "session-1",
      locus: {
        kind: "terminal-region" as const,
        sessionId: "session-1",
        commandRunId: 4,
        rect: { x: 20, y: 30, width: 500, height: 80 },
        range: { startRow: 2, endRow: 6, startCol: 0, endCol: 79 },
      },
      type: "run-failed" as const,
      severity: "high" as const,
      producer: { kind: "host" as const, id: "test" },
      producerKey: "test:failed",
    };
    store.upsert(base);
    store.upsert({ ...base, detail: { repeated: true } });

    expect(body.body.acquireExpressionSlot).toHaveBeenCalledTimes(1);
  });

  it("primary が無い時は aura source と表情を clear する", () => {
    const store = createWorkspaceAttentionStore();
    const attention = createAttentionFake();
    const body = createBodyFake();
    const timer = createTimerFake();

    startWorkspaceAttentionPresenceBridge({
      store,
      attention: attention.attention,
      getBody: () => body.body,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });
    const item = store.upsert({
      sessionId: "session-1",
      locus: {
        kind: "terminal-region",
        sessionId: "session-1",
        rect: { x: 20, y: 30, width: 500, height: 80 },
        range: { startRow: 2, endRow: 6, startCol: 0, endCol: 79 },
      },
      type: "run-slow-completed",
      severity: "medium",
      producer: { kind: "host", id: "test" },
      producerKey: "test:slow",
    });

    store.resolve(item.id);

    expect(attention.setSourceTarget).toHaveBeenLastCalledWith("workspace-attention:primary", null);
    expect(body.handle.release).toHaveBeenCalledWith(600);
  });

  it("invalid rect は aura に出さず、severity の表情だけ pulse する", () => {
    const store = createWorkspaceAttentionStore();
    const attention = createAttentionFake();
    const body = createBodyFake();

    startWorkspaceAttentionPresenceBridge({
      store,
      attention: attention.attention,
      getBody: () => body.body,
      setTimeout: () => 1,
      clearTimeout: vi.fn<(id: unknown) => void>(),
    });

    store.upsert({
      sessionId: "session-1",
      locus: {
        kind: "terminal-region",
        sessionId: "session-1",
        rect: { x: 20, y: 30, width: 0, height: 80 },
        range: { startRow: 2, endRow: 6, startCol: 0, endCol: 79 },
      },
      type: "run-slow-completed",
      severity: "medium",
      producer: { kind: "host", id: "test" },
      producerKey: "test:slow",
    });

    expect(attention.setSourceTarget).toHaveBeenLastCalledWith("workspace-attention:primary", null);
    expect(body.body.acquireExpressionSlot).toHaveBeenCalledWith("persona", "mood", "sad", 0.16);
  });
});
