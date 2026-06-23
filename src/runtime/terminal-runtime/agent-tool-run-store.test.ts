import { describe, expect, it } from "vitest";
import { AgentToolRunStore } from "./agent-tool-run-store";

describe("AgentToolRunStore", () => {
  it("activity 開始で running run を作り none で完了する", () => {
    const store = new AgentToolRunStore("claude-1");
    store.ingestActivity("running", 1000);
    expect(store.getRecent()[0]).toMatchObject({
      sessionId: "claude-1",
      activity: "running",
      startedAt: 1000,
      status: "running",
      endedAt: null,
    });
    store.ingestActivity("none", 1500);
    expect(store.getRecent()[0]).toMatchObject({
      status: "completed",
      endedAt: 1500,
      durationMs: 500,
    });
  });

  it("active 中の別 activity は run を増やさず継続する", () => {
    const store = new AgentToolRunStore("claude-1");
    store.ingestActivity("reading", 1000);
    store.ingestActivity("writing", 1100);
    expect(store.getRecent()).toHaveLength(1);
    expect(store.getRecent()[0]?.status).toBe("running");
  });

  it("none → none は run を作らない", () => {
    const store = new AgentToolRunStore("claude-1");
    store.ingestActivity("none", 1000);
    expect(store.getRecent()).toHaveLength(0);
  });

  it("連続した tool 実行は別 run になる", () => {
    const store = new AgentToolRunStore("claude-1");
    store.ingestActivity("running", 1000);
    store.ingestActivity("none", 1100);
    store.ingestActivity("running", 1200);
    store.ingestActivity("none", 1300);
    expect(store.getRecent()).toHaveLength(2);
    // 新しい順
    expect(store.getRecent()[0]?.startedAt).toBe(1200);
  });

  it("上限を超えた古い run は捨てる", () => {
    const store = new AgentToolRunStore("claude-1", { maxRuns: 2 });
    for (let i = 0; i < 3; i++) {
      store.ingestActivity("running", i * 100);
      store.ingestActivity("none", i * 100 + 50);
    }
    expect(store.getRecent()).toHaveLength(2);
  });
});
