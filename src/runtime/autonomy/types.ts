export type AutonomyOperation = "write" | "move" | "trash";
export type AutonomyWorkMode = "auto" | "documents" | "development";
export type AutonomyReviewMode = "automatic" | "daily";

export interface AutonomyContract {
  readonly workMode?: AutonomyWorkMode;
  readonly publishPullRequest?: boolean;
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
  readonly workMode?: AutonomyWorkMode;
  readonly publishPullRequest?: boolean;
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
    | "goal"
    | "root"
    | "allowedOperations"
    | "intervalMinutes"
    | "maxRunsPerDay"
    | "reviewMode"
    | "workMode"
    | "publishPullRequest"
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

export interface AutonomyAction {
  readonly acknowledged?: boolean;
  readonly id: string;
  readonly runId: string;
  readonly kind: "publishPullRequest";
  readonly payloadDigest: string;
  readonly createdAt: number;
  readonly status: "pending" | "submitting" | "published" | "declined" | "failed" | "unknown";
  readonly summary: string;
  readonly artifactPath: string;
  readonly repository: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly title: string;
  readonly body: string;
  readonly diff: string;
  readonly changedPaths: readonly string[];
  readonly checks: readonly { readonly command: string; readonly exitCode: number }[];
  readonly error?: string | null;
  readonly pullRequestUrl?: string | null;
}

export type AutonomyConfirmationNotice = Pick<
  AutonomyAction,
  "id" | "runId" | "kind" | "summary" | "status"
>;

export interface AutonomyRun {
  readonly developmentPath?: string;
  readonly pullRequestUrl?: string;
  readonly branch?: string;
  readonly validationSummary?: string;
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
    | "stopping"
    | "paused"
    | "failed"
    | "completed"
    | "blocked"
    | "awaitingReview"
    | "awaitingAction"
    | "publishing";

  readonly nextRunAt: number | null;
  readonly runs: readonly AutonomyRun[];
  readonly error: string | null;
  readonly pendingWork?: PendingWork | null;
  readonly pendingActions?: readonly AutonomyAction[];
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
  readonly suggestedWorkMode?: AutonomyWorkMode;
  readonly suggestedPublishPullRequest?: boolean;
}
