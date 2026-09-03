import { useCallback, useEffect, useRef, useState } from "react";
import type { LipSyncSource } from "../../core/body";
import type { StateExpressionSchedulerCallbacks } from "../agent-state-expression";
import {
  CodexRealtimeClient,
  type CodexRealtimePersonaApplication,
  type CodexRealtimePersonaSnapshot,
  type CodexRealtimeState,
  type CodexRealtimeStatus,
  type CodexRealtimeVoiceFallback,
  DEFAULT_CODEX_REALTIME_VOICE,
} from "./codex-realtime-client";
import { type CodexQuickChatResponse, CodexThreadTracker } from "./codex-thread-tracker";

export interface CodexRealtimeClientLike extends LipSyncSource {
  getStatus(): CodexRealtimeStatus;
  start(): Promise<void>;
  stop(): void;
  setMicrophoneMuted(muted: boolean): void;
}

export type CodexRealtimeClientFactory = (
  sessionId: string,
  onStateChange: (state: CodexRealtimeState) => void,
  stateExpressionCallbacks?: StateExpressionSchedulerCallbacks,
  getPreferredThreadId?: () => string | null,
  getVoice?: () => string | Promise<string>,
  getVoiceCandidates?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>,
  onVoiceFallback?: (fallback: CodexRealtimeVoiceFallback) => void,
  getPersonaSnapshot?: () => CodexRealtimePersonaSnapshot | Promise<CodexRealtimePersonaSnapshot>,
  onPersonaApplication?: (application: CodexRealtimePersonaApplication) => void,
  personaPromptMode?: "supplemental" | "replace",
  includeStartupContext?: boolean,
) => CodexRealtimeClientLike;

export interface CodexThreadTrackerLike {
  getCurrentThreadId(): string | null;
  trackQuickChatPrompt(prompt: string): Promise<string | null>;
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
  /** Called for every new session so config edits apply without restarting the app. */
  readonly getVoice?: () => string | Promise<string>;
  /**
   * Voice 候補（persona override → global → default）を session 開始ごとに返す。
   * 指定時は `getVoice` より優先。後続候補は app-server が voice を明確に拒否した
   * ときの fallback にだけ使われる。
   */
  readonly getVoiceCandidates?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  /** Voice fallback の診断通知（dev log 用）。 */
  readonly onVoiceFallback?: (fallback: CodexRealtimeVoiceFallback) => void;
  /** Canonical active persona snapshot, read once when a new GPT Live session starts. */
  readonly getPersonaSnapshot?: () =>
    | CodexRealtimePersonaSnapshot
    | Promise<CodexRealtimePersonaSnapshot>;
  /** Prompt-free diagnostic for the accepted session's persona application status. */
  readonly onPersonaApplication?: (application: CodexRealtimePersonaApplication) => void;
  /** Explicit backend-prompt replacement experiment; defaults to safe supplementation. */
  readonly personaPromptMode?: "supplemental" | "replace";
  readonly includeStartupContext?: boolean;
  readonly onQuickChatResponse?: (response: CodexQuickChatResponse) => void;
  readonly createClient?: CodexRealtimeClientFactory;
  readonly createThreadTracker?: (
    sessionId: string,
    onCurrentThreadChange: (threadId: string | null) => void,
    onQuickChatResponse: (response: CodexQuickChatResponse) => void,
  ) => CodexThreadTrackerLike;
}

interface UseCodexRealtimeResult {
  readonly state: CodexRealtimeState;
  readonly stop: () => void;
  readonly toggle: () => Promise<void>;
  readonly setMicrophoneMuted: (muted: boolean) => void;
  readonly trackQuickChatPrompt: (prompt: string) => Promise<string | null>;
  readonly getLipSyncSource: () => LipSyncSource;
}

const defaultCreateClient: CodexRealtimeClientFactory = (
  sessionId,
  onStateChange,
  stateExpressionCallbacks,
  getPreferredThreadId,
  getVoice,
  getVoiceCandidates,
  onVoiceFallback,
  getPersonaSnapshot,
  onPersonaApplication,
  personaPromptMode,
  includeStartupContext,
) =>
  new CodexRealtimeClient(sessionId, onStateChange, {
    stateExpressionCallbacks,
    getPreferredThreadId,
    getVoice,
    getVoiceCandidates,
    onVoiceFallback,
    getPersonaSnapshot,
    onPersonaApplication,
    personaPromptMode,
    includeStartupContext,
  });

const defaultCreateThreadTracker = (
  sessionId: string,
  onCurrentThreadChange: (threadId: string | null) => void,
  onQuickChatResponse: (response: CodexQuickChatResponse) => void,
): CodexThreadTrackerLike =>
  new CodexThreadTracker(sessionId, onCurrentThreadChange, onQuickChatResponse);

const FALLBACK_RESTORE_RETRY_DELAYS_MS = [50, 200] as const;

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

/** App が所有する realtime client を一つに限定し、古い client の通知を遮断する。 */
export function useCodexRealtime({
  sessionId,
  available,
  fallbackLipSyncSource,
  applyLipSyncSource,
  setFallbackPlaybackEnabled = () => {},
  stateExpressionCallbacks,
  getVoice = () => DEFAULT_CODEX_REALTIME_VOICE,
  getVoiceCandidates,
  onVoiceFallback,
  getPersonaSnapshot,
  onPersonaApplication,
  personaPromptMode = "supplemental",
  includeStartupContext = true,
  onQuickChatResponse = () => {},
  createClient = defaultCreateClient,
  createThreadTracker = defaultCreateThreadTracker,
}: UseCodexRealtimeOptions): UseCodexRealtimeResult {
  const clientRef = useRef<CodexRealtimeClientLike | null>(null);
  const threadTrackerRef = useRef<CodexThreadTrackerLike | null>(null);
  const fallbackRef = useRef(fallbackLipSyncSource);
  const applyLipSyncSourceRef = useRef(applyLipSyncSource);
  const setFallbackPlaybackEnabledRef = useRef(setFallbackPlaybackEnabled);
  const createClientRef = useRef(createClient);
  const getVoiceRef = useRef(getVoice);
  const getVoiceCandidatesRef = useRef(getVoiceCandidates);
  const onVoiceFallbackRef = useRef(onVoiceFallback);
  const getPersonaSnapshotRef = useRef(getPersonaSnapshot);
  const onPersonaApplicationRef = useRef(onPersonaApplication);
  const onQuickChatResponseRef = useRef(onQuickChatResponse);
  const sessionIdRef = useRef(sessionId);
  const voiceIntentRef = useRef(false);
  const fallbackPlaybackTransitionRef = useRef(0);
  const fallbackPlaybackQueueRef = useRef<Promise<void>>(Promise.resolve());
  const [state, setState] = useState<CodexRealtimeState>({ status: "idle" });

  fallbackRef.current = fallbackLipSyncSource;
  applyLipSyncSourceRef.current = applyLipSyncSource;
  setFallbackPlaybackEnabledRef.current = setFallbackPlaybackEnabled;
  createClientRef.current = createClient;
  getVoiceRef.current = getVoice;
  getVoiceCandidatesRef.current = getVoiceCandidates;
  onVoiceFallbackRef.current = onVoiceFallback;
  getPersonaSnapshotRef.current = getPersonaSnapshot;
  onPersonaApplicationRef.current = onPersonaApplication;
  onQuickChatResponseRef.current = onQuickChatResponse;

  const restoreFallback = useCallback(() => {
    applyLipSyncSourceRef.current(fallbackRef.current);
  }, []);

  const enqueueFallbackPlayback = useCallback(
    (enabled: boolean, retryDelays: ReadonlyArray<number> = []): Promise<void> => {
      const transition = ++fallbackPlaybackTransitionRef.current;
      const apply = async (): Promise<void> => {
        // A newer desired state superseded this transition before it reached the Rust owner.
        if (fallbackPlaybackTransitionRef.current !== transition) return;
        let retryIndex = 0;
        while (true) {
          if (fallbackPlaybackTransitionRef.current !== transition) return;
          try {
            await setFallbackPlaybackEnabledRef.current(enabled);
            return;
          } catch (error) {
            if (fallbackPlaybackTransitionRef.current !== transition) return;
            console.error(
              `[codex-realtime] failed to ${enabled ? "restore" : "claim"} fallback playback ownership`,
              error,
            );
            const delay = retryDelays[retryIndex];
            if (delay === undefined) throw error;
            retryIndex += 1;
            await wait(delay);
          }
        }
      };
      const operation = fallbackPlaybackQueueRef.current.catch(() => {}).then(apply);
      // A rejected claim must reach start(), but must not poison later ownership transitions.
      fallbackPlaybackQueueRef.current = operation.catch(() => {});
      return operation;
    },
    [],
  );

  const restoreFallbackPlayback = useCallback(() => {
    void enqueueFallbackPlayback(true, FALLBACK_RESTORE_RETRY_DELAYS_MS).catch(() => {});
  }, [enqueueFallbackPlayback]);

  const claimFallbackPlayback = useCallback(
    (): Promise<void> => enqueueFallbackPlayback(false),
    [enqueueFallbackPlayback],
  );

  const stopClient = useCallback(
    (preserveVoiceIntent: boolean) => {
      if (!preserveVoiceIntent) voiceIntentRef.current = false;
      const client = clientRef.current;
      // stop() 内の同期 idle 通知も stale 扱いにするため、先に所有権を外す。
      clientRef.current = null;
      client?.stop();
      setState({ status: "idle" });
      restoreFallbackPlayback();
      restoreFallback();
    },
    [restoreFallback, restoreFallbackPlayback],
  );

  const stop = useCallback(() => stopClient(false), [stopClient]);

  const start = useCallback(
    async (preserveIntentUntilActive = false) => {
      if (clientRef.current) return;
      voiceIntentRef.current = true;
      let preserveIntentOnFailure = preserveIntentUntilActive;
      let client: CodexRealtimeClientLike;
      client = createClientRef.current(
        sessionId,
        (nextState) => {
          // stop・session切替後や、置き換え済みclientからの通知は全て捨てる。
          if (clientRef.current !== client) return;

          if (nextState.status === "error") {
            if (!preserveIntentOnFailure) voiceIntentRef.current = false;
            clientRef.current = null;
            client.stop();
            setState(nextState);
            restoreFallbackPlayback();
            restoreFallback();
            return;
          }

          if (nextState.status === "idle") {
            // remote closed 後の次クリックを、新規 start として扱えるよう解放する。
            if (!preserveIntentOnFailure) voiceIntentRef.current = false;
            clientRef.current = null;
            setState(nextState);
            restoreFallbackPlayback();
            restoreFallback();
            return;
          }

          setState(nextState);
          if (nextState.status === "active") {
            preserveIntentOnFailure = false;
            applyLipSyncSourceRef.current(client);
          }
        },
        stateExpressionCallbacks,
        () => threadTrackerRef.current?.getCurrentThreadId() ?? null,
        () => getVoiceRef.current(),
        getVoiceCandidatesRef.current
          ? () => getVoiceCandidatesRef.current?.() ?? [DEFAULT_CODEX_REALTIME_VOICE]
          : undefined,
        (fallback) => onVoiceFallbackRef.current?.(fallback),
        getPersonaSnapshotRef.current
          ? () =>
              getPersonaSnapshotRef.current?.() ?? {
                personaId: null,
                instructions: null,
              }
          : undefined,
        (application) => onPersonaApplicationRef.current?.(application),
        personaPromptMode,
        includeStartupContext,
      );
      clientRef.current = client;
      setState({ status: "connecting" });

      try {
        // Claim request provenance before connecting so delayed Live-era voice tools remain suppressed.
        await claimFallbackPlayback();
        if (clientRef.current !== client) return;
        await client.start();
      } catch (error) {
        // client 自身の error 通知、stop、session 切替で所有権を失った後なら無視する。
        if (clientRef.current !== client) return;
        if (!preserveIntentOnFailure) voiceIntentRef.current = false;
        clientRef.current = null;
        client.stop();
        const message = error instanceof Error ? error.message : String(error);
        console.error("[codex-realtime] start failed", error);
        setState({ status: "error", error: message });
        restoreFallbackPlayback();
        restoreFallback();
      }
    },
    [
      claimFallbackPlayback,
      restoreFallback,
      restoreFallbackPlayback,
      sessionId,
      stateExpressionCallbacks,
      personaPromptMode,
      includeStartupContext,
    ],
  );

  const toggle = useCallback(async () => {
    if (clientRef.current) {
      stop();
      return;
    }
    await start();
  }, [start, stop]);

  const setMicrophoneMuted = useCallback((muted: boolean) => {
    clientRef.current?.setMicrophoneMuted(muted);
  }, []);

  useEffect(() => {
    threadTrackerRef.current?.stop();
    threadTrackerRef.current = null;
    if (!available) return;
    let tracker: CodexThreadTrackerLike;
    tracker = createThreadTracker(
      sessionId,
      (threadId) => {
        if (threadTrackerRef.current !== tracker) return;
        if (clientRef.current) stopClient(true);
        if (threadId && voiceIntentRef.current) void start(true);
      },
      (response) => {
        if (threadTrackerRef.current !== tracker) return;
        onQuickChatResponseRef.current(response);
      },
    );
    threadTrackerRef.current = tracker;
    void tracker.start().catch((error) => {
      if (threadTrackerRef.current !== tracker) return;
      console.warn("[codex-realtime] thread tracker unavailable", error);
    });
    return () => {
      if (threadTrackerRef.current === tracker) threadTrackerRef.current = null;
      tracker.stop();
    };
  }, [available, createThreadTracker, sessionId, start, stopClient]);

  useEffect(() => {
    const sessionChanged = sessionIdRef.current !== sessionId;
    sessionIdRef.current = sessionId;
    if (!available || sessionChanged) stopClient(true);
    if (
      available &&
      voiceIntentRef.current &&
      !clientRef.current &&
      threadTrackerRef.current?.getCurrentThreadId()
    ) {
      void start(true);
    }
  }, [available, sessionId, start, stopClient]);

  useEffect(() => {
    // Re-stamp the default owner after a WebView reload because the Rust MCP process can survive it.
    restoreFallbackPlayback();
    return () => {
      const client = clientRef.current;
      voiceIntentRef.current = false;
      clientRef.current = null;
      client?.stop();
      restoreFallbackPlayback();
    };
  }, [restoreFallbackPlayback]);

  const getLipSyncSource = useCallback(
    () => (clientRef.current?.getStatus() === "active" ? clientRef.current : fallbackRef.current),
    [],
  );

  const trackQuickChatPrompt = useCallback(
    (prompt: string): Promise<string | null> =>
      threadTrackerRef.current?.trackQuickChatPrompt(prompt) ?? Promise.resolve(null),
    [],
  );

  return {
    state,
    stop,
    toggle,
    setMicrophoneMuted,
    trackQuickChatPrompt,
    getLipSyncSource,
  };
}
