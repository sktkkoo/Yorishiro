import type { Disposable, ExpressionHandle } from "@charminal/sdk";
import { isValidAttentionRect } from "../../core/attention";
import type { Body } from "../../core/body";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { WorkspaceAttentionItem, WorkspaceAttentionSeverity } from "./types";
import type { WorkspaceAttentionStore } from "./workspace-attention-store";

const ATTENTION_SOURCE = "workspace-attention:primary";
const EXPRESSION_PRESET = "sad";
const EXPRESSION_DURATION_MS = 2400;
const EXPRESSION_RELEASE_MS = 600;

const TARGET_PRIORITY_BY_SEVERITY: Record<WorkspaceAttentionSeverity, number> = {
  low: 5,
  medium: 7,
  high: 9,
};

const EXPRESSION_INTENSITY_BY_SEVERITY: Record<WorkspaceAttentionSeverity, number> = {
  low: 0.08,
  medium: 0.16,
  high: 0.26,
};

export interface StartWorkspaceAttentionPresenceBridgeOptions {
  readonly store: WorkspaceAttentionStore;
  readonly attention: AttentionRuntime;
  readonly getBody: () => Pick<Body, "acquireExpressionSlot"> | null;
  readonly setTimeout?: (fn: () => void, delay: number) => unknown;
  readonly clearTimeout?: (id: unknown) => void;
  readonly now?: () => number;
}

export function startWorkspaceAttentionPresenceBridge(
  options: StartWorkspaceAttentionPresenceBridgeOptions,
): Disposable {
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn =
    options.clearTimeout ?? (globalThis.clearTimeout.bind(globalThis) as (id: unknown) => void);
  const now = options.now ?? defaultNow;

  let currentPrimaryId: string | null = null;
  let expressionHandle: ExpressionHandle | null = null;
  let expressionTimer: unknown | null = null;

  const releaseExpression = (): void => {
    if (expressionTimer !== null) {
      clearTimeoutFn(expressionTimer);
      expressionTimer = null;
    }
    expressionHandle?.release(EXPRESSION_RELEASE_MS);
    expressionHandle = null;
  };

  const pulseExpression = (item: WorkspaceAttentionItem): void => {
    const body = options.getBody();
    if (!body) return;
    releaseExpression();
    expressionHandle = body.acquireExpressionSlot(
      "persona",
      "mood",
      EXPRESSION_PRESET,
      EXPRESSION_INTENSITY_BY_SEVERITY[item.severity],
    );
    expressionTimer = setTimeoutFn(() => {
      releaseExpression();
    }, EXPRESSION_DURATION_MS);
  };

  const sub = options.store.subscribe((snapshot) => {
    const item = snapshot.primaryItem;
    if (!item) {
      currentPrimaryId = null;
      options.attention.setSourceTarget(ATTENTION_SOURCE, null);
      releaseExpression();
      return;
    }

    if (item.locus.kind === "terminal-region" && isValidAttentionRect(item.locus.rect)) {
      options.attention.setSourceTarget(ATTENTION_SOURCE, {
        kind: "terminal-region",
        source: ATTENTION_SOURCE,
        rect: item.locus.rect,
        confidence: 0.95,
        priority: TARGET_PRIORITY_BY_SEVERITY[item.severity],
        timestamp: now(),
        reason: `workspace-attention:${item.type}`,
      });
    } else {
      options.attention.setSourceTarget(ATTENTION_SOURCE, null);
    }

    if (item.id !== currentPrimaryId) {
      currentPrimaryId = item.id;
      pulseExpression(item);
    }
  });

  return {
    dispose: () => {
      sub.dispose();
      options.attention.setSourceTarget(ATTENTION_SOURCE, null);
      releaseExpression();
    },
  };
}

function defaultNow(): number {
  return globalThis.performance?.now() ?? Date.now();
}
