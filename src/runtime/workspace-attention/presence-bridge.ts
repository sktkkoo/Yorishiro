import type { Disposable, ExpressionHandle } from "@charminal/sdk";
import type { Body } from "../../core/body";
import type { AttentionRuntime } from "../attention-runtime/types";
import type { WorkspaceAttentionItem, WorkspaceAttentionSeverity } from "./types";
import type { WorkspaceAttentionStore } from "./workspace-attention-store";

const EXPRESSION_PRESET = "sad";
const EXPRESSION_DURATION_MS = 2400;
const EXPRESSION_RELEASE_MS = 600;

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
}

export function startWorkspaceAttentionPresenceBridge(
  options: StartWorkspaceAttentionPresenceBridgeOptions,
): Disposable {
  const setTimeoutFn = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
  const clearTimeoutFn =
    options.clearTimeout ?? (globalThis.clearTimeout.bind(globalThis) as (id: unknown) => void);

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
      releaseExpression();
      return;
    }

    if (item.id !== currentPrimaryId) {
      currentPrimaryId = item.id;
      pulseExpression(item);
    }
  });

  return {
    dispose: () => {
      sub.dispose();
      releaseExpression();
    },
  };
}
