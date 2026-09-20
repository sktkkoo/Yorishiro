import { useCallback, useEffect, useRef, useState } from "react";
import {
  type ChatApprovalDecision,
  type ChatApprovalRequest,
  sessionChatApprovalRespond,
  sessionChatApprovals,
} from "../bindings/tauri-commands";

interface ChatApprovalOptions {
  readonly enabled: boolean;
  readonly sessionId: string;
  readonly agent: string;
  readonly generation: number;
  readonly conversationId: string | null;
}

interface ApprovalOwner {
  readonly id: string;
  readonly scope: string;
  readonly busy: Set<string>;
  readonly resolved: Set<string>;
  requests: readonly ChatApprovalRequest[];
}

function nextOwnerId(): string {
  // ブラウザの時計精度と HMR に依存せず、同じ document 内で必ず単調増加させる。
  const clock = globalThis as typeof globalThis & { __yorishiroChatApprovalOrder?: number };
  const now = performance.timeOrigin + performance.now();
  const order = Math.max(now, (clock.__yorishiroChatApprovalOrder ?? 0) + 0.001);
  clock.__yorishiroChatApprovalOrder = order;
  return `${order}:${crypto.randomUUID()}`;
}

/** 表示中の Chat だけが承認を受け取る。判断はボタン操作からのみ送信する。 */
export function useChatApprovals({
  enabled,
  sessionId,
  agent,
  generation,
  conversationId,
}: ChatApprovalOptions) {
  const scope = JSON.stringify([sessionId, agent, generation, conversationId]);
  const activeRef = useRef({ enabled, scope });
  activeRef.current = { enabled, scope };
  const ownerRef = useRef<ApprovalOwner | null>(null);
  const [snapshot, setSnapshot] = useState<{
    owner: ApprovalOwner | null;
    requests: readonly ChatApprovalRequest[];
    busy: readonly string[];
    error: "read" | "respond" | null;
  }>({ owner: null, requests: [], busy: [], error: null });

  useEffect(() => {
    if (!enabled) return;
    const owner: ApprovalOwner = {
      // HMR をまたいでも新旧の画面を比較できる順序をネイティブへ渡す。
      id: nextOwnerId(),
      scope,
      busy: new Set(),
      resolved: new Set(),
      requests: [],
    };
    ownerRef.current = owner;
    setSnapshot({ owner, requests: [], busy: [], error: null });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const isCurrent = () =>
      ownerRef.current === owner && activeRef.current.enabled && activeRef.current.scope === scope;
    const poll = async () => {
      try {
        const received = await sessionChatApprovals({
          sessionId,
          ownerId: owner.id,
          enabled: true,
        });
        if (!isCurrent()) return;
        owner.requests = received.filter(
          (request) =>
            request.sessionId === sessionId &&
            request.agent === agent &&
            (conversationId === null || request.conversationId === conversationId) &&
            !owner.resolved.has(request.id),
        );
        setSnapshot((current) => ({
          owner,
          requests: owner.requests,
          busy: [...owner.busy],
          error: current.owner === owner && current.error === "respond" ? "respond" : null,
        }));
      } catch {
        if (isCurrent()) {
          owner.requests = [];
          setSnapshot({ owner, requests: [], busy: [...owner.busy], error: "read" });
        }
      } finally {
        if (isCurrent()) timer = setTimeout(poll, 500);
      }
    };
    void poll();
    return () => {
      if (ownerRef.current === owner) ownerRef.current = null;
      clearTimeout(timer);
      void sessionChatApprovals({ sessionId, ownerId: owner.id, enabled: false }).catch(() => {});
    };
  }, [enabled, scope, sessionId, agent, conversationId]);

  const respond = useCallback(
    async (id: string, decision: ChatApprovalDecision) => {
      const owner = ownerRef.current;
      if (
        !enabled ||
        !activeRef.current.enabled ||
        activeRef.current.scope !== scope ||
        !owner ||
        owner.scope !== scope ||
        owner.busy.has(id) ||
        owner.resolved.has(id) ||
        !owner.requests.some(
          (request) =>
            request.id === id && request.choices.some((choice) => choice.id === decision),
        )
      )
        return;
      owner.busy.add(id);
      setSnapshot({ owner, requests: owner.requests, busy: [...owner.busy], error: null });
      const isCurrent = () =>
        ownerRef.current === owner &&
        activeRef.current.enabled &&
        activeRef.current.scope === scope;
      try {
        await sessionChatApprovalRespond({ sessionId, ownerId: owner.id, id, decision });
        owner.resolved.add(id);
        owner.requests = owner.requests.filter((request) => request.id !== id);
        if (isCurrent()) {
          setSnapshot({ owner, requests: owner.requests, busy: [...owner.busy], error: null });
        }
      } catch {
        if (isCurrent()) {
          setSnapshot({ owner, requests: owner.requests, busy: [...owner.busy], error: "respond" });
        }
      } finally {
        owner.busy.delete(id);
        if (isCurrent()) setSnapshot((current) => ({ ...current, busy: [...owner.busy] }));
      }
    },
    [enabled, scope, sessionId],
  );

  const current = enabled && snapshot.owner === ownerRef.current && snapshot.owner?.scope === scope;
  return {
    requests: current ? snapshot.requests : [],
    busyIds: current ? snapshot.busy : [],
    error: current ? snapshot.error : null,
    respond,
  };
}
