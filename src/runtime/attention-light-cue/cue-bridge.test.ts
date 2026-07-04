import { describe, expect, it, vi } from "vitest";
import { AttentionLightSettingsStore } from "../three-runtime/attention-light-settings";
import { createWorkspaceAttentionStore } from "../workspace-attention/workspace-attention-store";
import { startAttentionLightCueBridge } from "./cue-bridge";
import { AttentionLightCueStore } from "./cue-store";

describe("attention light cue bridge", () => {
  it("awaiting-approval item の identity を組み立てて cueForAttention を呼ぶ", () => {
    const attentionStore = createWorkspaceAttentionStore();
    const cueForAttention = vi.fn(() => true);
    const cueStore = { cueForAttention } as unknown as AttentionLightCueStore;

    startAttentionLightCueBridge({ cueStore, attentionStore });

    attentionStore.upsert({
      sessionId: "session-1",
      locus: { kind: "session", sessionId: "session-1" },
      type: "awaiting-approval",
      severity: "medium",
      producer: { kind: "host", id: "test" },
      producerKey: "session-attention:session-1",
      detail: { receivedAt: 100, title: null, body: "承認してください", source: "hook" },
    });

    expect(cueForAttention).toHaveBeenCalledWith("session-1:100");
  });

  it("awaiting-approval 以外の item や detail 欠損では cue しない", () => {
    const attentionStore = createWorkspaceAttentionStore();
    const cueForAttention = vi.fn(() => true);
    const cueStore = { cueForAttention } as unknown as AttentionLightCueStore;

    startAttentionLightCueBridge({ cueStore, attentionStore });

    attentionStore.upsert({
      sessionId: "session-1",
      locus: {
        kind: "terminal-region",
        sessionId: "session-1",
        rect: { x: 0, y: 0, width: 10, height: 10 },
        range: { startRow: 0, endRow: 1, startCol: 0, endCol: 1 },
      },
      type: "run-failed",
      severity: "high",
      producer: { kind: "host", id: "test" },
      producerKey: "run:session-1",
    });
    attentionStore.upsert({
      sessionId: "session-2",
      locus: { kind: "session", sessionId: "session-2" },
      type: "awaiting-approval",
      severity: "medium",
      producer: { kind: "host", id: "test" },
      producerKey: "session-attention:session-2",
    });

    expect(cueForAttention).not.toHaveBeenCalled();
  });

  it("同じ identity で再度 upsert されても cue store の dedup で一度しか cue されない", () => {
    const attentionStore = createWorkspaceAttentionStore();
    const settings = new AttentionLightSettingsStore();
    const cueStore = new AttentionLightCueStore({ settings });

    startAttentionLightCueBridge({ cueStore, attentionStore });

    const upsertAwaiting = () =>
      attentionStore.upsert({
        sessionId: "session-1",
        locus: { kind: "session", sessionId: "session-1" },
        type: "awaiting-approval",
        severity: "medium",
        producer: { kind: "host", id: "test" },
        producerKey: "session-attention:session-1",
        detail: { receivedAt: 100, title: null, body: "承認してください", source: "hook" },
      });

    upsertAwaiting();
    upsertAwaiting();

    expect(cueStore.getCurrent()?.seq).toBe(1);
  });

  it("dispose 後は snapshot を購読しない", () => {
    const attentionStore = createWorkspaceAttentionStore();
    const cueForAttention = vi.fn(() => true);
    const cueStore = { cueForAttention } as unknown as AttentionLightCueStore;

    const disposable = startAttentionLightCueBridge({ cueStore, attentionStore });
    disposable.dispose();

    attentionStore.upsert({
      sessionId: "session-1",
      locus: { kind: "session", sessionId: "session-1" },
      type: "awaiting-approval",
      severity: "medium",
      producer: { kind: "host", id: "test" },
      producerKey: "session-attention:session-1",
      detail: { receivedAt: 100, title: null, body: "承認してください", source: "hook" },
    });

    expect(cueForAttention).not.toHaveBeenCalled();
  });
});
