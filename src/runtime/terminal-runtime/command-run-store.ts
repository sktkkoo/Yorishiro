import type { Disposable } from "@charminal/sdk";
import type { IMarker } from "@xterm/xterm";

export type TerminalCommandRunStatus = "running" | "succeeded" | "failed" | "unknown";
export type TerminalCommandRunCompletedBy = "osc133" | "pty-exit" | "session-dispose";

export interface TerminalCommandRun {
  readonly id: number;
  readonly sessionId: string;
  readonly command: string | null;
  readonly cwd: string | null;
  readonly status: TerminalCommandRunStatus;
  readonly completedBy: TerminalCommandRunCompletedBy | null;
  readonly exitCode: number | null;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly startMarker: IMarker | null;
  readonly endMarker: IMarker | null;
}

export interface StartCommandRunInput {
  readonly startMarker: IMarker | null;
  readonly startedAt: number | null;
}

export interface FinalizeCommandRunInput {
  readonly completedBy: TerminalCommandRunCompletedBy;
  readonly exitCode: number | null;
  readonly endMarker: IMarker | null;
  readonly endedAt: number | null;
}

const DEFAULT_MAX_RUNS = 200;

/**
 * TerminalCommandRun の per-session store。xterm marker を行範囲の正本にし、
 * output text は保持しない。
 */
export class TerminalCommandRunStore {
  private readonly sessionId: string;
  private readonly maxRuns: number;
  private readonly listeners = new Set<() => void>();
  private runs: TerminalCommandRun[] = [];
  private nextId = 1;
  private activeRunId: number | null = null;
  private pendingCommand: string | null = null;
  private currentCwd: string | null = null;

  constructor(sessionId: string, opts: { readonly maxRuns?: number } = {}) {
    this.sessionId = sessionId;
    this.maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
  }

  setPendingCommand(command: string | null): void {
    this.pendingCommand = command;
  }

  setCurrentCwd(cwd: string | null): void {
    this.currentCwd = cwd;
  }

  start(input: StartCommandRunInput): TerminalCommandRun {
    const active = this.getActiveRun();
    if (active) {
      input.startMarker?.dispose();
      this.pendingCommand = null;
      return active;
    }

    const run: TerminalCommandRun = {
      id: this.nextId++,
      sessionId: this.sessionId,
      command: this.pendingCommand,
      cwd: this.currentCwd,
      status: "running",
      completedBy: null,
      exitCode: null,
      startedAt: input.startedAt,
      endedAt: null,
      durationMs: null,
      startMarker: input.startMarker,
      endMarker: null,
    };
    this.pendingCommand = null;
    this.runs = [...this.runs, run];
    this.activeRunId = run.id;
    this.trimOldRuns();
    this.notify();
    return run;
  }

  finalizeActive(input: FinalizeCommandRunInput): TerminalCommandRun | null {
    if (this.activeRunId === null) {
      input.endMarker?.dispose();
      return null;
    }
    const index = this.runs.findIndex((run) => run.id === this.activeRunId);
    if (index === -1) {
      this.activeRunId = null;
      input.endMarker?.dispose();
      return null;
    }

    const current = this.runs[index];
    const status = statusFromCompletion(input.completedBy, input.exitCode);
    const durationMs =
      current.startedAt === null || input.endedAt === null
        ? null
        : Math.max(0, input.endedAt - current.startedAt);
    const finalized: TerminalCommandRun = {
      ...current,
      status,
      completedBy: input.completedBy,
      exitCode: input.exitCode,
      endedAt: input.endedAt,
      durationMs,
      endMarker: input.endMarker,
    };
    this.runs = replaceAt(this.runs, index, finalized);
    this.activeRunId = null;
    this.notify();
    return finalized;
  }

  finalizeForSessionDispose(endedAt: number, endMarker: IMarker | null): TerminalCommandRun | null {
    return this.finalizeActive({
      completedBy: "session-dispose",
      exitCode: null,
      endedAt,
      endMarker,
    });
  }

  getActiveRun(): TerminalCommandRun | null {
    if (this.activeRunId === null) return null;
    return this.runs.find((run) => run.id === this.activeRunId) ?? null;
  }

  getRecent(limit = DEFAULT_MAX_RUNS): ReadonlyArray<TerminalCommandRun> {
    return this.runs.slice(Math.max(0, this.runs.length - limit)).reverse();
  }

  /** 直近で finalize された `failed` run を返す（無ければ null）。Attach last failed run 用。 */
  getLastFailedRun(): TerminalCommandRun | null {
    for (const run of this.getRecent()) {
      if (run.status === "failed") return run;
    }
    return null;
  }

  subscribe(listener: () => void): Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  clear(): void {
    for (const run of this.runs) {
      disposeRunMarkers(run);
    }
    this.runs = [];
    this.activeRunId = null;
    this.pendingCommand = null;
    this.currentCwd = null;
    this.notify();
  }

  private trimOldRuns(): void {
    if (this.runs.length <= this.maxRuns) return;
    const dropCount = this.runs.length - this.maxRuns;
    for (const run of this.runs.slice(0, dropCount)) {
      disposeRunMarkers(run);
    }
    this.runs = this.runs.slice(dropCount);
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function statusFromCompletion(
  completedBy: TerminalCommandRunCompletedBy,
  exitCode: number | null,
): TerminalCommandRunStatus {
  if (completedBy === "session-dispose") return "unknown";
  if (exitCode === null) return "unknown";
  return exitCode === 0 ? "succeeded" : "failed";
}

function replaceAt<T>(items: ReadonlyArray<T>, index: number, value: T): T[] {
  return [...items.slice(0, index), value, ...items.slice(index + 1)];
}

function disposeRunMarkers(run: TerminalCommandRun): void {
  run.startMarker?.dispose();
  if (run.endMarker !== run.startMarker) {
    run.endMarker?.dispose();
  }
}
