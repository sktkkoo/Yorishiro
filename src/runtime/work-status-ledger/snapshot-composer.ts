import type {
  WorkStatusContractWorkV1,
  WorkStatusEventV1,
  WorkStatusSnapshotV1,
} from "./consumer-contract";

export interface WorkStatusConsumerCapabilities {
  readonly maxSnapshotBytes: number;
  readonly maxWorks: number;
  readonly eventPush: boolean;
  readonly delegation: boolean;
  readonly plainTextOnly: boolean;
}

/**
 * Applies consumer limits without knowing which voice or UI provider will receive the data.
 * Approval/blocked and other active work win over terminal history; ties prefer newer work.
 */
export function composeWorkStatusSnapshot(
  snapshot: WorkStatusSnapshotV1,
  capabilities: WorkStatusConsumerCapabilities,
): WorkStatusSnapshotV1 {
  validateCapabilities(capabilities);
  const unabridged = withWorks(snapshot, snapshot.works);
  if (
    snapshot.works.length <= capabilities.maxWorks &&
    utf8Size(unabridged) <= capabilities.maxSnapshotBytes
  ) {
    return unabridged;
  }
  const ranked = [...snapshot.works].sort(comparePriority).slice(0, capabilities.maxWorks);
  let selected = ranked;
  let composed = withWorks(snapshot, selected);
  while (selected.length > 0 && utf8Size(composed) > capabilities.maxSnapshotBytes) {
    selected = selected.slice(0, -1);
    composed = withWorks(snapshot, selected);
  }
  return composed;
}

export function composeWorkStatusEvent(
  event: WorkStatusEventV1,
  capabilities: WorkStatusConsumerCapabilities,
): WorkStatusEventV1 | null {
  validateCapabilities(capabilities);
  return capabilities.eventPush ? event : null;
}

function withWorks(
  snapshot: WorkStatusSnapshotV1,
  works: ReadonlyArray<WorkStatusContractWorkV1>,
): WorkStatusSnapshotV1 {
  const omittedWorkCount = snapshot.works.length - works.length;
  return Object.freeze({
    schemaVersion: snapshot.schemaVersion,
    epoch: snapshot.epoch,
    seq: snapshot.seq,
    observedAt: snapshot.observedAt,
    works: Object.freeze([...works]),
    activeCount: snapshot.activeCount,
    ...(omittedWorkCount > 0 ? { omittedWorkCount } : {}),
  });
}

function comparePriority(a: WorkStatusContractWorkV1, b: WorkStatusContractWorkV1): number {
  const priority = statusPriority(b.status) - statusPriority(a.status);
  return priority !== 0 ? priority : b.updatedAt - a.updatedAt;
}

function statusPriority(status: WorkStatusContractWorkV1["status"]): number {
  if (status === "approval-required") return 3;
  if (status === "created" || status === "running") return 2;
  return 1;
}

function validateCapabilities(capabilities: WorkStatusConsumerCapabilities): void {
  if (!Number.isInteger(capabilities.maxWorks) || capabilities.maxWorks < 0) {
    throw new Error("Consumer maxWorks must be a non-negative integer");
  }
  if (!Number.isInteger(capabilities.maxSnapshotBytes) || capabilities.maxSnapshotBytes <= 0) {
    throw new Error("Consumer maxSnapshotBytes must be a positive integer");
  }
}

function utf8Size(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
