import { Channel } from "@tauri-apps/api/core";
import {
  sessionRealtimeCapabilities,
  sessionRealtimeConnect,
  sessionRealtimeDisconnect,
  sessionRealtimeSend,
} from "../../bindings/tauri-commands";
import type { LipSyncSource } from "../../core/body";
import { ensureAudioContextRunning } from "../../core/voice/audio-context";
import { LipSyncAnalyser } from "../../core/voice/lip-sync-analyser";
import type { MouthValues } from "../../core/voice/mouth-values";
import { clearMouthValues, ZERO_MOUTH } from "../../core/voice/mouth-values";
import {
  RealtimeStateExpressionController,
  type RealtimeStateExpressionControllerOptions,
} from "../agent-state-expression/controller";
import type { StateExpressionSchedulerCallbacks } from "../agent-state-expression/scheduler";
import { isCodexVoiceRejectionMessage } from "./voice-rejection";

export type CodexRealtimeStatus = "idle" | "connecting" | "active" | "error";
export type CodexRealtimeBilling = "subscription" | "api";

export interface CodexRealtimeState {
  readonly status: CodexRealtimeStatus;
  readonly billing?: CodexRealtimeBilling;
  readonly error?: string;
}

/** Voice fallback が起きたときの診断情報。UI 側は dev log へ流す。 */
export interface CodexRealtimeVoiceFallback {
  readonly fromVoice: string;
  readonly toVoice: string;
  /** app-server が返した拒否 message。 */
  readonly reason: string;
}

export interface CodexRealtimePersonaSnapshot {
  /** Diagnostics-safe identity. Persona prompt contents must never be logged from this value. */
  readonly personaId: string | null;
  /** Canonical PersonaDefinition.thinking.systemPromptAddition for the active persona. */
  readonly instructions: string | null | undefined;
}

export type CodexRealtimePersonaApplicationStatus =
  | "accepted"
  | "skipped-no-persona"
  | "skipped-empty"
  | "unsupported"
  | "load-failed";

/** Prompt-free diagnostics for one accepted GPT Live session. */
export interface CodexRealtimePersonaApplication {
  readonly personaId: string | null;
  readonly status: CodexRealtimePersonaApplicationStatus;
  /** Host-verified `codex --version` value when available; never contains persona text. */
  readonly appServerVersion: string | null;
  readonly delivery?: "initial-items" | "prompt-replacement";
  readonly startupContextIncluded?: boolean;
}

export interface CodexRealtimeClientOptions {
  readonly stateExpressionCallbacks?: StateExpressionSchedulerCallbacks;
  readonly stateExpressionController?: RealtimeStateExpressionControllerOptions;
  readonly getPreferredThreadId?: () => string | null;
  readonly voice?: string;
  readonly getVoice?: () => string | Promise<string>;
  /**
   * Voice 候補を優先順で返す（persona override → global → built-in default）。
   * 指定時は `voice` / `getVoice` より優先。先頭候補で start し、app-server が
   * voice を明確に拒否した場合に限り後続候補で再試行する。
   */
  readonly getVoiceCandidates?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
  /** Voice fallback が起きるたびに呼ばれる（再試行の直前）。 */
  readonly onVoiceFallback?: (fallback: CodexRealtimeVoiceFallback) => void;
  /** Read once per start. Text seeds only the ephemeral Realtime session, not Codex thread history. */
  readonly getPersonaSnapshot?: () =>
    | CodexRealtimePersonaSnapshot
    | Promise<CodexRealtimePersonaSnapshot>;
  /** Called only with prompt-free persona application diagnostics. */
  readonly onPersonaApplication?: (application: CodexRealtimePersonaApplication) => void;
  /** Explicit comparison experiment. `replace` removes the configured Realtime backend prompt. */
  readonly personaPromptMode?: "supplemental" | "replace";
  /**
   * Experimental comparison. False omits Codex startup context only when a supplemental
   * developer initial item can actually be included. Fallback sessions retain startup context.
   */
  readonly includeStartupContext?: boolean;
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface JsonRpcResponse extends JsonRpcMessage {
  readonly id: number;
}

interface JsonRpcServerRequest extends JsonRpcMessage {
  readonly id: number;
  readonly method: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timeoutId: number;
}

const RPC_TIMEOUT_MS = 15_000;
const THREAD_DISCOVERY_TIMEOUT_MS = 8_000;
export const DEFAULT_CODEX_REALTIME_VOICE = "sol";
const REMOTE_SPEECH_SAMPLE_INTERVAL_MS = 33;

class StartAttemptCancelledError extends Error {
  constructor() {
    super("Codex realtime start attempt is no longer active");
  }
}

/**
 * Codex app-server の experimental realtime API と WebRTC を結ぶ。
 *
 * TUI と同じ app-server に接続するため、音声から始まった turn も通常の
 * Codex thread / approval / tool flow に合流する。PTY へ文字は書き込まない。
 */
export class CodexRealtimeClient implements LipSyncSource {
  private readonly sessionId: string;
  private readonly onStateChange: (state: CodexRealtimeState) => void;
  private connectionId: string | null = null;
  private peer: RTCPeerConnection | null = null;
  private eventChannel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private remoteSource: MediaStreamAudioSourceNode | null = null;
  private analyserNode: AnalyserNode | null = null;
  private lipSync: LipSyncAnalyser | null = null;
  private remoteSpeechSampleInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private threadId: string | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private acceptRemoteSdp: ((sdp: string) => void) | null = null;
  private rejectRemoteSdp: ((reason: Error) => void) | null = null;
  private state: CodexRealtimeState = { status: "idle" };
  private stopping = false;
  private startAttemptEpoch = 0;
  private readonly stateExpressionController: RealtimeStateExpressionController | null;
  private readonly getPreferredThreadId: () => string | null;
  private readonly getVoiceCandidates: () => Promise<ReadonlyArray<string>>;
  private readonly onVoiceFallback: ((fallback: CodexRealtimeVoiceFallback) => void) | null;
  private readonly getPersonaSnapshot:
    | (() => CodexRealtimePersonaSnapshot | Promise<CodexRealtimePersonaSnapshot>)
    | null;
  private readonly onPersonaApplication:
    | ((application: CodexRealtimePersonaApplication) => void)
    | null;
  private readonly personaPromptMode: "supplemental" | "replace";
  private readonly includeStartupContext: boolean;

  constructor(
    sessionId: string,
    onStateChange: (state: CodexRealtimeState) => void = () => {},
    options: CodexRealtimeClientOptions = {},
  ) {
    this.sessionId = sessionId;
    this.onStateChange = onStateChange;
    this.getPreferredThreadId = options.getPreferredThreadId ?? (() => null);
    const legacyGetVoice =
      options.getVoice ?? (() => options.voice ?? DEFAULT_CODEX_REALTIME_VOICE);
    const getCandidates = options.getVoiceCandidates ?? (async () => [await legacyGetVoice()]);
    this.getVoiceCandidates = async () => normalizeVoiceCandidates(await getCandidates());
    this.onVoiceFallback = options.onVoiceFallback ?? null;
    this.getPersonaSnapshot = options.getPersonaSnapshot ?? null;
    this.onPersonaApplication = options.onPersonaApplication ?? null;
    this.personaPromptMode = options.personaPromptMode ?? "supplemental";
    this.includeStartupContext = options.includeStartupContext ?? true;
    this.stateExpressionController = options.stateExpressionCallbacks
      ? new RealtimeStateExpressionController(
          options.stateExpressionCallbacks,
          options.stateExpressionController,
        )
      : null;
  }

  getStatus(): CodexRealtimeStatus {
    return this.state.status;
  }

  isMouthActive(): boolean {
    return this.state.status === "active" && this.lipSync !== null;
  }

  sampleMouth(out?: MouthValues): MouthValues {
    if (this.isMouthActive() && this.lipSync) {
      return this.lipSync.sample(out);
    }
    return out ? clearMouthValues(out) : { ...ZERO_MOUTH };
  }

  async start(): Promise<void> {
    if (this.state.status === "connecting" || this.state.status === "active") return;
    const attempt = ++this.startAttemptEpoch;
    this.stopping = false;
    this.setState({ status: "connecting" });

    try {
      // Click gesture の直後に resume し、WebKit の autoplay 制限を先に解く。
      await ensureAudioContextRunning();
      this.assertAttemptOwner(attempt);
      await withTimeout(
        this.connectBridge(attempt),
        RPC_TIMEOUT_MS,
        "Codex app-server connection timed out",
      );
      this.assertAttemptOwner(attempt);
      const realtimeCapabilities = await sessionRealtimeCapabilities({
        sessionId: this.sessionId,
      });
      this.assertAttemptOwner(attempt);
      await this.request("initialize", {
        clientInfo: {
          name: "yorishiro",
          title: "Yorishiro",
          version: "0.6.1",
        },
        capabilities: { experimentalApi: true },
      });
      this.assertAttemptOwner(attempt);
      this.notify("initialized", {});

      const personaApplication = await this.preparePersonaApplication(realtimeCapabilities);
      this.assertAttemptOwner(attempt);

      const account = (await this.request("account/read", { refreshToken: false })) as {
        readonly account?: { readonly type?: string } | null;
      };
      this.assertAttemptOwner(attempt);
      const billing =
        account.account?.type === "chatgpt"
          ? "subscription"
          : account.account?.type === "apiKey"
            ? "api"
            : null;
      if (!billing) {
        throw new Error("Voice requires Codex to be signed in with ChatGPT or an API key.");
      }
      if (billing === "api") {
        // API 認証時はマイク取得と realtime 開始より先に UI へ課金モードを通知する。
        this.setState({ status: "connecting", billing });
      }

      const threadId = await this.waitForLoadedThread(attempt);
      this.assertAttemptOwner(attempt);
      this.threadId = threadId;
      await this.startWebRtc(
        threadId,
        attempt,
        personaApplication.initialItems,
        personaApplication.prompt,
        personaApplication.startupContextIncluded,
      );
      this.assertAttemptOwner(attempt);
      this.setState({ status: "active", billing });
      this.onPersonaApplication?.(personaApplication.diagnostic);
    } catch (error) {
      if (!this.isAttemptOwner(attempt)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.invalidateAttempt(attempt);
      this.stopping = true;
      this.disposeResources();
      this.setState({ status: "error", error: message });
      throw error;
    }
  }

  stop(): void {
    this.invalidateAttempt();
    this.stopping = true;
    const finalMessage =
      this.connectionId && this.threadId
        ? JSON.stringify({
            method: "thread/realtime/stop",
            id: this.nextRequestId++,
            params: { threadId: this.threadId },
          })
        : undefined;
    this.disposeResources(finalMessage);
    this.threadId = null;
    this.setState({ status: "idle" });
  }

  private async connectBridge(attempt: number): Promise<void> {
    const onMessage = new Channel<string>();
    onMessage.onmessage = (message) => this.handleMessage(message, attempt);
    const connectionId = await sessionRealtimeConnect({
      sessionId: this.sessionId,
      onMessage,
    });
    if (!this.isAttemptOwner(attempt)) {
      void sessionRealtimeDisconnect({ connectionId }).catch(() => {});
      return;
    }
    this.connectionId = connectionId;
  }

  private async waitForLoadedThread(attempt: number): Promise<string> {
    const deadline = Date.now() + THREAD_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = (await this.request("thread/loaded/list", {})) as {
        readonly data?: ReadonlyArray<string>;
      };
      this.assertAttemptOwner(attempt);
      const threads = result.data ?? [];
      if (threads.length > 0) {
        const primaryThreadId = await this.findPrimaryThread(threads, attempt);
        if (primaryThreadId) return primaryThreadId;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      this.assertAttemptOwner(attempt);
    }
    throw new Error("Codex thread was not loaded in time");
  }

  private async findPrimaryThread(
    threadIds: ReadonlyArray<string>,
    attempt: number,
  ): Promise<string | null> {
    const primaryThreadIds: string[] = [];
    for (const threadId of threadIds) {
      if (typeof threadId !== "string" || threadId.length === 0) {
        throw new Error("Codex returned an invalid loaded thread.");
      }
      let result: unknown;
      try {
        result = await this.request("thread/read", {
          threadId,
          includeTurns: false,
        });
      } catch (error) {
        this.assertAttemptOwner(attempt);
        // loaded/list の直後に subagent が終了する競合は次の poll で再評価する。
        if (error instanceof StartAttemptCancelledError) throw error;
        return null;
      }
      this.assertAttemptOwner(attempt);
      const thread = (result as { readonly thread?: unknown }).thread;
      if (typeof thread !== "object" || thread === null) {
        throw new Error("Codex returned an invalid loaded thread.");
      }
      const loaded = thread as { readonly id?: unknown; readonly parentThreadId?: unknown };
      if (loaded.id !== threadId || !("parentThreadId" in loaded)) {
        throw new Error("Codex returned an invalid loaded thread.");
      }
      // parentThreadId は subagent にだけ設定される。agent team の子 thread を除外し、
      // TUI が所有する唯一の top-level thread へ接続する。
      if (loaded.parentThreadId === null) {
        primaryThreadIds.push(threadId);
      } else if (typeof loaded.parentThreadId !== "string" || loaded.parentThreadId.length === 0) {
        throw new Error("Codex returned an invalid loaded thread.");
      }
    }

    const uniquePrimaryThreadIds = [...new Set(primaryThreadIds)];
    const preferredThreadId = this.getPreferredThreadId();
    const candidate =
      preferredThreadId && uniquePrimaryThreadIds.includes(preferredThreadId)
        ? preferredThreadId
        : uniquePrimaryThreadIds[0];
    if (uniquePrimaryThreadIds.length > 1 && candidate !== preferredThreadId) {
      throw new Error(
        "Multiple top-level Codex threads are loaded; voice connection was not started.",
      );
    }
    if (!candidate) return null;

    let revalidated: unknown;
    try {
      revalidated = await this.request("thread/loaded/list", {});
    } catch (error) {
      this.assertAttemptOwner(attempt);
      if (error instanceof StartAttemptCancelledError) throw error;
      return null;
    }
    this.assertAttemptOwner(attempt);
    const revalidatedIds = (revalidated as { readonly data?: unknown }).data;
    if (!Array.isArray(revalidatedIds)) return null;
    const normalizedBefore = normalizeThreadIdSet(threadIds);
    const normalizedAfter = normalizeThreadIdSet(revalidatedIds);
    if (
      !normalizedBefore ||
      !normalizedAfter ||
      normalizedBefore.length !== normalizedAfter.length ||
      normalizedBefore.some((threadId, index) => threadId !== normalizedAfter[index])
    ) {
      // read中に別threadがload/unloadされたsnapshotは採用しない。
      return null;
    }
    return candidate;
  }

  private async preparePersonaApplication(capabilities: {
    readonly appServerVersion: string | null;
    readonly personaInitialItems: boolean;
  }): Promise<{
    readonly initialItems?: ReadonlyArray<{ readonly role: "developer"; readonly text: string }>;
    readonly prompt?: string;
    readonly startupContextIncluded: boolean;
    readonly diagnostic: CodexRealtimePersonaApplication;
  }> {
    let snapshot: CodexRealtimePersonaSnapshot;
    try {
      snapshot = this.getPersonaSnapshot
        ? await this.getPersonaSnapshot()
        : { personaId: null, instructions: null };
    } catch {
      return {
        startupContextIncluded: true,
        diagnostic: {
          personaId: null,
          status: "load-failed",
          appServerVersion: capabilities.appServerVersion,
        },
      };
    }

    const personaId = normalizePersonaId(snapshot.personaId);
    if (!personaId) {
      return {
        startupContextIncluded: true,
        diagnostic: {
          personaId: null,
          status: "skipped-no-persona",
          appServerVersion: capabilities.appServerVersion,
        },
      };
    }
    const instructions = snapshot.instructions?.trim() ?? "";
    if (!instructions) {
      return {
        startupContextIncluded: true,
        diagnostic: {
          personaId,
          status: "skipped-empty",
          appServerVersion: capabilities.appServerVersion,
        },
      };
    }
    if (!capabilities.personaInitialItems) {
      return {
        startupContextIncluded: true,
        diagnostic: {
          personaId,
          status: "unsupported",
          appServerVersion: capabilities.appServerVersion,
        },
      };
    }
    if (this.personaPromptMode === "replace") {
      return {
        prompt: instructions,
        // Prompt replacement does not use the supplemental developer-item experiment.
        startupContextIncluded: true,
        diagnostic: {
          personaId,
          status: "accepted",
          appServerVersion: capabilities.appServerVersion,
          delivery: "prompt-replacement",
          startupContextIncluded: true,
        },
      };
    }
    return {
      // A developer initial item supplements the backend prompt. Do not use the realtime `prompt`
      // field here: setting it would replace Codex's configured realtime backend instructions.
      initialItems: [{ role: "developer", text: instructions }],
      startupContextIncluded: this.includeStartupContext,
      diagnostic: {
        personaId,
        status: "accepted",
        appServerVersion: capabilities.appServerVersion,
        delivery: "initial-items",
        startupContextIncluded: this.includeStartupContext,
      },
    };
  }

  private async startWebRtc(
    threadId: string,
    attempt: number,
    initialItems?: ReadonlyArray<{ readonly role: "developer"; readonly text: string }>,
    prompt?: string,
    startupContextIncluded = true,
  ): Promise<void> {
    this.assertAttemptOwner(attempt);
    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.remoteStream = new MediaStream();
    peer.addEventListener("track", (event) => {
      if (!this.isAttemptOwner(attempt)) return;
      const stream = event.streams[0] ?? this.remoteStream;
      if (!stream) return;
      this.remoteStream = stream;
      if (event.streams.length === 0 && !stream.getTracks().includes(event.track)) {
        stream.addTrack(event.track);
      }
      this.connectRemoteAudio(stream, attempt);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (this.isAttemptOwner(attempt) && peer.connectionState === "failed") {
        this.setState({ status: "error", error: `Voice connection ${peer.connectionState}` });
      }
    });

    const microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    if (!this.isAttemptOwner(attempt) || this.peer !== peer) {
      for (const track of microphone.getTracks()) track.stop();
      throw new StartAttemptCancelledError();
    }
    this.microphone = microphone;
    for (const track of microphone.getAudioTracks()) {
      peer.addTrack(track, microphone);
    }
    this.eventChannel = peer.createDataChannel("oai-events");

    const offer = await peer.createOffer();
    this.assertAttemptOwner(attempt, peer);
    await peer.setLocalDescription(offer);
    this.assertAttemptOwner(attempt, peer);
    await withTimeout(waitForIceGathering(peer), 10_000, "WebRTC ICE gathering timed out");
    this.assertAttemptOwner(attempt, peer);
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("WebRTC offer did not contain SDP");

    const candidates = await this.getVoiceCandidates();
    this.assertAttemptOwner(attempt, peer);

    // Voice は audio 開始後に変更できないため、start の成否がこの session の voice を
    // 確定させる。app-server が voice を明確に拒否した場合に限り、次の候補
    // （persona override → global → built-in default）で再試行する。認証・接続などの
    // 一般エラーはそのまま投げ、voice fallback で隠さない。
    let remoteSdp: Promise<string> | null = null;
    for (let index = 0; index < candidates.length && remoteSdp === null; index++) {
      const voice = candidates[index];
      this.assertAttemptOwner(attempt, peer);
      const attemptRemoteSdp = new Promise<string>((resolve, reject) => {
        this.acceptRemoteSdp = resolve;
        this.rejectRemoteSdp = reject;
      });
      // start が失敗した attempt の promise は誰も await しない。後始末の
      // rejectAllPending が reject しても unhandled rejection にしない。
      void attemptRemoteSdp.catch(() => {});
      try {
        await this.request("thread/realtime/start", {
          threadId,
          outputModality: "audio",
          version: "v3",
          voice,
          includeStartupContext: startupContextIncluded,
          ...(initialItems ? { initialItems } : {}),
          ...(prompt ? { prompt } : {}),
          transport: { type: "webrtc", sdp },
        });
        remoteSdp = attemptRemoteSdp;
      } catch (error) {
        if (error instanceof StartAttemptCancelledError) throw error;
        this.assertAttemptOwner(attempt, peer);
        const nextVoice = candidates[index + 1];
        const reason = error instanceof Error ? error.message : String(error);
        if (nextVoice === undefined || !isCodexVoiceRejectionMessage(reason)) throw error;
        this.onVoiceFallback?.({ fromVoice: voice, toVoice: nextVoice, reason });
      }
    }
    if (remoteSdp === null) throw new Error("Codex realtime start did not accept any voice");
    this.assertAttemptOwner(attempt, peer);
    const answerSdp = await withTimeout(
      remoteSdp,
      RPC_TIMEOUT_MS,
      "Codex realtime SDP answer timed out",
    );
    this.assertAttemptOwner(attempt, peer);
    this.acceptRemoteSdp = null;
    this.rejectRemoteSdp = null;
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
    this.assertAttemptOwner(attempt, peer);
  }

  private connectRemoteAudio(stream: MediaStream, attempt: number): void {
    if (this.remoteSource) return;
    void ensureAudioContextRunning()
      .then((context) => {
        if (!this.isAttemptOwner(attempt) || this.remoteSource) return;
        const analyser = LipSyncAnalyser.createAnalyserNode(context);
        const source = context.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.connect(context.destination);
        this.remoteSource = source;
        this.analyserNode = analyser;
        this.lipSync = new LipSyncAnalyser(analyser);
        this.startRemoteSpeechObservation(attempt);
      })
      .catch((error) => {
        if (!this.isAttemptOwner(attempt)) return;
        const message = error instanceof Error ? error.message : String(error);
        this.setState({ status: "error", error: message });
      });
  }

  private request(method: string, params: object): Promise<unknown> {
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const connectionId = this.connectionId;
      if (!connectionId) {
        reject(new Error("Codex app-server is not connected"));
        return;
      }
      const timeoutId = window.setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeoutId });
      void sessionRealtimeSend({
        connectionId,
        message: JSON.stringify({ method, id, params }),
      }).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private notify(method: string, params: object): void {
    const connectionId = this.connectionId;
    if (!connectionId) return;
    void sessionRealtimeSend({
      connectionId,
      message: JSON.stringify({ method, params }),
    }).catch(() => {});
  }

  private handleMessage(raw: unknown, attempt: number): void {
    if (!this.isAttemptOwner(attempt)) return;
    if (typeof raw !== "string") return;
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== "object" || parsed === null) return;
      message = parsed as JsonRpcMessage;
    } catch {
      return;
    }

    if (isJsonRpcServerRequest(message)) {
      // bridge は approval request に自動応答しない。承認 UI は TUI だけを正本とする。
      return;
    }

    if (isJsonRpcResponse(message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      window.clearTimeout(pending.timeoutId);
      this.pending.delete(message.id);
      if (hasOwn(message, "error")) {
        pending.reject(new Error(jsonRpcErrorMessage(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const params = message.params as
      | {
          readonly threadId?: string;
          readonly sdp?: string;
          readonly message?: string;
          readonly role?: string;
          readonly delta?: string;
          readonly item?: unknown;
          readonly audio?: { readonly itemId?: unknown };
        }
      | undefined;
    if (message.method === "thread/realtime/sdp" && params?.sdp) {
      this.acceptRemoteSdp?.(params.sdp);
    } else if (message.method === "thread/realtime/error") {
      const error = new Error(params?.message ?? "Codex realtime conversation failed");
      this.rejectRemoteSdp?.(error);
      if (!this.stopping) this.setState({ status: "error", error: error.message });
    } else if (message.method === "thread/realtime/closed" && !this.stopping) {
      this.invalidateAttempt(attempt);
      this.stopping = true;
      this.disposeResources();
      this.threadId = null;
      this.setState({ status: "idle" });
    } else if (message.method === "yorishiro/realtime-bridge/closed" && !this.stopping) {
      const error = new Error(params?.message ?? "Codex app-server connection closed");
      this.invalidateAttempt(attempt);
      this.stopping = true;
      this.rejectAllPending(error);
      this.disposeResources();
      this.threadId = null;
      this.setState({ status: "error", error: error.message });
    } else if (
      message.method === "thread/realtime/itemAdded" &&
      params?.threadId === this.threadId
    ) {
      this.routeRealtimeItemBoundary(params.item);
    } else if (
      message.method === "thread/realtime/outputAudio/delta" &&
      params?.threadId === this.threadId
    ) {
      this.stateExpressionController?.onOutputAudioItem(params.audio?.itemId);
    } else if (
      message.method === "thread/realtime/transcript/delta" &&
      params?.threadId === this.threadId
    ) {
      this.stateExpressionController?.onTranscriptDelta(params.role, params.delta);
    } else if (
      message.method === "thread/realtime/transcript/done" &&
      params?.threadId === this.threadId
    ) {
      // done.text は全 delta の完成版なのでresolverへ再投入しない。
      this.stateExpressionController?.onTranscriptDone(params.role);
    }
  }

  private routeRealtimeItemBoundary(value: unknown): void {
    if (!isRecord(value)) return;
    if (value.type === "input_audio_buffer.speech_started") {
      this.stateExpressionController?.onUserSpeechStarted(value.item_id);
      return;
    }
    if (value.role !== "assistant") return;
    this.stateExpressionController?.onAssistantResponseBoundary(value.id);
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectRemoteSdp?.(error);
  }

  private startRemoteSpeechObservation(attempt: number): void {
    this.stopRemoteSpeechObservation();
    const sample = () => {
      if (!this.isAttemptOwner(attempt) || !this.lipSync) return;
      this.stateExpressionController?.observeRemoteSpeech(this.lipSync.hasSignal());
    };
    sample();
    this.remoteSpeechSampleInterval = globalThis.setInterval(
      sample,
      REMOTE_SPEECH_SAMPLE_INTERVAL_MS,
    );
  }

  private stopRemoteSpeechObservation(): void {
    if (this.remoteSpeechSampleInterval !== null) {
      globalThis.clearInterval(this.remoteSpeechSampleInterval);
      this.remoteSpeechSampleInterval = null;
    }
  }

  private disposeResources(finalMessage?: string): void {
    this.stateExpressionController?.cancelAll();
    this.stopRemoteSpeechObservation();
    this.rejectAllPending(new Error("Codex realtime conversation stopped"));
    this.acceptRemoteSdp = null;
    this.rejectRemoteSdp = null;
    for (const track of this.microphone?.getTracks() ?? []) track.stop();
    this.microphone = null;
    for (const track of this.remoteStream?.getTracks() ?? []) track.stop();
    this.remoteStream = null;
    this.eventChannel?.close();
    this.eventChannel = null;
    this.peer?.close();
    this.peer = null;
    this.remoteSource?.disconnect();
    this.remoteSource = null;
    this.analyserNode?.disconnect();
    this.analyserNode = null;
    this.lipSync?.reset();
    this.lipSync = null;
    const connectionId = this.connectionId;
    this.connectionId = null;
    if (connectionId) {
      void sessionRealtimeDisconnect({ connectionId, finalMessage }).catch(() => {});
    }
  }

  private setState(state: CodexRealtimeState): void {
    this.state = state;
    this.onStateChange(state);
  }

  private isAttemptOwner(attempt: number): boolean {
    return !this.stopping && this.startAttemptEpoch === attempt;
  }

  private assertAttemptOwner(attempt: number, peer?: RTCPeerConnection): void {
    if (!this.isAttemptOwner(attempt) || (peer !== undefined && this.peer !== peer)) {
      throw new StartAttemptCancelledError();
    }
  }

  private invalidateAttempt(attempt?: number): void {
    if (attempt === undefined || this.startAttemptEpoch === attempt) this.startAttemptEpoch++;
  }
}

function hasOwn(value: object, key: string): boolean {
  return Object.getOwnPropertyDescriptor(value, key) !== undefined;
}

function normalizePersonaId(value: string | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** trim・空文字除去・dedupe した voice 候補列。空になったら built-in default に落とす。 */
function normalizeVoiceCandidates(values: ReadonlyArray<string>): ReadonlyArray<string> {
  const candidates: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") continue;
    const voice = value.trim();
    if (voice === "" || candidates.includes(voice)) continue;
    candidates.push(voice);
  }
  return candidates.length > 0 ? candidates : [DEFAULT_CODEX_REALTIME_VOICE];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcServerRequest(message: JsonRpcMessage): message is JsonRpcServerRequest {
  return typeof message.id === "number" && typeof message.method === "string";
}

function isJsonRpcResponse(message: JsonRpcMessage): message is JsonRpcResponse {
  return typeof message.id === "number" && (hasOwn(message, "result") || hasOwn(message, "error"));
}

function jsonRpcErrorMessage(error: unknown): string {
  if (typeof error !== "object" || error === null || !("message" in error)) {
    return "Codex app-server request failed";
  }
  const message = (error as { readonly message?: unknown }).message;
  return typeof message === "string" ? message : "Codex app-server request failed";
}

function normalizeThreadIdSet(values: ReadonlyArray<unknown>): string[] | null {
  if (values.some((value) => typeof value !== "string" || value.length === 0)) return null;
  return [...new Set(values as ReadonlyArray<string>)].sort();
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const onChange = () => {
      if (peer.iceGatheringState !== "complete") return;
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId = 0;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    window.clearTimeout(timeoutId);
  }
}
