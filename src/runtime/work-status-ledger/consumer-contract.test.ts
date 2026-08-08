import { describe, expect, it } from "vitest";
import { WorkStatusContractPublisher } from "./consumer-contract";
import { createWorkStatusLedgerStore } from "./work-status-ledger-store";

describe("work status consumer contract", () => {
  it("publishes immutable schema-versioned snapshots and monotonic events", () => {
    let now = 1_000;
    const ledger = createWorkStatusLedgerStore({ now: () => now });
    const publisher = new WorkStatusContractPublisher(ledger, {
      epoch: "epoch-test",
      now: () => now,
    });
    const events: unknown[] = [];
    publisher.subscribeEvents((event) => events.push(event));

    const created = ledger.create({ summary: "Review release", sessionId: "native-secret" });
    now++;
    ledger.markRunning(created.id);

    expect(publisher.getSnapshot()).toMatchObject({
      schemaVersion: 1,
      epoch: "epoch-test",
      seq: 2,
      observedAt: 1_001,
      activeCount: 1,
      works: [{ id: created.id, summary: "Review release", status: "running" }],
    });
    expect(events).toMatchObject([
      { schemaVersion: 1, epoch: "epoch-test", seq: 1, kind: "work-created" },
      { schemaVersion: 1, epoch: "epoch-test", seq: 2, kind: "work-updated" },
    ]);
    expect(Object.isFrozen(publisher.getSnapshot())).toBe(true);
    expect(Object.isFrozen(publisher.getSnapshot().works)).toBe(true);
    publisher.dispose();
  });

  it("does not expose native session or approval identifiers", () => {
    const ledger = createWorkStatusLedgerStore();
    const publisher = new WorkStatusContractPublisher(ledger, { epoch: "safe" });
    const work = ledger.create({ summary: "Publish", sessionId: "session-secret-canary" });
    ledger.markRunning(work.id);
    ledger.holdApproval(work.id, "approval-secret-canary", "Needs approval");

    const serialized = JSON.stringify(publisher.getSnapshot());
    expect(serialized).toContain('"approvalCount":1');
    expect(serialized).not.toContain("session-secret-canary");
    expect(serialized).not.toContain("approval-secret-canary");
    expect(serialized).not.toContain("pendingApprovals");
    publisher.dispose();
  });
});
