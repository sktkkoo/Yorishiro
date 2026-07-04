import type { LoopPhase } from "@charminal/sdk";

export interface LoopRun {
  readonly id: number;
  readonly agent: string | null;
  readonly phase: LoopPhase;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly status: "running" | "completed" | "failed";
}

const DEFAULT_MAX_RUNS = 100;

/**
 * 自律 agent loop の lifecycle を離散 run record で観察する store
 * （LoopTimeline の loop primitive, inhabited-workspace-design.md §8 P2）。
 * LoopLifecycleEvent の phase 遷移から構築：started で開始、completed/failed で終了、
 * 中間 phase（iterating 等）は active run の phase を更新する。agent ごとに並行 run を持つ。
 * Charminal は loop を駆動せず観察のみ（loop-presence-layer / observation-only）。
 */
export class LoopRunStore {
  private readonly maxRuns: number;
  private runs: LoopRun[] = [];
  private nextId = 1;
  private readonly activeByAgent = new Map<string, number>();

  constructor(opts: { readonly maxRuns?: number } = {}) {
    this.maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
  }

  ingestPhase(phase: LoopPhase, agent: string | null, at: number): void {
    const key = agent ?? "__pack__";
    if (phase === "started") {
      const run: LoopRun = {
        id: this.nextId++,
        agent,
        phase,
        startedAt: at,
        endedAt: null,
        durationMs: null,
        status: "running",
      };
      this.runs = [...this.runs, run];
      this.activeByAgent.set(key, run.id);
      this.trim();
      return;
    }
    const activeId = this.activeByAgent.get(key);
    if (activeId === undefined) return; // started を観測していない agent の中間/終了 phase は無視
    const index = this.runs.findIndex((run) => run.id === activeId);
    if (index === -1) {
      this.activeByAgent.delete(key);
      return;
    }
    const status: LoopRun["status"] =
      phase === "completed" ? "completed" : phase === "failed" ? "failed" : "running";
    const terminal = status !== "running";
    const current = this.runs[index];
    const updated: LoopRun = {
      ...current,
      phase,
      status,
      endedAt: terminal ? at : null,
      durationMs: terminal ? Math.max(0, at - current.startedAt) : null,
    };
    this.runs = [...this.runs.slice(0, index), updated, ...this.runs.slice(index + 1)];
    if (terminal) this.activeByAgent.delete(key);
  }

  getRecent(limit = DEFAULT_MAX_RUNS): ReadonlyArray<LoopRun> {
    return this.runs.slice(Math.max(0, this.runs.length - limit)).reverse();
  }

  private trim(): void {
    if (this.runs.length <= this.maxRuns) return;
    this.runs = this.runs.slice(this.runs.length - this.maxRuns);
  }
}

let sharedLoopRunStore: LoopRunStore | null = null;

/** loop lifecycle を集約する global singleton store（loop-lifecycle は session 横断の観察源）。 */
export function getLoopRunStore(): LoopRunStore {
  if (!sharedLoopRunStore) {
    sharedLoopRunStore = new LoopRunStore();
  }
  return sharedLoopRunStore;
}
