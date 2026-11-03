export interface ContinuityContext {
  readonly personaId: string;
  readonly personaName: string;
  readonly personaPrompt: string;
  readonly language: "ja" | "en";
  readonly cwd: string | null;
  /** Exact current Main Agent session; absent for text-only companions. */
  readonly executionSessionId?: string | null;
}
export interface ContinuityMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly createdAt: number;
  readonly source: "conversation" | "external" | "voice" | "legacy";
}
export interface UnderstandingRevision {
  readonly value: string;
  readonly reason: string;
  readonly sourceIds: readonly string[];
  readonly createdAt: number;
}
export interface ContinuityUnderstanding {
  readonly id: string;
  readonly title: string;
  readonly value: string;
  readonly certainty: "confirmed" | "inferred" | "unverified";
  readonly sourceIds: readonly string[];
  readonly updatedAt: number;
  readonly revisions: readonly UnderstandingRevision[];
}
export interface ContinuityReflection {
  readonly id: string;
  readonly content: string;
  readonly sourceIds: readonly string[];
  readonly understandingIds: readonly string[];
  readonly createdAt: number;
}
export interface ContinuityDraft {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly reason: string;
  readonly status: "ready" | "dismissed";
  readonly sourceIds: readonly string[];
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface ContinuitySnapshot {
  readonly personaId: string;
  readonly revision: number;
  readonly phase: "idle" | "thinking" | "drafting" | "working" | "error";
  readonly messages: readonly ContinuityMessage[];
  readonly understandings: readonly ContinuityUnderstanding[];
  readonly drafts: readonly ContinuityDraft[];
  readonly reflections: readonly ContinuityReflection[];
  readonly error: string | null;
  readonly lastObservedAt: number | null;
  /** Absent in older saved snapshots; null means quietly wait. */
  readonly nextStep?: string | null;
}
