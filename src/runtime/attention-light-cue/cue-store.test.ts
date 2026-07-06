import { describe, expect, it } from "vitest";
import { AttentionLightSettingsStore } from "../three-runtime/attention-light-settings";
import { AttentionLightCueStore, MCP_CUE_COOLDOWN_MS } from "./cue-store";

function createStore(now?: () => number) {
  const settings = new AttentionLightSettingsStore();
  const store = new AttentionLightCueStore({ settings, now });
  return { settings, store };
}

describe("AttentionLightCueStore", () => {
  it("同じ identity では二度 cue しない（dedup）", () => {
    const { store } = createStore();

    expect(store.cueForAttention("session-1:100")).toBe(true);
    expect(store.cueForAttention("session-1:100")).toBe(false);
    expect(store.getCurrent()?.seq).toBe(1);
  });

  it("新しい identity が来たら seq が増える（envelope 再スタート）", () => {
    const { store } = createStore();

    store.cueForAttention("session-1:100");
    expect(store.getCurrent()?.seq).toBe(1);

    store.cueForAttention("session-2:200");
    expect(store.getCurrent()?.seq).toBe(2);
    expect(store.getCurrent()?.reason).toBe("session-attention");
  });

  it("run cue は dedup しつつ sessionId を保持する", () => {
    const { store } = createStore();

    expect(
      store.cueForRun("run-failed", "run:session-1:command-block:session-1:1", "session-1"),
    ).toBe(true);
    expect(
      store.cueForRun("run-failed", "run:session-1:command-block:session-1:1", "session-1"),
    ).toBe(false);

    expect(store.getCurrent()).toMatchObject({
      seq: 1,
      reason: "run-failed",
      sessionId: "session-1",
    });
  });

  it("toggle off の間は cue も dedup 記録もしない", () => {
    const { settings, store } = createStore();
    settings.setEnabled(false);

    expect(store.cueForAttention("session-1:100")).toBe(false);
    expect(store.getCurrent()).toBeNull();

    settings.setEnabled(true);
    // off の間は記録されていないので、同じ identity でも再度 cue される。
    expect(store.cueForAttention("session-1:100")).toBe(true);
  });

  it("subscribe した listener は cue 発火時のみ呼ばれる", () => {
    const { settings, store } = createStore();
    settings.setEnabled(false);
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });

    store.cueForAttention("session-1:100");
    expect(calls).toBe(0);

    settings.setEnabled(true);
    store.cueForAttention("session-1:100");
    expect(calls).toBe(1);

    store.cueForAttention("session-1:100");
    expect(calls).toBe(1);

    unsubscribe();
    store.cueForAttention("session-2:200");
    expect(calls).toBe(1);
  });

  it("triggerManual: settings off なら disabled", () => {
    const { settings, store } = createStore();
    settings.setEnabled(false);

    expect(store.triggerManual()).toEqual({ triggered: false, reason: "disabled" });
  });

  it("triggerManual: cooldown 内の連続呼び出しは cooldown", () => {
    let now = 0;
    const { store } = createStore(() => now);

    expect(store.triggerManual()).toEqual({ triggered: true });
    expect(store.getCurrent()?.reason).toBe("mcp");

    now += MCP_CUE_COOLDOWN_MS - 1;
    expect(store.triggerManual()).toEqual({ triggered: false, reason: "cooldown" });

    now += 1;
    expect(store.triggerManual()).toEqual({ triggered: true });
  });
});
