import { describe, expect, it } from "vitest";
import type { WorkspaceAttentionCreateInput, WorkspaceAttentionItem } from "./types";
import {
  createWorkspaceAttentionStore,
  selectPrimaryItem,
  type WorkspaceAttentionStore,
} from "./workspace-attention-store";

const producer = { kind: "host" as const, id: "test-producer" };

function createClock(start = 1000): {
  readonly now: () => number;
  readonly advance: (ms: number) => void;
} {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function input(
  store: WorkspaceAttentionStore,
  override: Partial<WorkspaceAttentionCreateInput> = {},
): WorkspaceAttentionItem {
  return store.upsert({
    sessionId: "session-1",
    locus: {
      kind: "terminal-region",
      sessionId: "session-1",
      commandRunId: 1,
      rect: { x: 10, y: 20, width: 300, height: 40 },
      range: { startRow: 1, endRow: 3, startCol: 0, endCol: 79 },
    },
    type: "run-failed",
    severity: "high",
    producer,
    producerKey: "test:item",
    ...override,
  });
}

describe("WorkspaceAttentionStore", () => {
  it("active item と aggregate/primary projection を作る", () => {
    const clock = createClock();
    const store = createWorkspaceAttentionStore({ now: clock.now });

    const item = input(store);

    expect(store.getActiveItems()).toEqual([item]);
    expect(store.getPrimaryItem()).toEqual(item);
    expect(store.getAggregate()).toMatchObject({
      mood: "failed",
      severity: "high",
      activeCount: 1,
      producer: { kind: "host", id: "workspace-attention-store" },
    });
  });

  it("ack/snooze/resolve した item は active projection から外れる", () => {
    const store = createWorkspaceAttentionStore();
    const item = input(store);

    expect(store.ack(item.id)).toBe(true);
    expect(store.getActiveItems()).toHaveLength(0);
    expect(store.getAggregate().mood).toBe("calm");

    const snoozed = input(store, { producerKey: "test:snooze" });
    expect(store.snooze(snoozed.id)).toBe(true);
    expect(store.getActiveItems()).toHaveLength(0);

    const resolved = input(store, { producerKey: "test:resolve" });
    expect(store.resolve(resolved.id)).toBe(true);
    expect(store.getPrimaryItem()).toBeNull();
  });

  it("primary は severity を優先し、同 severity では古い item を選ぶ", () => {
    const clock = createClock();
    const store = createWorkspaceAttentionStore({ now: clock.now });
    const slow = input(store, {
      type: "run-slow-completed",
      severity: "medium",
      producerKey: "test:slow",
    });
    clock.advance(10_000);
    const failed = input(store, { producerKey: "test:failed" });

    expect(store.getPrimaryItem()).toEqual(failed);
    expect(selectPrimaryItem([slow, failed], clock.now())).toEqual(failed);

    const olderHigh = input(store, { producerKey: "test:older-high" });
    clock.advance(1000);
    const newerHigh = input(store, { producerKey: "test:newer-high" });

    expect(selectPrimaryItem([newerHigh, olderHigh], clock.now())).toEqual(olderHigh);
  });

  it("slow-completed だけの active item は waiting aggregate になる", () => {
    const store = createWorkspaceAttentionStore();

    input(store, {
      type: "run-slow-completed",
      severity: "medium",
      producerKey: "test:slow",
    });

    expect(store.getAggregate()).toMatchObject({
      mood: "waiting",
      severity: "medium",
      activeCount: 1,
    });
  });

  it("running-long だけの active item は working aggregate になる", () => {
    const store = createWorkspaceAttentionStore();

    input(store, {
      type: "run-running-long",
      severity: "medium",
      producerKey: "test:running-long",
    });

    expect(store.getAggregate()).toMatchObject({
      mood: "working",
      severity: "medium",
      activeCount: 1,
    });
  });

  it("subscribe は即時発火し、変更後 snapshot を通知する", () => {
    const store = createWorkspaceAttentionStore();
    const snapshots: number[] = [];

    const sub = store.subscribe((snapshot) => {
      snapshots.push(snapshot.activeItems.length);
    });
    input(store);
    sub.dispose();
    input(store, { producerKey: "test:after-dispose" });

    expect(snapshots).toEqual([0, 1]);
  });
});
