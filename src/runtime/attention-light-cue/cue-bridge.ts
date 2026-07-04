/**
 * workspace-attention の awaiting-approval item を attention light の cue に橋渡しする bridge。
 *
 * identity dedup は AttentionLightCueStore 側の責務なので、この bridge は
 * snapshot が更新されるたびに active な awaiting-approval item すべてを
 * `cueForAttention` に渡すだけでよい（既に見た identity は store 側で無視される）。
 */
import type { Disposable } from "@charminal/sdk";
import type { WorkspaceAttentionStore } from "../workspace-attention/workspace-attention-store";
import type { AttentionLightCueStore } from "./cue-store";

export interface StartAttentionLightCueBridgeOptions {
  readonly cueStore: AttentionLightCueStore;
  readonly attentionStore: WorkspaceAttentionStore;
}

interface AwaitingApprovalDetail {
  readonly receivedAt: number;
}

function isAwaitingApprovalDetail(detail: unknown): detail is AwaitingApprovalDetail {
  return (
    typeof detail === "object" &&
    detail !== null &&
    typeof (detail as { receivedAt?: unknown }).receivedAt === "number"
  );
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
  });

  return {
    dispose: () => {
      sub.dispose();
    },
  };
}
