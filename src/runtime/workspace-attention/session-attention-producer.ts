import type { Disposable } from "@charminal/sdk";
import type { SessionStatusStore } from "../session-status/session-status-store";
import type { WorkspaceAttentionStore } from "./workspace-attention-store";

export const SESSION_ATTENTION_PRODUCER = { kind: "host" as const, id: "session-attention" };

export interface StartSessionAttentionProducerOptions {
  readonly store: WorkspaceAttentionStore;
  readonly sessionStatus: Pick<SessionStatusStore, "subscribe" | "list">;
}

/**
 * SessionStatusStore（全 session の許可待ち read model）を workspace-attention の
 * item に橋渡しする producer。
 *
 * どの session でも `activity === "awaiting-input" && attention !== null` になったら
 * `awaiting-approval` item を upsert し、解消（attention が null に戻る / session が
 * 消える）したら resolve する。sessionId → itemId は producer local に記録し、
 * command-run-producer と同じ手法で対象を追跡する。
 */
export function startSessionAttentionProducer(
  options: StartSessionAttentionProducerOptions,
): Disposable {
  const itemIdBySessionId = new Map<string, string>();

  const resolveSession = (sessionId: string): void => {
    const itemId = itemIdBySessionId.get(sessionId);
    if (itemId === undefined) return;
    options.store.resolve(itemId);
    itemIdBySessionId.delete(sessionId);
  };

  const sync = (): void => {
    const statuses = options.sessionStatus.list();
    const seenSessionIds = new Set<string>();
    for (const status of statuses) {
      seenSessionIds.add(status.sessionId);
      if (status.activity !== "awaiting-input" || status.attention === null) {
        resolveSession(status.sessionId);
        continue;
      }
      const attention = status.attention;
      const item = options.store.upsert({
        sessionId: status.sessionId,
        locus: { kind: "session", sessionId: status.sessionId },
        type: "awaiting-approval",
        severity: "medium",
        producer: SESSION_ATTENTION_PRODUCER,
        producerKey: `session-attention:${status.sessionId}`,
        detail: {
          receivedAt: attention.receivedAt,
          title: attention.title,
          body: attention.body,
          source: attention.source,
        },
      });
      itemIdBySessionId.set(status.sessionId, item.id);
    }

    // status 一覧から消えた session（close 済み）の item を resolve する。
    for (const sessionId of Array.from(itemIdBySessionId.keys())) {
      if (!seenSessionIds.has(sessionId)) {
        resolveSession(sessionId);
      }
    }
  };

  const unsubscribe = options.sessionStatus.subscribe(sync);
  sync();

  return {
    dispose: () => {
      unsubscribe();
    },
  };
}
