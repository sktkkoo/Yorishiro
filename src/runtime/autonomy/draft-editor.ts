import { useEffect, useState, useSyncExternalStore } from "react";
import { editAutonomyDraft } from "./client";
import type {
  AutonomyContract,
  AutonomyDraft,
  AutonomyDraftPatch,
  AutonomyDraftSnapshot,
  DraftEditResult,
} from "./types";

export type DraftValues = Pick<
  AutonomyDraft,
  "goal" | "root" | "allowedOperations" | "intervalMinutes" | "maxRunsPerDay" | "reviewMode"
>;
export type DraftField = keyof DraftValues;
type FieldValue = DraftValues[DraftField];
const FIELDS: readonly DraftField[] = [
  "goal",
  "root",
  "allowedOperations",
  "intervalMinutes",
  "maxRunsPerDay",
  "reviewMode",
];
const EMPTY: DraftValues = {
  goal: "",
  root: "",
  allowedOperations: [],
  intervalMinutes: 30,
  maxRunsPerDay: 4,
  reviewMode: "daily",
};
const same = (a: FieldValue, b: FieldValue) => JSON.stringify(a) === JSON.stringify(b);
const valuesOf = (draft: AutonomyDraft): DraftValues => ({
  goal: draft.goal,
  root: draft.root,
  allowedOperations: draft.allowedOperations,
  intervalMinutes: draft.intervalMinutes,
  maxRunsPerDay: draft.maxRunsPerDay,
  reviewMode: draft.reviewMode,
});

interface Edit {
  base: FieldValue;
  value: FieldValue;
  generation: number;
}
interface Submission {
  patch: AutonomyDraftPatch;
  generations: Partial<Record<DraftField, number>>;
}
export interface DraftEditorState {
  readonly draftId: string | null;
  readonly values: DraftValues;
  readonly explanation: string;
  readonly conflicts: readonly DraftField[];
  readonly remoteValues: DraftValues;
  readonly syncing: boolean;
  readonly synced: boolean;
  readonly canSubmit: boolean;
  readonly error: string | null;
  readonly version: number;
  readonly editVersion: number;
}

/** Per-field optimistic draft editing. A draft is never an active work contract. */
export class AutonomyDraftEditor {
  private values: DraftValues = { ...EMPTY };
  private remote: DraftValues = { ...EMPTY };
  private baseId: string | null = null;
  private revision = -1;
  private explanation = "";
  private edits = new Map<DraftField, Edit>();
  private conflicts = new Set<DraftField>();
  private inFlight: Submission | null = null;
  private error: string | null = null;
  private generation = 0;
  private version = 0;
  private editVersion = 0;
  private hydrated = false;
  private listeners = new Set<() => void>();
  private state: DraftEditorState = this.project();

  constructor(
    private readonly submitPatch: (
      baseId: string | null,
      patch: AutonomyDraftPatch,
    ) => Promise<DraftEditResult>,
  ) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.state;

  private project(): DraftEditorState {
    const valid =
      Number.isInteger(this.values.intervalMinutes) &&
      this.values.intervalMinutes >= 5 &&
      this.values.intervalMinutes <= 1440 &&
      Number.isInteger(this.values.maxRunsPerDay) &&
      this.values.maxRunsPerDay >= 1 &&
      this.values.maxRunsPerDay <= 48;
    return {
      draftId: this.baseId,
      values: this.values,
      remoteValues: this.remote,
      explanation: this.explanation,
      conflicts: [...this.conflicts],
      syncing: this.inFlight !== null,
      synced: this.edits.size === 0 && this.inFlight === null && this.error === null,
      canSubmit:
        valid &&
        (this.baseId !== null || this.conflicts.size === 0) &&
        this.inFlight === null &&
        this.error === null &&
        [...this.edits.keys()].some((key) => !this.conflicts.has(key)),
      error: this.error,
      version: this.version,
      editVersion: this.editVersion,
    };
  }

  private publish() {
    this.version += 1;
    this.state = this.project();
    for (const listener of this.listeners) listener();
  }

  hydrate(contract: AutonomyContract | null | undefined) {
    if (!contract || this.hydrated || this.baseId !== null || this.edits.size || this.inFlight)
      return;
    this.hydrated = true;
    this.values = {
      goal: contract.goal,
      root: contract.root,
      allowedOperations: contract.allowedOperations,
      intervalMinutes: contract.intervalMinutes,
      maxRunsPerDay: contract.maxRunsPerDay,
      reviewMode: contract.reviewMode ?? "automatic",
    };
    this.remote = { ...this.values };
    this.publish();
  }

  edit<K extends DraftField>(key: K, value: DraftValues[K]) {
    this.editVersion += 1;
    const previous = this.edits.get(key);
    this.values = { ...this.values, [key]: value };
    this.error = null;
    if (same(value, this.remote[key]) && this.inFlight?.patch[key] === undefined) {
      this.edits.delete(key);
      this.conflicts.delete(key);
    } else {
      this.edits.set(key, {
        base: previous?.base ?? this.remote[key],
        value,
        generation: ++this.generation,
      });
    }
    this.publish();
  }

  receive(snapshot: AutonomyDraftSnapshot) {
    if (snapshot.revision <= this.revision) return;
    this.revision = snapshot.revision;
    this.baseId = snapshot.draft?.id ?? null;
    if (!snapshot.draft) {
      this.publish();
      return;
    }
    this.hydrated = true;
    const next = valuesOf(snapshot.draft);
    this.explanation = snapshot.draft.explanation;
    for (const key of FIELDS) {
      const edit = this.edits.get(key);
      if (!edit) {
        this.values = { ...this.values, [key]: next[key] };
        continue;
      }
      if (same(edit.value, next[key])) {
        this.edits.delete(key);
        this.conflicts.delete(key);
      } else if (
        this.inFlight?.patch[key] !== undefined &&
        same(this.inFlight.patch[key] as FieldValue, next[key])
      ) {
        // Our older submission was accepted while the user kept typing. Rebase
        // the newer edit, but never replace it with the submitted old value.
        edit.base = next[key];
        this.conflicts.delete(key);
      } else if (!same(edit.base, next[key])) {
        this.conflicts.add(key);
      } else {
        this.conflicts.delete(key);
      }
    }
    this.remote = next;
    this.publish();
  }

  resolve(key: DraftField, choice: "remote" | "local") {
    this.editVersion += 1;
    if (choice === "remote") {
      this.values = { ...this.values, [key]: this.remote[key] };
      this.edits.delete(key);
    } else {
      const edit = this.edits.get(key);
      if (edit) edit.base = this.remote[key];
    }
    this.conflicts.delete(key);
    this.error = null;
    this.publish();
  }

  retry() {
    this.editVersion += 1;
    this.error = null;
    this.publish();
  }

  /** Make the latest typed fields visible to the next AI turn before it starts. */
  async flush() {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (this.state.syncing) {
        await new Promise<void>((resolve) => {
          const unsubscribe = this.subscribe(() => {
            if (!this.state.syncing) {
              unsubscribe();
              resolve();
            }
          });
        });
      }
      if (this.state.synced) return;
      if (!this.state.canSubmit) break;
      await this.submit();
    }
    if (!this.state.synced)
      throw new Error(this.state.error ?? "設定案の更新を確認してから相談を続けてください。");
  }

  async submit() {
    if (!this.state.canSubmit) return;
    let patch: AutonomyDraftPatch = {};
    const generations: Partial<Record<DraftField, number>> = {};
    // A first draft must contain all displayed fields, including fields loaded
    // from an existing contract; backend defaults must not silently replace them.
    if (this.baseId === null) patch = { ...this.values };
    else
      for (const [key, edit] of this.edits)
        if (!this.conflicts.has(key)) patch = { ...patch, [key]: edit.value };
    for (const [key, edit] of this.edits)
      if (patch[key] !== undefined) generations[key] = edit.generation;
    this.inFlight = { patch, generations };
    this.publish();
    try {
      const result = await this.submitPatch(this.baseId, patch);
      this.receive(result.snapshot);
      if (!result.conflict) {
        // The accepted snapshot may already have arrived through the native
        // stream. Only acknowledge unchanged edits whose server value agrees.
        for (const [key, edit] of this.edits)
          if (generations[key] === edit.generation && same(edit.value, this.remote[key])) {
            this.edits.delete(key);
            this.conflicts.delete(key);
          }
      }
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    } finally {
      this.inFlight = null;
      this.publish();
    }
  }
}

export function useAutonomyDraftEditor(
  snapshot: AutonomyDraftSnapshot,
  contract: AutonomyContract | null | undefined,
) {
  const [editor] = useState(() => new AutonomyDraftEditor(editAutonomyDraft));
  const state = useSyncExternalStore(editor.subscribe, editor.getSnapshot);
  useEffect(() => editor.receive(snapshot), [editor, snapshot]);
  useEffect(() => editor.hydrate(contract), [editor, contract]);
  useEffect(() => {
    if (!state.canSubmit) return;
    const editVersion = state.editVersion;
    const timeout = setTimeout(() => {
      if (editor.getSnapshot().editVersion === editVersion) void editor.submit();
    }, 500);
    return () => clearTimeout(timeout);
  }, [editor, state.canSubmit, state.editVersion]);
  return { editor, state };
}
