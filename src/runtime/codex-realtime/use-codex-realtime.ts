import { useCallback, useEffect, useRef, useState } from "react";
import type { LipSyncSource } from "../../core/body";
import type { StateExpressionSchedulerCallbacks } from "../agent-state-expression";
import {
  CodexRealtimeClient,
  type CodexRealtimeState,
  type CodexRealtimeStatus,
} from "./codex-realtime-client";
import { CodexThreadTracker } from "./codex-thread-tracker";

export interface CodexRealtimeClientLike extends LipSyncSource {
  getStatus(): CodexRealtimeStatus;
  start(): Promise<void>;
  stop(): void;
}

export type CodexRealtimeClientFactory = (
  sessionId: string,
  onStateChange: (state: CodexRealtimeState) => void,
  stateExpressionCallbacks?: StateExpressionSchedulerCallbacks,
  getPreferredThreadId?: () => string | null,
) => CodexRealtimeClientLike;

export interface CodexThreadTrackerLike {
  getCurrentThreadId(): string | null;
  start(): Promise<void>;
  stop(): void;
}

interface UseCodexRealtimeOptions {
  readonly sessionId: string;
  readonly available: boolean;
  readonly fallbackLipSyncSource: LipSyncSource;
  readonly applyLipSyncSource: (source: LipSyncSource) => void;
  readonly setFallbackPlaybackEnabled?: (enabled: boolean) => void | Promise<void>;
  readonly stateExpressionCallbacks?: StateExpressionSchedulerCallbacks;
  readonly createClient?: CodexRealtimeClientFactory;
  readonly createThreadTracker?: (sessionId: string) => CodexThreadTrackerLike;
}

interface UseCodexRealtimeResult {
  readonly state: CodexRealtimeState;
  readonly stop: () => void;
  readonly toggle: () => Promise<void>;
  readonly getLipSyncSource: () => LipSyncSource;
}

const defaultCreateClient: CodexRealtimeClientFactory = (
  sessionId,
  onStateChange,
  stateExpressionCallbacks,
  getPreferredThreadId,
) =>
  new CodexRealtimeClient(sessionId, onStateChange, {
    stateExpressionCallbacks,
    getPreferredThreadId,
  });

const defaultCreateThreadTracker = (sessionId: string): CodexThreadTrackerLike =>
  new CodexThreadTracker(sessionId);

const FALLBACK_RESTORE_RETRY_DELAYS_MS = [50, 200] as const;

/** App が所有する realtime client を一つに限定し、古い client の通知を遮断する。 */
export function useCodexRealtime({
  sessionId,
  available,
  fallbackLipSyncSource,
  applyLipSyncSource,
  setFallbackPlaybackEnabled = () => {},
  stateExpressionCallbacks,
  createClient = defaultCreateClient,
  createThreadTracker = defaultCreateThreadTracker,
}: UseCodexRealtimeOptions): UseCodexRealtimeResult {
  const clientRef = useRef<CodexRealtimeClientLike | null>(null);
  const threadTrackerRef = useRef<CodexThreadTrackerLike | null>(null);
  const fallbackRef = useRef(fallbackLipSyncSource);
  const applyLipSyncSourceRef = useRef(applyLipSyncSource);
  const setFallbackPlaybackEnabledRef = useRef(setFallbackPlaybackEnabled);
  const createClientRef = useRef(createClient);
  const sessionIdRef = useRef(sessionId);
  const fallbackPlaybackTransitionRef = useRef(0);
  const fallbackPlaybackRetryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [state, setState] = useState<CodexRealtimeState>({ status: "idle" });

  fallbackRef.current = fallbackLipSyncSource;
  applyLipSyncSourceRef.current = applyLipSyncSource;
  setFallbackPlaybackEnabledRef.current = setFallbackPlaybackEnabled;
  createClientRef.current = createClient;

  const restoreFallback = useCallback(() => {
    applyLipSyncSourceRef.current(fallbackRef.current);
  }, []);

  const beginFallbackPlaybackTransition = useCallback(() => {
    fallbackPlaybackTransitionRef.current += 1;
    if (fallbackPlaybackRetryTimerRef.current !== null) {
      clearTimeout(fallbackPlaybackRetryTimerRef.current);
      fallbackPlaybackRetryTimerRef.current = null;
    }
    return fallbackPlaybackTransitionRef.current;
  }, []);

  const restoreFallbackPlayback = useCallback(() => {
    const transition = beginFallbackPlaybackTransition();
    let retryIndex = 0;

    const retry = (error: unknown): void => {
      console.error("[codex-realtime] failed to restore fallback playback ownership", error);
      if (fallbackPlaybackTransitionRef.current !== transition) return;
      const delay = FALLBACK_RESTORE_RETRY_DELAYS_MS[retryIndex];
      if (delay === undefined) return;
      retryIndex += 1;
      fallbackPlaybackRetryTimerRef.current = setTimeout(() => {
        fallbackPlaybackRetryTimerRef.current = null;
        if (fallbackPlaybackTransitionRef.current === transition) attempt();
      }, delay);
    };

    const attempt = (): void => {
      try {
        const pending = setFallbackPlaybackEnabledRef.current(true);
        if (pending) void pending.catch(retry);
      } catch (error) {
        retry(error);
      }
    };

    attempt();
  }, [beginFallbackPlaybackTransition]);

  const claimFallbackPlayback = useCallback((): void | Promise<void> => {
    beginFallbackPlaybackTransition();
    return setFallbackPlaybackEnabledRef.current(false);
  }, [beginFallbackPlaybackTransition]);

  const stop = useCallback(() => {
    const client = clientRef.current;
    // stop() 内の同期 idle 通知も stale 扱いにするため、先に所有権を外す。
    clientRef.current = null;
    client?.stop();
    setState({ status: "idle" });
    restoreFallbackPlayback();
    restoreFallback();
  }, [restoreFallback, restoreFallbackPlayback]);

  const toggle = useCallback(async () => {
    if (clientRef.current) {
      stop();
      return;
    }

    let client: CodexRealtimeClientLike;
    client = createClientRef.current(
      sessionId,
      (nextState) => {
        // stop・session切替後や、置き換え済みclientからの通知は全て捨てる。
        if (clientRef.current !== client) return;

        if (nextState.status === "error") {
          clientRef.current = null;
          client.stop();
          setState(nextState);
          restoreFallbackPlayback();
          restoreFallback();
          return;
        }

        if (nextState.status === "idle") {
          // remote closed 後の次クリックを、新規 start として扱えるよう解放する。
          clientRef.current = null;
          setState(nextState);
          restoreFallbackPlayback();
          restoreFallback();
          return;
        }

        setState(nextState);
        if (nextState.status === "active") {
          applyLipSyncSourceRef.current(client);
        }
      },
      stateExpressionCallbacks,
      () => threadTrackerRef.current?.getCurrentThreadId() ?? null,
    );
    clientRef.current = client;

    try {
      // Claim request provenance before connecting so delayed Live-era voice tools remain suppressed.
      const pendingOwnershipClaim = claimFallbackPlayback();
      if (pendingOwnershipClaim) await pendingOwnershipClaim;
      if (clientRef.current !== client) return;
      await client.start();
    } catch (error) {
      // client 自身の error 通知、stop、session 切替で所有権を失った後なら無視する。
      if (clientRef.current !== client) return;
      clientRef.current = null;
      client.stop();
      const message = error instanceof Error ? error.message : String(error);
      console.error("[codex-realtime] start failed", error);
      setState({ status: "error", error: message });
      restoreFallbackPlayback();
      restoreFallback();
    }
  }, [
    claimFallbackPlayback,
    restoreFallback,
    restoreFallbackPlayback,
    sessionId,
    stateExpressionCallbacks,
    stop,
  ]);

  useEffect(() => {
    const sessionChanged = sessionIdRef.current !== sessionId;
    sessionIdRef.current = sessionId;
    if (!available || sessionChanged) stop();
  }, [available, sessionId, stop]);

  useEffect(() => {
    threadTrackerRef.current?.stop();
    threadTrackerRef.current = null;
    if (!available) return;
    const tracker = createThreadTracker(sessionId);
    threadTrackerRef.current = tracker;
    void tracker.start().catch((error) => {
      if (threadTrackerRef.current !== tracker) return;
      console.warn("[codex-realtime] thread tracker unavailable", error);
    });
    return () => {
      if (threadTrackerRef.current === tracker) threadTrackerRef.current = null;
      tracker.stop();
    };
  }, [available, createThreadTracker, sessionId]);

  useEffect(() => {
    // Re-stamp the default owner after a WebView reload because the Rust MCP process can survive it.
    restoreFallbackPlayback();
    return () => {
      const client = clientRef.current;
      clientRef.current = null;
      client?.stop();
      restoreFallbackPlayback();
    };
  }, [restoreFallbackPlayback]);

  const getLipSyncSource = useCallback(
    () => (clientRef.current?.getStatus() === "active" ? clientRef.current : fallbackRef.current),
    [],
  );

  return { state, stop, toggle, getLipSyncSource };
}
