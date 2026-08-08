import { readFileSync } from "node:fs";
import type { Disposable } from "@yorishiro/sdk";
import { describe, expect, it } from "vitest";
import { type WorkStatusConsumerAdapter, WorkStatusConsumerConnection } from "./consumer-adapter";
import type {
  WorkStatusContractSource,
  WorkStatusEventV1,
  WorkStatusSnapshotV1,
} from "./consumer-contract";

const capabilities = {
  maxSnapshotBytes: 4_096,
  maxWorks: 20,
  eventPush: true,
  delegation: true,
  plainTextOnly: true,
} as const;

describe("work status consumer adapter contract", () => {
  it("delivers the neutral contract to a fake consumer", () => {
    const source = new FakeSource(snapshot(0));
    const consumer = new FakeConsumer();
    const connection = new WorkStatusConsumerConnection(source, consumer);
    const initial = connection.prepareInitialSnapshot();
    connection.connect();
    source.emit(event(1));

    expect(initial).toMatchObject({ schemaVersion: 1, epoch: "epoch-a", seq: 0 });
    expect(consumer.events).toMatchObject([
      { schemaVersion: 1, epoch: "epoch-a", seq: 1, kind: "work-created" },
    ]);
    expect(consumer.snapshots).toEqual([]);
    connection.dispose();
  });

  it("detects a seq gap and resyncs from a full snapshot without replay", () => {
    const source = new FakeSource(snapshot(0));
    const consumer = new FakeConsumer();
    const connection = new WorkStatusConsumerConnection(source, consumer);
    connection.prepareInitialSnapshot();
    connection.connect();

    source.setSnapshot(snapshot(2));
    source.emit(event(2));

    expect(consumer.events).toEqual([]);
    expect(consumer.snapshots).toMatchObject([{ reason: "resync", snapshot: { seq: 2 } }]);
    connection.dispose();
  });

  it("resyncs when an epoch changes", () => {
    const source = new FakeSource(snapshot(0));
    const consumer = new FakeConsumer();
    const connection = new WorkStatusConsumerConnection(source, consumer);
    connection.prepareInitialSnapshot();
    source.setSnapshot({ ...snapshot(0), epoch: "epoch-b" });
    connection.connect();

    expect(consumer.snapshots).toMatchObject([
      { reason: "resync", snapshot: { epoch: "epoch-b", seq: 0 } },
    ]);
  });

  it("keeps core and contract modules independent from the realtime consumer", () => {
    const files = ["consumer-contract.ts", "consumer-adapter.ts", "snapshot-composer.ts"];
    const forbidden = ["codex", "realtime"].join("-");
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(source).not.toContain(forbidden);
    }
  });
});

class FakeConsumer implements WorkStatusConsumerAdapter {
  readonly capabilities = capabilities;
  readonly snapshots: Array<{ snapshot: WorkStatusSnapshotV1; reason: string }> = [];
  readonly events: WorkStatusEventV1[] = [];

  deliverSnapshot(snapshot: WorkStatusSnapshotV1, reason: string): void {
    this.snapshots.push({ snapshot, reason });
  }

  deliverEvent(eventValue: WorkStatusEventV1): void {
    this.events.push(eventValue);
  }
}

class FakeSource implements WorkStatusContractSource {
  private readonly listeners = new Set<(eventValue: WorkStatusEventV1) => void>();

  constructor(private current: WorkStatusSnapshotV1) {}

  getSnapshot(): WorkStatusSnapshotV1 {
    return this.current;
  }

  setSnapshot(value: WorkStatusSnapshotV1): void {
    this.current = value;
  }

  subscribeEvents(listener: (eventValue: WorkStatusEventV1) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(value: WorkStatusEventV1): void {
    this.current = snapshot(value.seq);
    for (const listener of this.listeners) listener(value);
  }
}

function snapshot(seq: number): WorkStatusSnapshotV1 {
  return {
    schemaVersion: 1,
    epoch: "epoch-a",
    seq,
    observedAt: seq,
    works: [],
    activeCount: 0,
  };
}

function event(seq: number): WorkStatusEventV1 {
  return {
    schemaVersion: 1,
    epoch: "epoch-a",
    seq,
    observedAt: seq,
    kind: "work-created",
    work: {
      id: `work-${seq}`,
      summary: "Test work",
      status: "running",
      note: null,
      createdAt: seq,
      updatedAt: seq,
      approvalCount: 0,
    },
  };
}
