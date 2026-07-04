import type { AttentionRect } from "@charminal/sdk";

export type WorkspaceAttentionItemType =
  | "run-failed"
  | "run-running-long"
  | "run-slow-completed"
  | "awaiting-approval";
export type WorkspaceAttentionSeverity = "low" | "medium" | "high";
export type WorkspaceAttentionItemState = "active" | "ack" | "snoozed" | "resolved";
export type WorkspaceAttentionMood = "calm" | "working" | "waiting" | "failed";

export interface WorkspaceAttentionProducer {
  readonly kind: "host";
  readonly id: string;
}

export interface WorkspaceAttentionLocusTerminalRegion {
  readonly kind: "terminal-region";
  readonly sessionId: string;
  readonly commandRunId?: number;
  readonly rect: AttentionRect;
  readonly range: {
    readonly startRow: number;
    readonly endRow: number;
    readonly startCol: number;
    readonly endCol: number;
  };
}

export interface WorkspaceAttentionLocusSession {
  readonly kind: "session";
  readonly sessionId: string;
}

export type WorkspaceAttentionLocus =
  | WorkspaceAttentionLocusTerminalRegion
  | WorkspaceAttentionLocusSession;

export interface WorkspaceAttentionItem {
  readonly id: string;
  readonly sessionId: string;
  readonly locus: WorkspaceAttentionLocus;
  readonly type: WorkspaceAttentionItemType;
  readonly severity: WorkspaceAttentionSeverity;
  readonly state: WorkspaceAttentionItemState;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly producer: WorkspaceAttentionProducer;
  readonly producerKey: string;
  readonly detail?: unknown;
}

export interface WorkspaceAttentionAggregate {
  readonly kind: "workspace-attention-aggregate";
  readonly mood: WorkspaceAttentionMood;
  readonly severity: WorkspaceAttentionSeverity | "none";
  readonly activeCount: number;
  readonly updatedAt: number;
  readonly producer: WorkspaceAttentionProducer;
}

export interface WorkspaceAttentionSnapshot {
  readonly activeItems: ReadonlyArray<WorkspaceAttentionItem>;
  readonly primaryItem: WorkspaceAttentionItem | null;
  readonly aggregate: WorkspaceAttentionAggregate;
}

export interface WorkspaceAttentionCreateInput {
  readonly sessionId: string;
  readonly locus: WorkspaceAttentionLocus;
  readonly type: WorkspaceAttentionItemType;
  readonly severity: WorkspaceAttentionSeverity;
  readonly producer: WorkspaceAttentionProducer;
  readonly producerKey: string;
  readonly detail?: unknown;
}
