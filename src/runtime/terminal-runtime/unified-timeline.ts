/**
 * shell command run / agent tool run / loop run を 1 つの観察 timeline に並べる純関数
 * （LoopTimeline, inhabited-workspace-design.md §8 P2「同じ timeline に並べる」）。
 * primitive（各 store）は分けたまま、観察ビューとしてのみ時系列マージする。
 */
export type RunTimelineKind = "command" | "agent-tool" | "loop";

export interface RunTimelineEntry {
  readonly kind: RunTimelineKind;
  readonly sessionId: string;
  readonly id: number;
  readonly label: string;
  readonly status: string;
  readonly startedAt: number | null;
  readonly endedAt: number | null;
}

export interface RunTimelineInput {
  readonly commandRuns: ReadonlyArray<{
    readonly sessionId: string;
    readonly id: number;
    readonly command: string | null;
    readonly status: string;
    readonly startedAt: number | null;
    readonly endedAt: number | null;
  }>;
  readonly agentToolRuns: ReadonlyArray<{
    readonly sessionId: string;
    readonly id: number;
    readonly activity: string;
    readonly status: string;
    readonly startedAt: number;
    readonly endedAt: number | null;
  }>;
  readonly loopRuns: ReadonlyArray<{
    readonly sessionId: string;
    readonly id: number;
    readonly phase: string;
    readonly status: string;
    readonly startedAt: number;
    readonly endedAt: number | null;
  }>;
}

export function mergeRunTimeline(
  input: RunTimelineInput,
  limit?: number,
): ReadonlyArray<RunTimelineEntry> {
  const entries: RunTimelineEntry[] = [
    ...input.commandRuns.map(
      (run): RunTimelineEntry => ({
        kind: "command",
        sessionId: run.sessionId,
        id: run.id,
        label: run.command ?? "(command)",
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      }),
    ),
    ...input.agentToolRuns.map(
      (run): RunTimelineEntry => ({
        kind: "agent-tool",
        sessionId: run.sessionId,
        id: run.id,
        label: run.activity,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      }),
    ),
    ...input.loopRuns.map(
      (run): RunTimelineEntry => ({
        kind: "loop",
        sessionId: run.sessionId,
        id: run.id,
        label: run.phase,
        status: run.status,
        startedAt: run.startedAt,
        endedAt: run.endedAt,
      }),
    ),
  ];
  entries.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return limit === undefined ? entries : entries.slice(0, limit);
}
