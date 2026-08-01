import { useCallback, useEffect, useRef, useState } from "react";
import type { LipSyncSource } from "../../core/body";
import {
  CodexRealtimeClient,
  type CodexRealtimeState,
  type CodexRealtimeStatus,
} from "./codex-realtime-client";

export interface CodexRealtimeClientLike extends LipSyncSource {
  getStatus(): CodexRealtimeStatus;
  start(): Promise<void>;
  stop(): void;
}

export type CodexRealtimeClientFactory = (
  sessionId: string,
  onStateChange: (state: CodexRealtimeState) => void,
) => CodexRealtimeClientLike;

interface UseCodexRealtimeOptions {
  readonly sessionId: string;
  readonly available: boolean;
  readonly fallbackLipSyncSource: LipSyncSource;
  readonly applyLipSyncSource: (source: LipSyncSource) => void;
  readonly setFallbackPlaybackEnabled?: (enabled: boolean) => void | Promise<void>;
  readonly createClient?: CodexRealtimeClientFactory;
}

interface UseCodexRealtimeResult {
  readonly state: CodexRealtimeState;
  readonly stop: () => void;
  readonly toggle: () => Promise<void>;
  readonly getLipSyncSource: () => LipSyncSource;
}

const defaultCreateClient: CodexRealtimeClientFactory = (sessionId, onStateChange) =>
  new CodexRealtimeClient(sessionId, onStateChange);

/** App が所有する realtime client を一つに限定し、古い client の通知を遮断する。 */
export function useCodexRealtime({
  sessionId,
  available,
  fallbackLipSyncSource,
  applyLipSyncSource,
  setFallbackPlaybackEnabled = () => {},
  createClient = defaultCreateClient,
}: UseCodexRealtimeOptions): UseCodexRealtimeResult {
  const clientRef = useRef<CodexRealtimeClientLike | null>(null);
  const fallbackRef = useRef(fallbackLipSyncSource);
  const applyLipSyncSourceRef = useRef(applyLipSyncSource);
  const setFallbackPlaybackEnabledRef = useRef(setFallbackPlaybackEnabled);
  const createClientRef = useRef(createClient);
  const sessionIdRef = useRef(sessionId);
  const [state, setState] = useState<CodexRealtimeState>({ status: "idle" });

  fallbackRef.current = fallbackLipSyncSource;
  applyLipSyncSourceRef.current = applyLipSyncSource;
  setFallbackPlaybackEnabledRef.current = setFallbackPlaybackEnabled;
  createClientRef.current = createClient;

  const restoreFallback = useCallback(() => {
    applyLipSyncSourceRef.current(fallbackRef.current);
  }, []);

  const restoreFallbackPlayback = useCallback(() => {
    try {
      const pending = setFallbackPlaybackEnabledRef.current(true);
      if (pending) {
        void pending.catch((error) => {
          console.error("[codex-realtime] failed to restore fallback playback ownership", error);
        });
      }
    } catch (error) {
      console.error("[codex-realtime] failed to restore fallback playback ownership", error);
    }
  }, []);

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
    client = createClientRef.current(sessionId, (nextState) => {
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
    });
    clientRef.current = client;

    try {
      // Claim request provenance before connecting so delayed Live-era voice tools remain suppressed.
      const pendingOwnershipClaim = setFallbackPlaybackEnabledRef.current(false);
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
  }, [restoreFallback, restoreFallbackPlayback, sessionId, stop]);

  useEffect(() => {
    const sessionChanged = sessionIdRef.current !== sessionId;
    sessionIdRef.current = sessionId;
    if (!available || sessionChanged) stop();
  }, [available, sessionId, stop]);

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
