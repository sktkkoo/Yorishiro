export type AgentToolActivity = "reading" | "writing" | "running";

export interface AgentToolRun {
  readonly id: number;
  readonly sessionId: string;
  readonly activity: AgentToolActivity;
  readonly startedAt: number;
  readonly endedAt: number | null;
  readonly durationMs: number | null;
  readonly status: "running" | "completed";
}

const DEFAULT_MAX_RUNS = 200;

/**
 * agent session の tool 実行を command run とは別 primitive として観察する store
 * （AgentToolRun, inhabited-workspace-design.md §8 P2 の follow-on 実装）。
 * ToolActivityEvent の活動状態（reading/writing/running/none）の遷移から離散 run を
 * 構築する：none 以外で run 開始、none で完了。出力 content は持たず観察 metadata のみ。
 * shell の TerminalCommandRun とは primitive を分ける（spec の方針）。
 */
export class AgentToolRunStore {
  private readonly sessionId: string;
  private readonly maxRuns: number;
  private runs: AgentToolRun[] = [];
  private nextId = 1;
  private activeRunId: number | null = null;

  constructor(sessionId: string, opts: { readonly maxRuns?: number } = {}) {
    this.sessionId = sessionId;
    this.maxRuns = opts.maxRuns ?? DEFAULT_MAX_RUNS;
  }

  ingestActivity(activity: "reading" | "writing" | "running" | "none", at: number): void {
    if (activity === "none") {
      this.finalizeActive(at);
      return;
    }
    // active 中の活動変化（reading→writing 等）は同じ run の継続として扱い run を増やさない。
    if (this.activeRunId !== null) return;
    const run: AgentToolRun = {
      id: this.nextId++,
      sessionId: this.sessionId,
      activity,
      startedAt: at,
      endedAt: null,
      durationMs: null,
      status: "running",
    };
    this.runs = [...this.runs, run];
    this.activeRunId = run.id;
    this.trim();
  }

  private finalizeActive(at: number): void {
    if (this.activeRunId === null) return;
    const index = this.runs.findIndex((run) => run.id === this.activeRunId);
    this.activeRunId = null;
    if (index === -1) return;
    const current = this.runs[index];
    const finalized: AgentToolRun = {
      ...current,
      endedAt: at,
      durationMs: Math.max(0, at - current.startedAt),
      status: "completed",
    };
    this.runs = [...this.runs.slice(0, index), finalized, ...this.runs.slice(index + 1)];
  }

  getRecent(limit = DEFAULT_MAX_RUNS): ReadonlyArray<AgentToolRun> {
    return this.runs.slice(Math.max(0, this.runs.length - limit)).reverse();
  }

  private trim(): void {
    if (this.runs.length <= this.maxRuns) return;
    this.runs = this.runs.slice(this.runs.length - this.maxRuns);
  }
}

let sharedAgentToolRunStore: AgentToolRunStore | null = null;

/** agent tool 実行を集約する global singleton store（tool-activity は session 横断の観察源）。 */
export function getAgentToolRunStore(): AgentToolRunStore {
  if (!sharedAgentToolRunStore) {
    sharedAgentToolRunStore = new AgentToolRunStore("agent");
  }
  return sharedAgentToolRunStore;
}
