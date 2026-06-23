import { describe, expect, it } from "vitest";
import { LoopRunStore } from "./loop-run-store";

describe("LoopRunStore", () => {
  it("started で run を作り completed で終了する", () => {
    const store = new LoopRunStore();
    store.ingestPhase("started", "claude", 1000);
    expect(store.getRecent()[0]).toMatchObject({
      agent: "claude",
      phase: "started",
      status: "running",
      startedAt: 1000,
      endedAt: null,
    });
    store.ingestPhase("completed", "claude", 2000);
    expect(store.getRecent()[0]).toMatchObject({
      phase: "completed",
      status: "completed",
      endedAt: 2000,
    });
  });

  it("iterating は active run の phase を更新し run を増やさない", () => {
    const store = new LoopRunStore();
    store.ingestPhase("started", "claude", 1000);
    store.ingestPhase("iterating", "claude", 1100);
    expect(store.getRecent()).toHaveLength(1);
    expect(store.getRecent()[0]?.phase).toBe("iterating");
    expect(store.getRecent()[0]?.status).toBe("running");
  });

  it("failed で run を failed 終了する", () => {
    const store = new LoopRunStore();
    store.ingestPhase("started", "claude", 1000);
    store.ingestPhase("failed", "claude", 1500);
    expect(store.getRecent()[0]).toMatchObject({ status: "failed", endedAt: 1500 });
  });

  it("started 無しの iterating は run を作らない", () => {
    const store = new LoopRunStore();
    store.ingestPhase("iterating", "claude", 1000);
    expect(store.getRecent()).toHaveLength(0);
  });

  it("agent ごとに別の並行 run を持つ", () => {
    const store = new LoopRunStore();
    store.ingestPhase("started", "claude", 1000);
    store.ingestPhase("started", "codex", 1100);
    expect(store.getRecent()).toHaveLength(2);
    store.ingestPhase("completed", "claude", 1200);
    expect(store.getRecent().find((r) => r.agent === "claude")?.status).toBe("completed");
    expect(store.getRecent().find((r) => r.agent === "codex")?.status).toBe("running");
  });

  it("agent が null（pack announce）でも run を作れる", () => {
    const store = new LoopRunStore();
    store.ingestPhase("started", null, 1000);
    expect(store.getRecent()[0]?.agent).toBeNull();
  });
});
