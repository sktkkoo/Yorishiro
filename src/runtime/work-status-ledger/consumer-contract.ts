import type { Disposable } from "@yorishiro/sdk";
import type {
  DelegatedWork,
  WorkStatus,
  WorkStatusLedgerEvent,
  WorkStatusLedgerSnapshot,
} from "./types";

export const WORK_STATUS_CONTRACT_SCHEMA_VERSION = 1 as const;

/**
 * Provider/voice-neutral work projection exposed to consumers.
 *
 * Provider-native/session identifiers and approval keys deliberately do not cross this
 * boundary. Consumers only receive sanitized human text and aggregate approval state.
 */
export interface WorkStatusContractWorkV1 {
  readonly id: string;
  readonly summary: string;
  readonly status: WorkStatus;
  readonly note: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly approvalCount: number;
}

export interface WorkStatusSnapshotV1 {
  readonly schemaVersion: 1;
  readonly epoch: string;
  readonly seq: number;
  readonly observedAt: number;
  readonly works: ReadonlyArray<WorkStatusContractWorkV1>;
  readonly activeCount: number;
  /** Number removed by capability negotiation. Absent on an unabridged snapshot. */
  readonly omittedWorkCount?: number;
}

export type WorkStatusEventV1 =
  | {
      readonly schemaVersion: 1;
      readonly epoch: string;
      readonly seq: number;
      readonly observedAt: number;
      readonly kind: "work-created";
      readonly work: WorkStatusContractWorkV1;
    }
  | {
      readonly schemaVersion: 1;
      readonly epoch: string;
      readonly seq: number;
      readonly observedAt: number;
      readonly kind: "work-updated";
      readonly work: WorkStatusContractWorkV1;
      readonly previousStatus: WorkStatus;
    };

export interface WorkStatusContractSource {
  getSnapshot(): WorkStatusSnapshotV1;
  subscribeEvents(listener: (event: WorkStatusEventV1) => void): Disposable;
}

export interface WorkStatusLedgerSource {
  getSnapshot(): WorkStatusLedgerSnapshot;
  subscribeEvents(listener: (event: WorkStatusLedgerEvent) => void): Disposable;
}

export interface WorkStatusContractPublisherOptions {
  readonly epoch?: string;
  readonly now?: () => number;
}

/** Adds the versioned epoch/sequence envelope to the existing in-memory ledger. */
export class WorkStatusContractPublisher implements WorkStatusContractSource, Disposable {
  private readonly epoch: string;
  private readonly now: () => number;
  private readonly listeners = new Set<(event: WorkStatusEventV1) => void>();
  private readonly sourceSubscription: Disposable;
  private seq = 0;

  constructor(
    private readonly source: WorkStatusLedgerSource,
    options: WorkStatusContractPublisherOptions = {},
  ) {
    this.epoch = options.epoch ?? createEpoch();
    this.now = options.now ?? Date.now;
    this.sourceSubscription = source.subscribeEvents((event) => this.publish(event));
  }

  getSnapshot(): WorkStatusSnapshotV1 {
    const snapshot = this.source.getSnapshot();
    return immutableSnapshot({
      schemaVersion: WORK_STATUS_CONTRACT_SCHEMA_VERSION,
      epoch: this.epoch,
      seq: this.seq,
      observedAt: this.now(),
      works: snapshot.work.map(toContractWork),
      activeCount: snapshot.activeCount,
    });
  }

  subscribeEvents(listener: (event: WorkStatusEventV1) => void): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.sourceSubscription.dispose();
    this.listeners.clear();
  }

  private publish(event: WorkStatusLedgerEvent): void {
    const envelope = {
      schemaVersion: WORK_STATUS_CONTRACT_SCHEMA_VERSION,
      epoch: this.epoch,
      seq: ++this.seq,
      observedAt: this.now(),
      work: toContractWork(event.work),
    } as const;
    const contractEvent: WorkStatusEventV1 =
      event.kind === "work-updated"
        ? Object.freeze({
            ...envelope,
            kind: "work-updated" as const,
            previousStatus: event.previousStatus,
          })
        : Object.freeze({ ...envelope, kind: "work-created" as const });
    for (const listener of this.listeners) listener(contractEvent);
  }
}

function toContractWork(work: DelegatedWork): WorkStatusContractWorkV1 {
  return Object.freeze({
    id: work.id,
    summary: work.summary,
    status: work.status,
    note: work.note,
    createdAt: work.createdAt,
    updatedAt: work.updatedAt,
    approvalCount: work.pendingApprovals.length,
  });
}

function immutableSnapshot(snapshot: WorkStatusSnapshotV1): WorkStatusSnapshotV1 {
  return Object.freeze({ ...snapshot, works: Object.freeze([...snapshot.works]) });
}

function createEpoch(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `epoch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
