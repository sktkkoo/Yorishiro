import type { Disposable } from "@charminal/sdk";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type {
  WorkspaceAttentionAggregate,
  WorkspaceAttentionCreateInput,
  WorkspaceAttentionItem,
  WorkspaceAttentionItemState,
  WorkspaceAttentionSeverity,
  WorkspaceAttentionSnapshot,
} from "./types";

const STORE_PRODUCER = { kind: "host" as const, id: "workspace-attention-store" };

const EMPTY_AGGREGATE: WorkspaceAttentionAggregate = {
  kind: "workspace-attention-aggregate",
  mood: "calm",
  severity: "none",
  activeCount: 0,
  updatedAt: 0,
  producer: STORE_PRODUCER,
};

const SEVERITY_RANK: Record<WorkspaceAttentionSeverity, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

export interface WorkspaceAttentionStoreOptions {
  readonly now?: () => number;
}

/**
 * Workspace 全体の host-owned attention item store。
 *
 * queue ではなく item lifecycle を保持する。pack / persona には write API を渡さず、
 * producer は host 内部 wiring からだけ upsert する。
 *
 * TODO: Terminal Director の SessionAttentionStore が main に入ったら、
 * permission-prompt / task-result / tool-failure / exit producer とここを統合する。
 */
export class WorkspaceAttentionStore {
  private readonly now: () => number;
  private readonly listeners = new Set<(snapshot: WorkspaceAttentionSnapshot) => void>();
  private readonly items = new Map<string, WorkspaceAttentionItem>();
  private readonly keyToId = new Map<string, string>();
  private nextId = 1;
  private snapshot: WorkspaceAttentionSnapshot = {
    activeItems: [],
    primaryItem: null,
    aggregate: EMPTY_AGGREGATE,
  };

  constructor(options: WorkspaceAttentionStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  upsert(input: WorkspaceAttentionCreateInput): WorkspaceAttentionItem {
    const now = this.now();
    const existingId = this.keyToId.get(input.producerKey);
    if (existingId) {
      const existing = this.items.get(existingId);
      if (existing) {
        const updated = {
          ...existing,
          locus: input.locus,
          type: input.type,
          severity: input.severity,
          state: "active" as const,
          updatedAt: now,
          detail: input.detail,
        };
        this.items.set(existing.id, updated);
        this.publish();
        return updated;
      }
    }

    const item: WorkspaceAttentionItem = {
      id: `attn-${this.nextId++}`,
      sessionId: input.sessionId,
      locus: input.locus,
      type: input.type,
      severity: input.severity,
      state: "active",
      createdAt: now,
      updatedAt: now,
      producer: input.producer,
      producerKey: input.producerKey,
      detail: input.detail,
    };
    this.items.set(item.id, item);
    this.keyToId.set(item.producerKey, item.id);
    this.publish();
    return item;
  }

  ack(id: string): boolean {
    return this.transition(id, "ack");
  }

  snooze(id: string): boolean {
    return this.transition(id, "snoozed");
  }

  resolve(id: string): boolean {
    return this.transition(id, "resolved");
  }

  getActiveItems(): ReadonlyArray<WorkspaceAttentionItem> {
    return this.snapshot.activeItems;
  }

  getPrimaryItem(): WorkspaceAttentionItem | null {
    return this.snapshot.primaryItem;
  }

  getAggregate(): WorkspaceAttentionAggregate {
    return this.snapshot.aggregate;
  }

  getSnapshot(): WorkspaceAttentionSnapshot {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: WorkspaceAttentionSnapshot) => void): Disposable {
    this.listeners.add(listener);
    listener(this.snapshot);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  clear(): void {
    if (this.items.size === 0) return;
    this.items.clear();
    this.keyToId.clear();
    this.publish();
  }

  private transition(id: string, state: WorkspaceAttentionItemState): boolean {
    const item = this.items.get(id);
    if (!item) return false;
    if (item.state === state) return true;
    this.items.set(id, { ...item, state, updatedAt: this.now() });
    this.publish();
    return true;
  }

  private publish(): void {
    const activeItems = Array.from(this.items.values()).filter((item) => item.state === "active");
    const primaryItem = selectPrimaryItem(activeItems, this.now());
    this.snapshot = {
      activeItems,
      primaryItem,
      aggregate: aggregateFromActiveItems(activeItems, this.now()),
    };
    for (const listener of Array.from(this.listeners)) {
      listener(this.snapshot);
    }
  }
}

export function selectPrimaryItem(
  items: ReadonlyArray<WorkspaceAttentionItem>,
  now: number,
): WorkspaceAttentionItem | null {
  let best: WorkspaceAttentionItem | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const item of items) {
    const ageMs = Math.max(0, now - item.createdAt);
    const ageScore = Math.min(ageMs, 60_000) / 1000;
    const score = SEVERITY_RANK[item.severity] * 1000 + ageScore;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

export function createWorkspaceAttentionStore(
  options: WorkspaceAttentionStoreOptions = {},
): WorkspaceAttentionStore {
  return new WorkspaceAttentionStore(options);
}

export function getWorkspaceAttentionStore(): WorkspaceAttentionStore {
  return getOrInit(KEYS.WORKSPACE_ATTENTION_STORE, () => createWorkspaceAttentionStore());
}

function aggregateFromActiveItems(
  items: ReadonlyArray<WorkspaceAttentionItem>,
  now: number,
): WorkspaceAttentionAggregate {
  if (items.length === 0) {
    return { ...EMPTY_AGGREGATE, updatedAt: now };
  }

  const severity = maxSeverity(items);
  const hasFailure = items.some((item) => item.type === "run-failed" || item.severity === "high");
  const hasWaiting = items.some(
    (item) => item.type === "run-slow-completed" || item.type === "awaiting-approval",
  );
  return {
    kind: "workspace-attention-aggregate",
    mood: hasFailure ? "failed" : hasWaiting ? "waiting" : "working",
    severity,
    activeCount: items.length,
    updatedAt: now,
    producer: STORE_PRODUCER,
  };
}

function maxSeverity(items: ReadonlyArray<WorkspaceAttentionItem>): WorkspaceAttentionSeverity {
  let best: WorkspaceAttentionSeverity = "low";
  for (const item of items) {
    if (SEVERITY_RANK[item.severity] > SEVERITY_RANK[best]) {
      best = item.severity;
    }
  }
  return best;
}
