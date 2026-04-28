/**
 * MotionScheduler — priority queue の pure-logic 単体 test。
 *
 * THREE.AnimationMixer を一切持ち込まず、onActivate / onDeactivate を
 * vi.fn() で mock した callbacks を渡して挙動を観察する。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MotionRequest,
  MotionScheduler,
  type MotionSchedulerCallbacks,
} from "./motion-scheduler";

// ─── Test utilities ──────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  scheduler: MotionScheduler;
  onActivate: ReturnType<typeof vi.fn>;
  onDeactivate: ReturnType<typeof vi.fn>;
  /**
   * activate() 1 回ごとに 1 つの deferred を返す queue。
   * test 側で resolve することで自然完了を擬似的に発火できる。
   */
  pendingActivations: Array<Deferred<void>>;
}

function makeHarness(): Harness {
  const pendingActivations: Array<Deferred<void>> = [];
  const onActivate = vi.fn((_req: MotionRequest): Promise<void> => {
    const d = deferred<void>();
    pendingActivations.push(d);
    return d.promise;
  });
  const onDeactivate = vi.fn((_fadeMs: number): void => {
    /* no-op for test */
  });
  const callbacks: MotionSchedulerCallbacks = {
    onActivate,
    onDeactivate,
    now: () => 1000,
  };
  return {
    scheduler: new MotionScheduler(callbacks),
    onActivate,
    onDeactivate,
    pendingActivations,
  };
}

const personaReq: MotionRequest = {
  source: "persona",
  priority: "persona-handler",
  animation: "anim:VRMA_wave",
};

const mcpReq: MotionRequest = {
  source: "mcp",
  priority: "mcp-conscious",
  animation: "anim:VRMA_bow",
};

const idleReq: MotionRequest = {
  source: "idle",
  priority: "idle-fidget",
  animation: "anim:VRMA_idle_breath",
};

// `flush` は microtask 解決を待つだけの helper。
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

// ─── Tests ───────────────────────────────────────────────

describe("MotionScheduler", () => {
  let h: Harness;

  beforeEach(() => {
    h = makeHarness();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("initial state: snapshot is empty", () => {
    const snap = h.scheduler.getSnapshot();
    expect(snap.active).toBeNull();
    expect(snap.preempted).toEqual([]);
  });

  it("first request activates and onActivate is called", () => {
    const handle = h.scheduler.request(personaReq);
    expect(h.onActivate).toHaveBeenCalledTimes(1);
    expect(h.onActivate).toHaveBeenCalledWith(personaReq);
    expect(handle.isActive()).toBe(true);
    expect(handle.isPreempted()).toBe(false);
    const snap = h.scheduler.getSnapshot();
    expect(snap.active).not.toBeNull();
    expect(snap.active?.source).toBe("persona");
    expect(snap.active?.priority).toBe("persona-handler");
    expect(snap.active?.animation).toBe("anim:VRMA_wave");
    expect(snap.active?.startedAt).toBe(1000);
  });

  it("higher priority preempts lower active", async () => {
    const lower = h.scheduler.request(personaReq);
    const higher = h.scheduler.request(mcpReq);

    // onDeactivate called once for the preempted persona, then onActivate for mcp
    expect(h.onDeactivate).toHaveBeenCalledTimes(1);
    expect(h.onActivate).toHaveBeenCalledTimes(2);
    expect(h.onActivate).toHaveBeenNthCalledWith(1, personaReq);
    expect(h.onActivate).toHaveBeenNthCalledWith(2, mcpReq);

    expect(lower.isActive()).toBe(false);
    expect(lower.isPreempted()).toBe(true);
    expect(higher.isActive()).toBe(true);

    const result = await lower.completion;
    expect(result.reason).toBe("preempted");

    const snap = h.scheduler.getSnapshot();
    expect(snap.active?.source).toBe("mcp");
  });

  it("lower priority is rejected when higher is active", async () => {
    const higher = h.scheduler.request(mcpReq);
    expect(h.onActivate).toHaveBeenCalledTimes(1);

    const rejected = h.scheduler.request(personaReq);

    // onActivate should NOT be called for the rejected one.
    expect(h.onActivate).toHaveBeenCalledTimes(1);
    // onDeactivate should NOT be called.
    expect(h.onDeactivate).not.toHaveBeenCalled();

    expect(rejected.isActive()).toBe(false);
    expect(rejected.isPreempted()).toBe(true);

    const result = await rejected.completion;
    expect(result.reason).toBe("preempted");

    expect(higher.isActive()).toBe(true);
    const snap = h.scheduler.getSnapshot();
    expect(snap.active?.source).toBe("mcp");
  });

  it("same priority replaces (last-write-wins)", async () => {
    const first = h.scheduler.request(personaReq);
    const secondReq: MotionRequest = {
      source: "persona",
      priority: "persona-handler",
      animation: "anim:VRMA_nod",
    };
    const second = h.scheduler.request(secondReq);

    expect(h.onDeactivate).toHaveBeenCalledTimes(1);
    expect(h.onActivate).toHaveBeenCalledTimes(2);

    expect(first.isPreempted()).toBe(true);
    expect(first.isActive()).toBe(false);
    expect(second.isActive()).toBe(true);

    const result = await first.completion;
    expect(result.reason).toBe("preempted");

    const snap = h.scheduler.getSnapshot();
    expect(snap.active?.animation).toBe("anim:VRMA_nod");
  });

  it("release() cancels active with given fade", async () => {
    const handle = h.scheduler.request(personaReq);
    handle.release(100);

    expect(h.onDeactivate).toHaveBeenCalledTimes(1);
    expect(h.onDeactivate).toHaveBeenCalledWith(100);

    const result = await handle.completion;
    expect(result.reason).toBe("cancelled");

    expect(handle.isActive()).toBe(false);
    expect(h.scheduler.getSnapshot().active).toBeNull();
  });

  it("cancel() cancels with fade=0", async () => {
    const handle = h.scheduler.request(personaReq);
    handle.cancel();

    expect(h.onDeactivate).toHaveBeenCalledTimes(1);
    expect(h.onDeactivate).toHaveBeenCalledWith(0);

    const result = await handle.completion;
    expect(result.reason).toBe("cancelled");

    expect(handle.isActive()).toBe(false);
    expect(h.scheduler.getSnapshot().active).toBeNull();
  });

  it("cancelAll() cancels active and clears snapshot", async () => {
    const handle = h.scheduler.request(personaReq);
    h.scheduler.cancelAll(200);

    expect(h.onDeactivate).toHaveBeenCalledTimes(1);
    expect(h.onDeactivate).toHaveBeenCalledWith(200);

    const result = await handle.completion;
    expect(result.reason).toBe("cancelled");

    expect(h.scheduler.getSnapshot().active).toBeNull();
  });

  it("natural completion: onActivate promise resolves -> reason=completed", async () => {
    const handle = h.scheduler.request(personaReq);
    expect(h.pendingActivations.length).toBe(1);

    // Simulate the mixer naturally finishing the clip.
    h.pendingActivations[0].resolve();
    await flush();

    const result = await handle.completion;
    expect(result.reason).toBe("completed");

    expect(handle.isActive()).toBe(false);
    expect(h.scheduler.getSnapshot().active).toBeNull();
  });

  it("fadeOutMs default of 250 used when options not given on preemption", () => {
    h.scheduler.request(personaReq); // no options
    h.scheduler.request(mcpReq); // higher, preempts persona

    expect(h.onDeactivate).toHaveBeenCalledTimes(1);
    expect(h.onDeactivate).toHaveBeenCalledWith(250);
  });

  it("sequence: persona -> mcp preempts -> mcp release -> snapshot null (stop model, no resume)", async () => {
    const persona = h.scheduler.request(personaReq);
    const mcp = h.scheduler.request(mcpReq);

    // persona preempted
    expect((await persona.completion).reason).toBe("preempted");

    // mcp release
    mcp.release();
    expect((await mcp.completion).reason).toBe("cancelled");

    // queue is single-active stop model: persona is NOT resumed.
    const snap = h.scheduler.getSnapshot();
    expect(snap.active).toBeNull();
    expect(snap.preempted).toEqual([]);

    // sanity: idle now can acquire
    const idle = h.scheduler.request(idleReq);
    expect(idle.isActive()).toBe(true);
  });
});
