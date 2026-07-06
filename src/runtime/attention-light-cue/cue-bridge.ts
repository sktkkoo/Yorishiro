/**
 * workspace-attention の awaiting-approval item を attention light の cue に橋渡しする bridge。
 *
 * identity dedup は AttentionLightCueStore 側の責務なので、この bridge は
 * snapshot が更新されるたびに active な awaiting-approval item すべてを
 * `cueForAttention` に渡すだけでよい（既に見た identity は store 側で無視される）。
 */
import type { Disposable } from "@yorishiro/sdk";
import { DEFAULT_SLOW_COMMAND_THRESHOLD_MS } from "../workspace-attention/command-run-producer";
import type { WorkspaceAttentionItem } from "../workspace-attention/types";
import type { WorkspaceAttentionStore } from "../workspace-attention/workspace-attention-store";
import type { AttentionLightCueStore } from "./cue-store";

export interface StartAttentionLightCueBridgeOptions {
  readonly cueStore: AttentionLightCueStore;
  readonly attentionStore: WorkspaceAttentionStore;
}

interface AwaitingApprovalDetail {
  readonly receivedAt: number;
}

interface RunCompletionDetail {
  readonly durationMs: number | null;
}

function isAwaitingApprovalDetail(detail: unknown): detail is AwaitingApprovalDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    typeof (detail as { receivedAt?: unknown }).receivedAt === "number"
  );
}

function isRunCompletionDetail(detail: unknown): detail is RunCompletionDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    ("durationMs" in detail
      ? typeof (detail as { durationMs?: unknown }).durationMs === "number" ||
        (detail as { durationMs?: unknown }).durationMs === null
      : false)
  );
}

function runCueIdentity(item: WorkspaceAttentionItem): string {
  return `run:${item.sessionId}:${item.producerKey}`;
}

export function startAttentionLightCueBridge(
  options: StartAttentionLightCueBridgeOptions,
): Disposable {
  const sub = options.attentionStore.subscribe((snapshot) => {
    for (const item of snapshot.activeItems) {
      if (item.type !== "awaiting-approval") continue;
      if (!isAwaitingApprovalDetail(item.detail)) continue;
      options.cueStore.cueForAttention(`${item.sessionId}:${item.detail.receivedAt}`);
    }
    for (const item of snapshot.activeItems) {
      if (item.type === "run-failed") {
        if (!isRunCompletionDetail(item.detail)) continue;
        const durationMs = item.detail.durationMs;
        if (durationMs === null || durationMs < DEFAULT_SLOW_COMMAND_THRESHOLD_MS) continue;
        options.cueStore.cueForRun("run-failed", runCueIdentity(item), item.sessionId);
      }
      if (item.type === "run-slow-completed") {
        options.cueStore.cueForRun("run-slow-completed", runCueIdentity(item), item.sessionId);
      }
    }
  });

  return {
    dispose: () => {
      sub.dispose();
    },
  };
}
