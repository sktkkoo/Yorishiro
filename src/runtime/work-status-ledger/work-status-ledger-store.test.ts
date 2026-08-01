import { describe, expect, it } from "vitest";
import type { WorkStatusLedgerEvent, WorkStatusLedgerSnapshot } from "./types";
import { createWorkStatusLedgerStore } from "./work-status-ledger-store";

const ESC = "\u001b";

function createStore() {
  let time = 1_000;
  const store = createWorkStatusLedgerStore({ now: () => time });
  return { store, tick: (ms = 1) => (time += ms) };
}

describe("WorkStatusLedgerStore", () => {
  it("assigns stable sequential IDs that never change across the lifecycle", () => {
    const { store } = createStore();
    const first = store.create({ summary: "テストを直す" });
    const second = store.create({ summary: "ドキュメントを更新する" });

    expect(first.id).toBe("work-1");
    expect(second.id).toBe("work-2");

    store.markRunning(first.id);
    store.complete(first.id);
    expect(store.get(first.id)?.id).toBe("work-1");
  });

  it("starts delegated work as created with a sanitized summary", () => {
    const { store } = createStore();
    const task = store.create({
      summary: `${ESC}[31m npm test ${ESC}[0m を\r\n流す`,
      sessionId: "session-1",
    });

    expect(task.status).toBe("created");
    expect(task.summary).toBe("npm test を 流す");
    expect(task.sessionId).toBe("session-1");
    expect(task.pendingApprovals).toEqual([]);
  });

  it("rejects a delegation whose summary has no human-readable text", () => {
    const { store } = createStore();
    expect(() => store.create({ summary: `${ESC}[2J \r\n` })).toThrow(
      "Delegated work summary must contain human-readable text",
    );
  });

  it("walks created → running → completed and freezes terminal tasks", () => {
    const { store } = createStore();
    const task = store.create({ summary: "build を通す" });

    expect(store.markRunning(task.id)).toBe(true);
    expect(store.get(task.id)?.status).toBe("running");
    expect(store.complete(task.id, "全 gate green")).toBe(true);
    expect(store.get(task.id)?.status).toBe("completed");
    expect(store.get(task.id)?.note).toBe("全 gate green");

    // terminal 以後はどの遷移も拒否される。
    expect(store.markRunning(task.id)).toBe(false);
    expect(store.fail(task.id)).toBe(false);
    expect(store.cancel(task.id)).toBe(false);
    expect(store.holdApproval(task.id, "k")).toBe(false);
    expect(store.get(task.id)?.status).toBe("completed");
  });

  it("allows cancelling or failing a task that never started", () => {
    const { store } = createStore();
    const cancelled = store.create({ summary: "着手前に取り消す" });
    const failed = store.create({ summary: "起動に失敗する" });

    expect(store.cancel(cancelled.id)).toBe(true);
    expect(store.fail(failed.id, "spawn できなかった")).toBe(true);
    expect(store.get(cancelled.id)?.status).toBe("cancelled");
    expect(store.get(failed.id)?.status).toBe("failed");
  });

  it("rejects invalid transitions and unknown work IDs without throwing", () => {
    const { store } = createStore();
    const work = store.create({ summary: "まだ開始していない作業" });

    expect(store.complete(work.id)).toBe(false);
    expect(store.get(work.id)?.status).toBe("created");
    expect(store.markRunning("work-999")).toBe(false);
    expect(store.complete("work-999")).toBe(false);
    expect(store.fail("work-999")).toBe(false);
    expect(store.cancel("work-999")).toBe(false);
    expect(store.get("work-999")).toBeNull();
  });

  it("derives approval-required from pending approvals and returns to running", () => {
    const { store } = createStore();
    const task = store.create({ summary: "危険な command を含む作業" });
    store.markRunning(task.id);

    expect(store.holdApproval(task.id, "approval-1", "承認待ち")).toBe(true);
    expect(store.get(task.id)?.status).toBe("approval-required");
    expect(store.holdApproval(task.id, "approval-2")).toBe(true);

    expect(store.releaseApproval(task.id, "approval-1")).toBe(true);
    expect(store.get(task.id)?.status).toBe("approval-required");
    expect(store.releaseApproval(task.id, "approval-2")).toBe(true);
    expect(store.get(task.id)?.status).toBe("running");
  });

  it("rejects approval holds unless the task is running", () => {
    const { store } = createStore();
    const task = store.create({ summary: "未着手の作業" });
    expect(store.holdApproval(task.id, "k")).toBe(false);
    expect(store.releaseApproval(task.id, "k")).toBe(false);
    expect(store.releaseApproval("work-999", "k")).toBe(false);
  });

  it("treats a duplicate approval key as a no-op instead of stacking", () => {
    const { store } = createStore();
    const task = store.create({ summary: "作業" });
    store.markRunning(task.id);
    store.holdApproval(task.id, "same-key");
    expect(store.holdApproval(task.id, "same-key")).toBe(true);

    expect(store.get(task.id)?.pendingApprovals).toEqual(["same-key"]);
    expect(store.releaseApproval(task.id, "same-key")).toBe(true);
    expect(store.get(task.id)?.status).toBe("running");
  });

  it("clears pending approvals when a task reaches a terminal state", () => {
    const { store } = createStore();
    const task = store.create({ summary: "承認保留のまま取り消される作業" });
    store.markRunning(task.id);
    store.holdApproval(task.id, "approval-1");

    expect(store.cancel(task.id)).toBe(true);
    expect(store.get(task.id)?.status).toBe("cancelled");
    expect(store.get(task.id)?.pendingApprovals).toEqual([]);
  });

  it("sanitizes notes so raw terminal logs cannot leak into the ledger", () => {
    const { store } = createStore();
    const task = store.create({ summary: "作業" });
    store.markRunning(task.id, `${ESC}[32m✓${ESC}[0m 1234 tests\r\npassed`);
    expect(store.get(task.id)?.note).toBe("✓ 1234 tests passed");
  });

  it("emits created / updated events with the previous public status", () => {
    const { store } = createStore();
    const events: WorkStatusLedgerEvent[] = [];
    const subscription = store.subscribeEvents((event) => events.push(event));

    const task = store.create({ summary: "作業" });
    store.markRunning(task.id);
    store.holdApproval(task.id, "approval-1");
    store.releaseApproval(task.id, "approval-1");
    store.complete(task.id);
    subscription.dispose();
    store.create({ summary: "dispose 後" });

    expect(
      events.map((event) =>
        event.kind === "work-created"
          ? ["created", event.work.status]
          : [event.previousStatus, event.work.status],
      ),
    ).toEqual([
      ["created", "created"],
      ["created", "running"],
      ["running", "approval-required"],
      ["approval-required", "running"],
      ["running", "completed"],
    ]);
    expect(events.every((event) => event.workId === task.id)).toBe(true);
    expect(store.get(task.id)).toMatchObject({ id: task.id, status: "completed" });
  });

  it("notifies snapshot subscribers immediately and on every change", () => {
    const { store } = createStore();
    const snapshots: WorkStatusLedgerSnapshot[] = [];
    const subscription = store.subscribe((snapshot) => snapshots.push(snapshot));
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.work).toEqual([]);

    const task = store.create({ summary: "作業" });
    store.markRunning(task.id);
    expect(snapshots).toHaveLength(3);
    expect(snapshots[2]?.activeCount).toBe(1);
    expect(snapshots[2]?.work[0]?.status).toBe("running");

    subscription.dispose();
    store.complete(task.id);
    expect(snapshots).toHaveLength(3);
  });

  it("keeps snapshots immutable value objects per publish", () => {
    const { store } = createStore();
    const task = store.create({ summary: "作業" });
    const before = store.getSnapshot();
    store.markRunning(task.id);
    const after = store.getSnapshot();

    expect(before).not.toBe(after);
    expect(before.work[0]?.status).toBe("created");
    expect(after.work[0]?.status).toBe("running");
  });

  it("deep-freezes published snapshots, work items, approval lists, and events", () => {
    const { store } = createStore();
    const events: WorkStatusLedgerEvent[] = [];
    store.subscribeEvents((event) => events.push(event));

    const work = store.create({ summary: "変更できない作業" });
    store.markRunning(work.id);
    store.holdApproval(work.id, "approval-1");

    const snapshot = store.getSnapshot();
    const item = snapshot.work[0];
    const event = events[events.length - 1];
    expect(item).toBeDefined();
    expect(event).toBeDefined();
    if (!item || !event) throw new Error("expected published work");

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.work)).toBe(true);
    expect(Object.isFrozen(item)).toBe(true);
    expect(Object.isFrozen(item.pendingApprovals)).toBe(true);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.work)).toBe(true);
    expect(Object.isFrozen(event.work.pendingApprovals)).toBe(true);

    expect(() => {
      (snapshot as unknown as { activeCount: number }).activeCount = 99;
    }).toThrow(TypeError);
    expect(() => {
      (snapshot.work as unknown as Array<typeof item>).push(item);
    }).toThrow(TypeError);
    expect(() => {
      (item as unknown as { summary: string }).summary = "改竄";
    }).toThrow(TypeError);
    expect(() => {
      (item.pendingApprovals as unknown as string[]).push("forged");
    }).toThrow(TypeError);
    expect(() => {
      (event as unknown as { workId: string }).workId = "work-forged";
    }).toThrow(TypeError);
  });

  it("prevents one subscriber from mutating data observed by later subscribers", () => {
    const { store } = createStore();
    let snapshotMutationRejected = false;
    let eventMutationRejected = false;
    const snapshotSummaries: string[] = [];
    const eventSummaries: string[] = [];

    const firstSnapshot = store.subscribe((snapshot) => {
      const item = snapshot.work[0];
      if (!item) return;
      try {
        (item as unknown as { summary: string }).summary = "改竄された snapshot";
      } catch (error) {
        snapshotMutationRejected = error instanceof TypeError;
      }
    });
    const secondSnapshot = store.subscribe((snapshot) => {
      const item = snapshot.work[0];
      if (item) snapshotSummaries.push(item.summary);
    });
    const firstEvent = store.subscribeEvents((event) => {
      try {
        (event.work as unknown as { summary: string }).summary = "改竄された event";
      } catch (error) {
        eventMutationRejected = error instanceof TypeError;
      }
    });
    const secondEvent = store.subscribeEvents((event) => eventSummaries.push(event.work.summary));

    store.create({ summary: "正しい要約" });

    expect(snapshotMutationRejected).toBe(true);
    expect(eventMutationRejected).toBe(true);
    expect(snapshotSummaries).toEqual(["正しい要約"]);
    expect(eventSummaries).toEqual(["正しい要約"]);

    firstSnapshot.dispose();
    secondSnapshot.dispose();
    firstEvent.dispose();
    secondEvent.dispose();
  });

  it("prunes the oldest finished tasks beyond the retention cap but keeps active ones", () => {
    const { store, tick } = createStore();
    const active = store.create({ summary: "生き続ける作業" });
    store.markRunning(active.id);

    for (let i = 0; i < 25; i++) {
      const task = store.create({ summary: `終わった作業 ${i}` });
      store.markRunning(task.id);
      store.complete(task.id);
      tick();
    }

    const snapshot = store.getSnapshot();
    const finished = snapshot.work.filter((task) => task.status === "completed");
    expect(finished).toHaveLength(20);
    expect(finished[0]?.summary).toBe("終わった作業 5");
    expect(snapshot.work.some((task) => task.id === active.id)).toBe(true);
    expect(snapshot.activeCount).toBe(1);
  });
});
