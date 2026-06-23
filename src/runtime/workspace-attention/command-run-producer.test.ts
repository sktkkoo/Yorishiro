import { describe, expect, it, vi } from "vitest";
import type { TerminalCommandRun } from "../terminal-runtime/command-run-store";
import type { TerminalRuntime } from "../terminal-runtime/types";
import {
  classifyCommandRunAttention,
  DEFAULT_RUNNING_COMMAND_THRESHOLD_MS,
  startCommandRunAttentionProducer,
} from "./command-run-producer";
import { createWorkspaceAttentionStore } from "./workspace-attention-store";

function commandRun(override: Partial<TerminalCommandRun> = {}): TerminalCommandRun {
  return {
    id: 1,
    sessionId: "session-1",
    command: "npm test",
    cwd: "/repo",
    status: "succeeded",
    completedBy: "osc133",
    exitCode: 0,
    startedAt: 1000,
    endedAt: 1200,
    durationMs: 200,
    startMarker: null,
    endMarker: null,
    ...override,
  };
}

function createTerminalFake(): {
  readonly terminal: Pick<
    TerminalRuntime,
    | "getCommandRunLocus"
    | "getCommandRunsRecent"
    | "subscribeCommandRunFinalized"
    | "subscribeCommandRunStarted"
  >;
  readonly emitFinalized: (run: TerminalCommandRun) => void;
  readonly emitStarted: (run: TerminalCommandRun) => void;
  readonly getCommandRunLocus: ReturnType<typeof vi.fn>;
} {
  let finalizedListener: ((run: TerminalCommandRun) => void) | null = null;
  let startedListener: ((run: TerminalCommandRun) => void) | null = null;
  let runs: TerminalCommandRun[] = [];
  const getCommandRunLocus = vi.fn((runId: number) => ({
    kind: "terminal-command-run-locus" as const,
    sessionId: "session-1",
    commandRunId: runId,
    viewport: { viewportY: 0, rows: 24, cols: 80 },
    range: { startRow: 1, endRow: 3, startCol: 0, endCol: 79 },
    rect: { x: 10, y: 20, width: 400, height: 60 },
    polygon: [],
  }));
  return {
    terminal: {
      getCommandRunsRecent: () => runs,
      subscribeCommandRunStarted: (nextListener) => {
        startedListener = nextListener;
        return {
          dispose: () => {
            startedListener = null;
          },
        };
      },
      subscribeCommandRunFinalized: (nextListener) => {
        finalizedListener = nextListener;
        return {
          dispose: () => {
            finalizedListener = null;
          },
        };
      },
      getCommandRunLocus,
    },
    emitFinalized: (run) => {
      runs = [run, ...runs.filter((candidate) => candidate.id !== run.id)];
      finalizedListener?.(run);
    },
    emitStarted: (run) => {
      runs = [run, ...runs.filter((candidate) => candidate.id !== run.id)];
      startedListener?.(run);
    },
    getCommandRunLocus,
  };
}

function createTimerFake(): {
  readonly setTimeout: (fn: () => void, delay: number) => number;
  readonly clearTimeout: ReturnType<typeof vi.fn<(id: unknown) => void>>;
  readonly delays: number[];
  readonly fire: (index?: number) => void;
} {
  const callbacks: Array<() => void> = [];
  const delays: number[] = [];
  return {
    setTimeout: (fn, delay) => {
      callbacks.push(fn);
      delays.push(delay);
      return callbacks.length - 1;
    },
    clearTimeout: vi.fn<(id: unknown) => void>(),
    delays,
    fire: (index = callbacks.length - 1) => {
      callbacks[index]?.();
    },
  };
}

describe("command-run attention producer", () => {
  it("failed run を high severity item にする", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createTerminalFake();
    startCommandRunAttentionProducer({ store, terminal: fake.terminal });

    fake.emitFinalized(commandRun({ status: "failed", exitCode: 1 }));

    expect(store.getActiveItems()).toHaveLength(1);
    expect(store.getActiveItems()[0]).toMatchObject({
      type: "run-failed",
      severity: "high",
      producer: { kind: "host", id: "command-block" },
      locus: {
        kind: "terminal-region",
        commandRunId: 1,
        rect: { x: 10, y: 20, width: 400, height: 60 },
      },
    });
  });

  it("fast success は item にしない", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createTerminalFake();
    startCommandRunAttentionProducer({ store, terminal: fake.terminal });

    fake.emitFinalized(commandRun());

    expect(store.getActiveItems()).toHaveLength(0);
    expect(fake.getCommandRunLocus).not.toHaveBeenCalled();
  });

  it("slow success は medium severity item にする", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createTerminalFake();
    startCommandRunAttentionProducer({
      store,
      terminal: fake.terminal,
      slowCommandThresholdMs: 500,
    });

    fake.emitFinalized(commandRun({ durationMs: 1200 }));

    expect(store.getActiveItems()[0]).toMatchObject({
      type: "run-slow-completed",
      severity: "medium",
    });
  });

  it("locus が取れない run は session locus に fallback する", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createTerminalFake();
    fake.getCommandRunLocus.mockReturnValue(null);
    startCommandRunAttentionProducer({ store, terminal: fake.terminal });

    fake.emitFinalized(commandRun({ status: "failed", exitCode: 2 }));

    expect(store.getActiveItems()[0]?.locus).toEqual({
      kind: "session",
      sessionId: "session-1",
    });
  });

  it("running run は threshold 後に medium severity item にする", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createTerminalFake();
    const timer = createTimerFake();
    startCommandRunAttentionProducer({
      store,
      terminal: fake.terminal,
      runningCommandThresholdMs: 500,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    fake.emitStarted(
      commandRun({
        status: "running",
        completedBy: null,
        exitCode: null,
        endedAt: null,
        durationMs: null,
      }),
    );

    expect(store.getActiveItems()).toHaveLength(0);
    expect(timer.delays).toEqual([500]);

    timer.fire();

    expect(store.getActiveItems()[0]).toMatchObject({
      type: "run-running-long",
      severity: "medium",
      producerKey: "command-block:session-1:1:running-long",
      locus: {
        kind: "terminal-region",
        commandRunId: 1,
      },
    });
  });

  it("running run が threshold 前に完了したら item にしない", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createTerminalFake();
    const timer = createTimerFake();
    startCommandRunAttentionProducer({
      store,
      terminal: fake.terminal,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    fake.emitStarted(
      commandRun({
        status: "running",
        completedBy: null,
        exitCode: null,
        endedAt: null,
        durationMs: null,
      }),
    );
    fake.emitFinalized(commandRun());
    timer.fire();

    expect(store.getActiveItems()).toHaveLength(0);
    expect(timer.clearTimeout).toHaveBeenCalledOnce();
  });

  it("finalize 時に running-long item を resolve し、failed item に切り替える", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createTerminalFake();
    const timer = createTimerFake();
    startCommandRunAttentionProducer({
      store,
      terminal: fake.terminal,
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    });

    fake.emitStarted(
      commandRun({
        status: "running",
        completedBy: null,
        exitCode: null,
        endedAt: null,
        durationMs: null,
      }),
    );
    timer.fire();
    expect(store.getActiveItems().map((item) => item.type)).toEqual(["run-running-long"]);

    fake.emitFinalized(commandRun({ status: "failed", exitCode: 1 }));

    expect(store.getActiveItems().map((item) => item.type)).toEqual(["run-failed"]);
  });

  it("default running threshold は 10 秒にする", () => {
    expect(DEFAULT_RUNNING_COMMAND_THRESHOLD_MS).toBe(10_000);
  });

  it("classification は failed を slow より優先する", () => {
    expect(
      classifyCommandRunAttention(
        commandRun({ status: "failed", exitCode: 1, durationMs: 60_000 }),
        30_000,
      ),
    ).toEqual({ type: "run-failed", severity: "high" });
  });
});
