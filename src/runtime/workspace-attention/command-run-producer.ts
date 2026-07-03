import type { Disposable } from "@charminal/sdk";
import type { TerminalCommandRun } from "../terminal-runtime/command-run-store";
import type { TerminalCommandRunLocus, TerminalRuntime } from "../terminal-runtime/types";
import type {
  WorkspaceAttentionItemType,
  WorkspaceAttentionLocus,
  WorkspaceAttentionSeverity,
} from "./types";
import type { WorkspaceAttentionStore } from "./workspace-attention-store";

export const COMMAND_RUN_ATTENTION_PRODUCER = { kind: "host" as const, id: "command-block" };
export const DEFAULT_RUNNING_COMMAND_THRESHOLD_MS = 10_000;
export const DEFAULT_SLOW_COMMAND_THRESHOLD_MS = 30_000;

export interface CommandRunAttentionClassification {
  readonly type: WorkspaceAttentionItemType;
  readonly severity: WorkspaceAttentionSeverity;
}

export interface StartCommandRunAttentionProducerOptions {
  readonly store: WorkspaceAttentionStore;
  readonly terminal: Pick<
    TerminalRuntime,
    | "getCommandRunLocus"
    | "getCommandRunsRecent"
    | "subscribeCommandRunFinalized"
    | "subscribeCommandRunStarted"
  >;
  readonly runningCommandThresholdMs?: number;
  readonly slowCommandThresholdMs?: number;
  readonly setTimeout?: (fn: () => void, delay: number) => unknown;
  readonly clearTimeout?: (id: unknown) => void;
}

export function startCommandRunAttentionProducer(
  options: StartCommandRunAttentionProducerOptions,
): Disposable {
  const runningThresholdMs =
    options.runningCommandThresholdMs ?? DEFAULT_RUNNING_COMMAND_THRESHOLD_MS;
  const slowThresholdMs = options.slowCommandThresholdMs ?? DEFAULT_SLOW_COMMAND_THRESHOLD_MS;
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn =
    options.clearTimeout ?? (globalThis.clearTimeout.bind(globalThis) as (id: unknown) => void);
  const runningEntries = new Map<string, { itemId: string | null; timer: unknown | null }>();

  const clearRunningEntry = (producerKey: string): void => {
    const entry = runningEntries.get(producerKey);
    if (!entry) return;
    if (entry.timer !== null) {
      clearTimeoutFn(entry.timer);
    }
    if (entry.itemId !== null) {
      options.store.resolve(entry.itemId);
    }
    runningEntries.delete(producerKey);
  };

  const startedSub = options.terminal.subscribeCommandRunStarted((run) => {
    if (run.status !== "running" || run.startedAt === null) return;
    const producerKey = runningLongProducerKey(run);
    clearRunningEntry(producerKey);
    const entry = {
      itemId: null,
      timer: setTimeoutFn(() => {
        const currentEntry = runningEntries.get(producerKey);
        if (!currentEntry) return;
        currentEntry.timer = null;
        const currentRun = options.terminal
          .getCommandRunsRecent()
          .find((candidate) => candidate.id === run.id && candidate.sessionId === run.sessionId);
        if (!currentRun || currentRun.status !== "running") {
          runningEntries.delete(producerKey);
          return;
        }

        const locus = toWorkspaceAttentionLocus(
          currentRun,
          options.terminal.getCommandRunLocus(currentRun.id),
        );
        const item = options.store.upsert({
          sessionId: currentRun.sessionId,
          locus,
          type: "run-running-long",
          severity: "medium",
          producer: COMMAND_RUN_ATTENTION_PRODUCER,
          producerKey,
          detail: {
            command: currentRun.command,
            elapsedMs:
              currentRun.startedAt === null ? null : Math.max(0, Date.now() - currentRun.startedAt),
            startedAt: currentRun.startedAt,
          },
        });
        currentEntry.itemId = item.id;
      }, runningThresholdMs),
    };
    runningEntries.set(producerKey, entry);
  });

  const finalizedSub = options.terminal.subscribeCommandRunFinalized((run) => {
    clearRunningEntry(runningLongProducerKey(run));
    const classification = classifyCommandRunAttention(run, slowThresholdMs);
    if (!classification) return;
    const locus = toWorkspaceAttentionLocus(run, options.terminal.getCommandRunLocus(run.id));
    options.store.upsert({
      sessionId: run.sessionId,
      locus,
      type: classification.type,
      severity: classification.severity,
      producer: COMMAND_RUN_ATTENTION_PRODUCER,
      producerKey: `command-block:${run.sessionId}:${run.id}`,
      detail: {
        command: run.command,
        exitCode: run.exitCode,
        durationMs: run.durationMs,
        completedBy: run.completedBy,
      },
    });
  });

  return {
    dispose: () => {
      startedSub.dispose();
      finalizedSub.dispose();
      for (const producerKey of Array.from(runningEntries.keys())) {
        clearRunningEntry(producerKey);
      }
    },
  };
}

export function classifyCommandRunAttention(
  run: TerminalCommandRun,
  slowThresholdMs: number,
): CommandRunAttentionClassification | null {
  if (run.exitCode !== null && run.exitCode !== 0) {
    return { type: "run-failed", severity: "high" };
  }
  if (run.status === "succeeded" && run.durationMs !== null && run.durationMs > slowThresholdMs) {
    return { type: "run-slow-completed", severity: "medium" };
  }
  return null;
}

function runningLongProducerKey(run: Pick<TerminalCommandRun, "id" | "sessionId">): string {
  return `command-block:${run.sessionId}:${run.id}:running-long`;
}

function toWorkspaceAttentionLocus(
  run: TerminalCommandRun,
  locus: TerminalCommandRunLocus | null,
): WorkspaceAttentionLocus {
  // locus は当面、MCP/lighting など metadata consumer 用に保持する。失敗 turn の枠が
  // 可視化される Tier 2 までは、aura などの視覚 consumer には接続しない。
  if (!locus) {
    return { kind: "session", sessionId: run.sessionId };
  }
  return {
    kind: "terminal-region",
    sessionId: run.sessionId,
    commandRunId: run.id,
    rect: locus.rect,
    range: locus.range,
  };
}
