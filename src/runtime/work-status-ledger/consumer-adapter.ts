import type { Disposable } from "@yorishiro/sdk";
import type {
  WorkStatusContractSource,
  WorkStatusEventV1,
  WorkStatusSnapshotV1,
} from "./consumer-contract";
import {
  composeWorkStatusEvent,
  composeWorkStatusSnapshot,
  type WorkStatusConsumerCapabilities,
} from "./snapshot-composer";

export type WorkStatusSnapshotDeliveryReason = "resync" | "requested";

export interface WorkStatusConsumerAdapter {
  readonly capabilities: WorkStatusConsumerCapabilities;
  deliverSnapshot(
    snapshot: WorkStatusSnapshotV1,
    reason: WorkStatusSnapshotDeliveryReason,
  ): void | Promise<void>;
  deliverEvent(event: WorkStatusEventV1): void | Promise<void>;
}

/**
 * Tracks an individual consumer cursor. Gaps and epoch changes always recover from a snapshot;
 * events are intentionally not replayed or persisted.
 */
export class WorkStatusConsumerConnection implements Disposable {
  private subscription: Disposable | null = null;
  private epoch: string | null = null;
  private seq = -1;

  constructor(
    private readonly source: WorkStatusContractSource,
    private readonly adapter: WorkStatusConsumerAdapter,
  ) {}

  prepareInitialSnapshot(): WorkStatusSnapshotV1 {
    const snapshot = composeWorkStatusSnapshot(
      this.source.getSnapshot(),
      this.adapter.capabilities,
    );
    this.acceptCursor(snapshot);
    return snapshot;
  }

  /** Attach after the transport accepted the prepared initial snapshot. */
  connect(): void {
    this.subscription?.dispose();
    if (this.adapter.capabilities.eventPush) {
      this.subscription = this.source.subscribeEvents((event) => this.receive(event));
    }
    const current = this.source.getSnapshot();
    if (this.epoch !== current.epoch || this.seq !== current.seq) this.resync("resync");
  }

  requestSnapshot(): void {
    this.resync("requested");
  }

  getCurrentSnapshot(): WorkStatusSnapshotV1 {
    return composeWorkStatusSnapshot(this.source.getSnapshot(), this.adapter.capabilities);
  }

  dispose(): void {
    this.subscription?.dispose();
    this.subscription = null;
  }

  private receive(event: WorkStatusEventV1): void {
    if (event.epoch !== this.epoch || event.seq !== this.seq + 1) {
      this.resync("resync");
      return;
    }
    const composed = composeWorkStatusEvent(event, this.adapter.capabilities);
    this.epoch = event.epoch;
    this.seq = event.seq;
    if (composed) void this.adapter.deliverEvent(composed);
  }

  private resync(reason: WorkStatusSnapshotDeliveryReason): void {
    const snapshot = this.getCurrentSnapshot();
    this.acceptCursor(snapshot);
    void this.adapter.deliverSnapshot(snapshot, reason);
  }

  private acceptCursor(snapshot: WorkStatusSnapshotV1): void {
    this.epoch = snapshot.epoch;
    this.seq = snapshot.seq;
  }
}
