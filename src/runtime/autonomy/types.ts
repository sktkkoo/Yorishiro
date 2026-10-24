export type AutonomyOperation = "write" | "move" | "trash";
export type AutonomyReviewMode = "automatic" | "daily";

export interface AutonomyContract {
  readonly goal: string;
  readonly root: string;
  readonly allowedOperations: readonly AutonomyOperation[];
  readonly intervalMinutes: number;
  readonly maxRunsPerDay: number;
  readonly enabled: boolean;
  readonly reviewMode?: AutonomyReviewMode;
}

export interface AutonomyDraft {
  readonly id: string;
  readonly goal: string;
  readonly root: string;
  readonly allowedOperations: readonly AutonomyOperation[];
  readonly intervalMinutes: number;
  readonly maxRunsPerDay: number;
  readonly reviewMode: AutonomyReviewMode;
  readonly explanation: string;
}

export type AutonomyDraftPatch = Partial<
  Pick<
    AutonomyDraft,
    "goal" | "root" | "allowedOperations" | "intervalMinutes" | "maxRunsPerDay" | "reviewMode"
  >
>;

export interface AutonomyDraftSnapshot {
  readonly revision: number;
  readonly draft: AutonomyDraft | null;
}

export interface DraftEditResult {
  readonly snapshot: AutonomyDraftSnapshot;
  readonly conflict: boolean;
}

export interface PendingWork {
  readonly id: string;
  readonly goal: string;
  readonly reason: string;
  readonly summary: string;
  readonly changedPaths: readonly string[];
}

export interface AutonomyRun {
  readonly id: string;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  readonly status: "running" | "completed" | "failed" | "cancelled" | "undone" | "proposed";
  readonly summary: string;
  readonly reason: string;
  readonly changedPaths: readonly string[];
  readonly canUndo: boolean;
}

export interface AutonomyStatus {
  readonly contract: AutonomyContract | null;
  readonly phase:
    | "idle"
    | "thinking"
    | "applying"
    | "paused"
    | "failed"
    | "completed"
    | "blocked"
    | "awaitingReview";
  readonly nextRunAt: number | null;
  readonly runs: readonly AutonomyRun[];
  readonly error: string | null;
  readonly pendingWork?: PendingWork | null;
}

export interface SetupMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
}

export interface SetupReply {
  readonly draftSnapshot?: AutonomyDraftSnapshot;
  readonly draftConflict?: boolean;
  readonly reply: string;
  readonly suggestedGoal: string;
  readonly suggestedOperations: readonly AutonomyOperation[];
  readonly suggestedRoot?: string;
  readonly suggestedIntervalMinutes?: number;
  readonly suggestedMaxRunsPerDay?: number;
  readonly suggestedReviewMode?: AutonomyReviewMode;
}
