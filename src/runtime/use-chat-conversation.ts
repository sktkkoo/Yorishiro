import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatTranscript, ClaudeChatTranscriptStore } from "./chat-transcript";

const EMPTY_TRANSCRIPT: ChatTranscript = {
  conversationId: null,
  messages: [],
  working: false,
};

interface ChatConversationOptions {
  readonly enabled: boolean;
  readonly sessionId: string;
  readonly agent: string;
  readonly generation: number;
  readonly selectedThreadId: string | null;
  readonly claudeStore: ClaudeChatTranscriptStore;
  readonly readCodexTranscript: () => Promise<ChatTranscript>;
  readonly submit: (text: string) => Promise<void>;
  readonly canSend: boolean;
}

/** host の会話取得と明示的なユーザー送信だけを扱う。pack へは公開しない。 */
export function useChatConversation({
  enabled,
  sessionId,
  agent,
  generation,
  selectedThreadId,
  claudeStore,
  readCodexTranscript,
  submit,
  canSend,
}: ChatConversationOptions) {
  const scope = `${sessionId}:${agent}:${generation}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const selectionRef = useRef(selectedThreadId);
  selectionRef.current = selectedThreadId;
  const previousSelectionRef = useRef(selectedThreadId);
  const sendOperationRef = useRef(0);
  const [data, setData] = useState({ scope, transcript: EMPTY_TRANSCRIPT, loaded: false });
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const sendingRef = useRef(false);
  const [readError, setReadError] = useState(false);
  const [sendError, setSendError] = useState(false);
  const knownConversationRef = useRef<string | null>(null);

  // 別セッションへ下書きや返信を持ち越さない。表示モードの往復では保持する。
  useEffect(() => {
    sendOperationRef.current++;
    setData({ scope, transcript: EMPTY_TRANSCRIPT, loaded: false });
    knownConversationRef.current = null;
    setDraft("");
    setSending(false);
    sendingRef.current = false;
    setReadError(false);
    setSendError(false);
  }, [scope]);

  useEffect(() => {
    const previous = previousSelectionRef.current;
    previousSelectionRef.current = selectedThreadId;
    if (agent !== "codex" || previous === null || previous === selectedThreadId) return;
    // 履歴の到着時ではなく切替時に破棄し、新しい会話で書き始めた下書きを守る。
    sendOperationRef.current++;
    knownConversationRef.current = null;
    setData({ scope, transcript: EMPTY_TRANSCRIPT, loaded: false });
    setDraft("");
    setSendError(false);
    setReadError(false);
    sendingRef.current = false;
    setSending(false);
  }, [agent, scope, selectedThreadId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: 選択 thread の切替で実行中の読取りを無効化して読み直す。
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const receive = (transcript: ChatTranscript) => {
      if (cancelled || scopeRef.current !== scope) return;
      const previous = knownConversationRef.current;
      if (previous !== null && previous !== transcript.conversationId) {
        setDraft("");
        setSendError(false);
      }
      knownConversationRef.current = transcript.conversationId;
      setData((current) => {
        const old = current.transcript;
        if (
          current.scope === scope &&
          current.loaded &&
          old.conversationId === transcript.conversationId &&
          old.working === transcript.working &&
          old.needsAttention === transcript.needsAttention &&
          old.messages.length === transcript.messages.length &&
          old.messages.every((message, index) => {
            const next = transcript.messages[index];
            return (
              message.id === next.id && message.role === next.role && message.text === next.text
            );
          })
        )
          return current;
        return { scope, transcript, loaded: true };
      });
      setReadError(false);
    };
    if (agent === "claude") {
      const refresh = () => receive(claudeStore.read(sessionId));
      refresh();
      const unsubscribe = claudeStore.subscribe(refresh);
      return () => {
        cancelled = true;
        unsubscribe();
      };
    }
    if (agent !== "codex") return;
    const poll = async () => {
      try {
        receive(await readCodexTranscript());
      } catch {
        if (!cancelled && scopeRef.current === scope) setReadError(true);
      } finally {
        if (!cancelled) timer = setTimeout(poll, 750);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, scope, agent, sessionId, claudeStore, readCodexTranscript, selectedThreadId]);

  const send = useCallback(async () => {
    if (!enabled || !canSend || sendingRef.current || draft.trim().length === 0) return;
    const submittedDraft = draft;
    const selection = selectionRef.current;
    const operation = ++sendOperationRef.current;
    const isCurrent = () =>
      sendOperationRef.current === operation &&
      scopeRef.current === scope &&
      (selection === null || selectionRef.current === selection);
    sendingRef.current = true;
    setSending(true);
    setSendError(false);
    try {
      await submit(submittedDraft);
      if (isCurrent()) {
        setDraft((current) => (current === submittedDraft ? "" : current));
      }
    } catch {
      if (isCurrent()) setSendError(true);
    } finally {
      if (isCurrent()) {
        sendingRef.current = false;
        setSending(false);
      }
    }
  }, [enabled, canSend, draft, scope, submit]);

  const stale =
    data.scope !== scope ||
    (agent === "codex" &&
      data.transcript.conversationId !== null &&
      data.transcript.conversationId !== selectedThreadId);
  return {
    transcript: stale ? EMPTY_TRANSCRIPT : data.transcript,
    loading: stale || !data.loaded,
    draft,
    setDraft,
    sending,
    error: sendError ? ("send" as const) : readError ? ("read" as const) : null,
    send,
  };
}
