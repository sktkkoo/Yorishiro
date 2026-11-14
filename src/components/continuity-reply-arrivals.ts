import type { ContinuityMessage } from "../runtime/continuity/types";

export interface ReplyArrivals {
  readonly known: ReadonlySet<string> | null;
  readonly pending: readonly string[];
}

export const createReplyArrivals = (): ReplyArrivals => ({ known: null, pending: [] });

export function reconcileReplyArrivals(
  current: ReplyArrivals,
  messages: readonly ContinuityMessage[],
  following: boolean,
): ReplyArrivals {
  const known = new Set(messages.map((message) => message.id));
  const previous = new Set(current.pending);
  // 初回の保存済み履歴は基準にし、保持期間による削除を新着として扱わない。
  const pending =
    following || current.known === null
      ? []
      : messages
          .filter(
            (message) =>
              message.role === "assistant" &&
              message.source !== "legacy" &&
              (previous.has(message.id) || !current.known?.has(message.id)),
          )
          .map((message) => message.id);
  return {
    known,
    pending:
      pending.length === current.pending.length &&
      pending.every((id, index) => id === current.pending[index])
        ? current.pending
        : pending,
  };
}

export function acknowledgeReplyArrival(current: ReplyArrivals, id: string): ReplyArrivals {
  return current.pending.includes(id)
    ? { ...current, pending: current.pending.filter((pendingId) => pendingId !== id) }
    : current;
}

export function clearReplyArrivals(current: ReplyArrivals): ReplyArrivals {
  return current.pending.length ? { ...current, pending: [] } : current;
}
