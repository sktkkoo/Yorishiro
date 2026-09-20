import { listen } from "@tauri-apps/api/event";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type SessionRealtimeSelectedThreadState,
  sessionRealtimeSelectedThreadState,
} from "../bindings/tauri-commands";
import { ClaudeScreenObservationTransport } from "./claude-screen-observation";
import {
  ScreenObservationCancelledError,
  type ScreenObservationFrame,
} from "./codex-realtime/screen-observation";

interface Options {
  readonly available: boolean;
  readonly sessionId: string;
}

/** Claude の確定済み会話だけに共有を結び、再起動・会話切替で旧 lease を破棄する。 */
export function useClaudeScreenSharing({ available, sessionId }: Options) {
  const [selection, setSelection] = useState<{
    host: string;
    selected: SessionRealtimeSelectedThreadState;
  } | null>(null);
  const transport = useRef<{ key: string; value: ClaudeScreenObservationTransport } | null>(null);

  useEffect(() => {
    setSelection(null);
    if (!available) return;
    let disposed = false;
    let pending = false;
    let ended = false;
    let currentConversationId: string | undefined;
    let generation = 0;
    const unlisteners: (() => void)[] = [];
    const refresh = async () => {
      if (disposed || pending || ended) return;
      pending = true;
      const request = generation;
      try {
        const selected = await sessionRealtimeSelectedThreadState({ sessionId });
        if (disposed || request !== generation) return;
        currentConversationId = selected?.confirmed ? selected.sessionId : undefined;
        setSelection((previous) => {
          if (!selected?.confirmed || !selected.sessionId.trim()) return null;
          if (
            previous?.host === sessionId &&
            previous.selected.sessionId === selected.sessionId &&
            previous.selected.revision === selected.revision
          )
            return previous;
          return { host: sessionId, selected };
        });
      } catch {
        if (!disposed && request === generation) setSelection(null);
      } finally {
        pending = false;
      }
    };
    const invalidate = () => {
      generation += 1;
      transport.current?.value.stop();
      transport.current = null;
      setSelection(null);
    };
    const subscribe = async () => {
      const hook = await listen<string>("hook-signal", ({ payload }) => {
        if (disposed) return;
        let event: {
          sessionId?: string;
          session_id?: string;
          agent?: string;
          agent_id?: string;
          event?: string;
        };
        try {
          event = JSON.parse(payload);
        } catch {
          return;
        }
        if (event?.sessionId !== sessionId || event.agent !== "claude" || event.agent_id) return;
        if (
          event.event === "session-end" &&
          event.session_id &&
          currentConversationId &&
          event.session_id !== currentConversationId
        )
          return;
        if (event.event === "session-end" || event.event === "session-start") {
          ended = event.event === "session-end";
          if (!ended) currentConversationId = event.session_id;
          invalidate();
          if (!ended) void refresh();
        }
      });
      if (disposed) hook();
      else unlisteners.push(hook);
      const exit = await listen<{ session_id: string }>("pty-exit", ({ payload }) => {
        if (disposed) return;
        if (payload.session_id === sessionId) {
          ended = true;
          invalidate();
        }
      });
      if (disposed) exit();
      else unlisteners.push(exit);
    };
    void subscribe().catch(() => {});
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      disposed = true;
      generation += 1;
      window.clearInterval(timer);
      for (const unlisten of unlisteners) unlisten();
    };
  }, [available, sessionId]);

  const selected = available && selection?.host === sessionId ? selection.selected : null;
  const ownerKey = selected
    ? JSON.stringify(["claude", sessionId, selected.sessionId, selected.revision])
    : "";
  const conversationId = selected?.sessionId;
  const revision = selected?.revision;
  useEffect(() => {
    if (!ownerKey || conversationId === undefined || revision === undefined) return;
    const value = new ClaudeScreenObservationTransport({ sessionId, conversationId, revision });
    const owner = { key: ownerKey, value };
    transport.current = owner;
    return () => {
      value.stop();
      if (transport.current === owner) transport.current = null;
    };
  }, [ownerKey, sessionId, conversationId, revision]);

  const share = useCallback(
    (frame: ScreenObservationFrame, signal: AbortSignal) => {
      const current = transport.current;
      if (!ownerKey || current?.key !== ownerKey) {
        return Promise.reject(new ScreenObservationCancelledError());
      }
      return current.value.observe(frame, signal);
    },
    [ownerKey],
  );

  return { available: Boolean(ownerKey), ownerKey, share };
}
