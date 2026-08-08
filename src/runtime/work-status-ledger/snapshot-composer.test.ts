import { describe, expect, it } from "vitest";
import type { WorkStatusContractWorkV1, WorkStatusSnapshotV1 } from "./consumer-contract";
import { composeWorkStatusEvent, composeWorkStatusSnapshot } from "./snapshot-composer";

const capabilities = {
  maxSnapshotBytes: 1_024,
  maxWorks: 2,
  eventPush: true,
  delegation: false,
  plainTextOnly: true,
} as const;

describe("work status snapshot composer", () => {
  it("preserves source order when no truncation is required", () => {
    const snapshot = fixtureSnapshot([
      fixtureWork("done", "completed", 30),
      fixtureWork("running", "running", 10),
    ]);
    const composed = composeWorkStatusSnapshot(snapshot, capabilities);

    expect(composed.works.map((work) => work.id)).toEqual(["done", "running"]);
    expect(composed.omittedWorkCount).toBeUndefined();
  });

  it("prioritizes approval and active work while reporting truncation", () => {
    const snapshot = fixtureSnapshot([
      fixtureWork("done-new", "completed", 30),
      fixtureWork("running", "running", 10),
      fixtureWork("approval", "approval-required", 5),
    ]);

    const composed = composeWorkStatusSnapshot(snapshot, capabilities);

    expect(composed.works.map((work) => work.id)).toEqual(["approval", "running"]);
    expect(composed.omittedWorkCount).toBe(1);
    expect(composed.activeCount).toBe(2);
    expect(new TextEncoder().encode(JSON.stringify(composed)).byteLength).toBeLessThanOrEqual(
      1_024,
    );
  });

  it("removes lowest-priority work until the byte budget fits", () => {
    const snapshot = fixtureSnapshot([
      fixtureWork("active", "running", 10, "あ".repeat(120)),
      fixtureWork("done", "completed", 20, "い".repeat(120)),
    ]);
    const composed = composeWorkStatusSnapshot(snapshot, {
      ...capabilities,
      maxWorks: 10,
      maxSnapshotBytes: 700,
    });

    expect(composed.works.map((work) => work.id)).toEqual(["active"]);
    expect(new TextEncoder().encode(JSON.stringify(composed)).byteLength).toBeLessThanOrEqual(700);
  });

  it("honors consumers that do not support event push", () => {
    const work = fixtureWork("one", "running", 1);
    const event = {
      schemaVersion: 1,
      epoch: "epoch",
      seq: 1,
      observedAt: 1,
      kind: "work-created",
      work,
    } as const;
    expect(composeWorkStatusEvent(event, { ...capabilities, eventPush: false })).toBeNull();
    expect(composeWorkStatusEvent(event, capabilities)).toBe(event);
  });
});

function fixtureSnapshot(works: ReadonlyArray<WorkStatusContractWorkV1>): WorkStatusSnapshotV1 {
  return {
    schemaVersion: 1,
    epoch: "epoch",
    seq: 3,
    observedAt: 30,
    works,
    activeCount: works.filter((work) => !["completed", "failed", "cancelled"].includes(work.status))
      .length,
  };
}

function fixtureWork(
  id: string,
  status: WorkStatusContractWorkV1["status"],
  updatedAt: number,
  summary = id,
): WorkStatusContractWorkV1 {
  return {
    id,
    summary,
    status,
    note: null,
    createdAt: 1,
    updatedAt,
    approvalCount: status === "approval-required" ? 1 : 0,
  };
}
