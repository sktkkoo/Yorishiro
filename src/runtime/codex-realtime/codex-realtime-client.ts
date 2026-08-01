import { Channel } from "@tauri-apps/api/core";
import {
  sessionRealtimeConnect,
  sessionRealtimeDisconnect,
  sessionRealtimeSend,
  type WorkStatusDiagnosticEntry,
  workStatusDiagnosticLog,
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
import {
  type CodexWorkStatusProtocolAdapter,
  getCodexWorkStatusProtocolAdapter,
} from "../work-status-ledger/codex-protocol-adapter";
import type { WorkLifecyclePort } from "../work-status-ledger/types";
import {
  formatWorkStatusEvent,
  formatWorkStatusSnapshot,
  nextWorkStatusFreshnessDelay,
  summarizeWorkStatusFreshness,
  type WorkStatusVoiceContextSource,
} from "../work-status-ledger/voice-context";

export type CodexRealtimeStatus = "idle" | "connecting" | "active" | "error";
export type CodexRealtimeBilling = "subscription" | "api";

export interface CodexRealtimeState {
  readonly status: CodexRealtimeStatus;
  readonly billing?: CodexRealtimeBilling;
  readonly error?: string;
}

export interface CodexRealtimeClientOptions {
  readonly stateExpressionCallbacks?: StateExpressionSchedulerCallbacks;
  readonly stateExpressionController?: RealtimeStateExpressionControllerOptions;
  readonly getPreferredThreadId?: () => string | null;
  readonly workStatusLedger?: WorkLifecyclePort & WorkStatusVoiceContextSource;
  /** 実験用。既定では ledger context を GPT Live へ自動注入しない。 */
  readonly injectWorkStatusContext?: boolean;
  readonly voice?: string;
  readonly getVoice?: () => string | Promise<string>;
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
  readonly id: string | number;
  readonly method: string;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timeoutId: number;
}

const RPC_TIMEOUT_MS = 15_000;
const THREAD_DISCOVERY_TIMEOUT_MS = 8_000;
const WORK_STATUS_RECONCILE_RETRY_MS = 1_000;
const WORK_STATUS_RECONCILE_RETRIES = 2;
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
  private workStatusAdapter: CodexWorkStatusProtocolAdapter | null = null;
  private readonly workStatusLedger: (WorkLifecyclePort & WorkStatusVoiceContextSource) | null;
  private readonly injectWorkStatusContext: boolean;
  private workStatusSubscription: { dispose(): void } | null = null;
  private workStatusFreshnessTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private workStatusReconcileRetryTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  private readonly getVoice: () => string | Promise<string>;

  constructor(
    sessionId: string,
    onStateChange: (state: CodexRealtimeState) => void = () => {},
    options: CodexRealtimeClientOptions = {},
  ) {
    this.sessionId = sessionId;
    this.onStateChange = onStateChange;
    this.getPreferredThreadId = options.getPreferredThreadId ?? (() => null);
    this.workStatusLedger = options.workStatusLedger ?? null;
    this.injectWorkStatusContext = options.injectWorkStatusContext ?? false;
    this.getVoice = options.getVoice ?? (() => options.voice ?? DEFAULT_CODEX_REALTIME_VOICE);
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
      this.workStatusAdapter = this.workStatusLedger
        ? getCodexWorkStatusProtocolAdapter(this.workStatusLedger, this.sessionId, threadId)
        : null;
      await this.startWebRtc(threadId, attempt);
      this.assertAttemptOwner(attempt);
      this.setState({ status: "active", billing });
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

  private async startWebRtc(threadId: string, attempt: number): Promise<void> {
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

    const remoteSdp = new Promise<string>((resolve, reject) => {
      this.acceptRemoteSdp = resolve;
      this.rejectRemoteSdp = reject;
    });
    const voice = await this.getVoice();
    this.assertAttemptOwner(attempt, peer);
    await this.request("thread/realtime/start", {
      threadId,
      outputModality: "audio",
      version: "v3",
      voice,
      transport: { type: "webrtc", sdp },
      ...(this.injectWorkStatusContext && this.workStatusLedger
        ? {
            initialItems: [
              {
                role: "developer",
                text: formatWorkStatusSnapshot(this.workStatusLedger.getSnapshot()),
              },
            ],
          }
        : {}),
    });
    if (this.injectWorkStatusContext) {
      this.writeWorkStatusDiagnostic({
        eventKind: "context-initial-enqueued",
        activeCount: this.workStatusLedger?.getSnapshot().activeCount,
      });
    }
    await this.reconcileWorkStatus(threadId, attempt, peer);
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
    if (this.injectWorkStatusContext) this.startWorkStatusContextUpdates(threadId, attempt);
  }

  private async reconcileWorkStatus(
    threadId: string,
    attempt: number,
    peer: RTCPeerConnection,
    retriesRemaining = WORK_STATUS_RECONCILE_RETRIES,
  ): Promise<void> {
    const adapter = this.workStatusAdapter;
    if (!adapter) return;
    try {
      const result = (await this.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as { readonly thread?: unknown };
      this.assertAttemptOwner(attempt, peer);
      const reconciled = adapter.reconcileRootThread(result.thread);
      let releasedApprovals = reconciled.releasedApprovals;
      for (const approvalThreadId of adapter.pendingApprovalThreadIds()) {
        if (approvalThreadId === threadId) continue;
        const childResult = (await this.request("thread/read", {
          threadId: approvalThreadId,
          includeTurns: true,
        })) as { readonly thread?: unknown };
        this.assertAttemptOwner(attempt, peer);
        releasedApprovals += adapter.reconcileApprovalThread(childResult.thread);
      }
      if (this.workStatusReconcileRetryTimer !== null) {
        globalThis.clearTimeout(this.workStatusReconcileRetryTimer);
        this.workStatusReconcileRetryTimer = null;
      }
      this.writeWorkStatusDiagnostic({
        eventKind: "correlation-resync-delivered",
        activeCount: this.workStatusLedger?.getSnapshot().activeCount,
        correlationCount: reconciled.matchedTurns + releasedApprovals,
      });
    } catch (error) {
      if (!this.isAttemptOwner(attempt)) throw error;
      this.writeWorkStatusDiagnostic({
        eventKind: "correlation-resync-failed",
        activeCount: this.workStatusLedger?.getSnapshot().activeCount,
      });
      console.warn("[codex-realtime] failed to reconcile work status", error);
      if (retriesRemaining > 0 && this.workStatusReconcileRetryTimer === null) {
        this.workStatusReconcileRetryTimer = globalThis.setTimeout(() => {
          this.workStatusReconcileRetryTimer = null;
          if (!this.isAttemptOwner(attempt) || this.peer !== peer || this.threadId !== threadId) {
            return;
          }
          void this.reconcileWorkStatus(threadId, attempt, peer, retriesRemaining - 1).catch(
            (error) => {
              // stop/bridge close が retry と競合した場合は expected cancellation。
              if (this.isAttemptOwner(attempt)) {
                console.warn("[codex-realtime] work status retry failed", error);
              }
            },
          );
        }, WORK_STATUS_RECONCILE_RETRY_MS);
      }
    }
  }

  private startWorkStatusContextUpdates(threadId: string, attempt: number): void {
    this.workStatusSubscription?.dispose();
    const ledger = this.workStatusLedger;
    this.workStatusSubscription =
      ledger?.subscribeEvents((event) => {
        if (!this.isAttemptOwner(attempt) || this.threadId !== threadId) return;
        this.writeWorkStatusDiagnostic({
          eventKind: event.kind,
          workId: event.workId,
          status: event.work.status,
          ...(event.kind === "work-updated" ? { previousStatus: event.previousStatus } : {}),
          activeCount: ledger.getSnapshot().activeCount,
        });
        this.appendWorkStatusContext(threadId, formatWorkStatusEvent(event), attempt, "event");
        this.scheduleWorkStatusFreshnessRefresh(threadId, attempt);
      }) ?? null;
    // initialItems の snapshot 採取後〜SDP確立までの更新を、最新snapshotで再同期する。
    if (ledger) {
      this.appendWorkStatusContext(
        threadId,
        formatWorkStatusSnapshot(ledger.getSnapshot()),
        attempt,
        "resync",
      );
      this.scheduleWorkStatusFreshnessRefresh(threadId, attempt);
    }
  }

  private appendWorkStatusContext(
    threadId: string,
    text: string,
    attempt: number,
    source: "event" | "resync" | "freshness",
  ): void {
    void this.request("thread/realtime/appendText", {
      threadId,
      role: "developer",
      text,
    })
      .then(() => {
        if (!this.isAttemptOwner(attempt)) return;
        this.writeWorkStatusDiagnostic({
          eventKind:
            source === "event"
              ? "context-event-delivered"
              : source === "resync"
                ? "context-resync-delivered"
                : "freshness-refresh-delivered",
          activeCount: this.workStatusLedger?.getSnapshot().activeCount,
          ...(source === "freshness" ? this.currentFreshnessDiagnostic() : {}),
        });
      })
      .catch((error) => {
        // Status context is best-effort; voice and the work itself must keep running.
        if (this.isAttemptOwner(attempt)) {
          this.writeWorkStatusDiagnostic({
            eventKind: "context-delivery-failed",
            activeCount: this.workStatusLedger?.getSnapshot().activeCount,
          });
          console.warn("[codex-realtime] failed to append work status context", error);
        }
      });
  }

  private scheduleWorkStatusFreshnessRefresh(threadId: string, attempt: number): void {
    if (this.workStatusFreshnessTimer !== null) {
      globalThis.clearTimeout(this.workStatusFreshnessTimer);
      this.workStatusFreshnessTimer = null;
    }
    const ledger = this.workStatusLedger;
    if (!ledger || !this.isAttemptOwner(attempt)) return;
    const delay = nextWorkStatusFreshnessDelay(ledger.getSnapshot());
    if (delay === null) return;
    this.workStatusFreshnessTimer = globalThis.setTimeout(() => {
      this.workStatusFreshnessTimer = null;
      if (!this.isAttemptOwner(attempt) || this.threadId !== threadId) return;
      this.appendWorkStatusContext(
        threadId,
        formatWorkStatusSnapshot(ledger.getSnapshot()),
        attempt,
        "freshness",
      );
      this.scheduleWorkStatusFreshnessRefresh(threadId, attempt);
    }, delay);
  }

  private currentFreshnessDiagnostic(): {
    readonly freshness?: "fresh" | "aging" | "stale";
    readonly observedAgeSeconds?: number;
  } {
    const ledger = this.workStatusLedger;
    if (!ledger) return {};
    return summarizeWorkStatusFreshness(ledger.getSnapshot()) ?? {};
  }

  private writeWorkStatusDiagnostic(entry: WorkStatusDiagnosticEntry): void {
    void workStatusDiagnosticLog(entry).catch((error) => {
      console.warn("[codex-realtime] failed to write work status diagnostic log", error);
    });
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
      this.workStatusAdapter?.observeServerRequest(message);
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
    this.workStatusAdapter?.observeNotification(message.method, message.params);
    if (
      message.method === "thread/realtime/itemAdded" &&
      isRecord(params?.item) &&
      params.item.type === "handoff_request"
    ) {
      this.writeWorkStatusDiagnostic({
        eventKind: "handoff-observed",
        activeCount: this.workStatusLedger?.getSnapshot().activeCount,
      });
    }
    if (message.method === "thread/realtime/sdp" && params?.sdp) {
      this.acceptRemoteSdp?.(params.sdp);
    } else if (message.method === "thread/realtime/error") {
      this.writeWorkStatusDiagnostic({
        eventKind: "realtime-error-observed",
        activeCount: this.workStatusLedger?.getSnapshot().activeCount,
      });
      const error = new Error(params?.message ?? "Codex realtime conversation failed");
      this.rejectRemoteSdp?.(error);
      if (!this.stopping) this.setState({ status: "error", error: error.message });
    } else if (message.method === "thread/realtime/closed" && !this.stopping) {
      this.writeWorkStatusDiagnostic({
        eventKind: "realtime-closed-observed",
        activeCount: this.workStatusLedger?.getSnapshot().activeCount,
      });
      this.invalidateAttempt(attempt);
      this.stopping = true;
      this.disposeResources();
      this.threadId = null;
      this.setState({ status: "idle" });
    } else if (message.method === "yorishiro/realtime-bridge/closed" && !this.stopping) {
      this.writeWorkStatusDiagnostic({
        eventKind: "bridge-closed-observed",
        activeCount: this.workStatusLedger?.getSnapshot().activeCount,
      });
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
    this.workStatusSubscription?.dispose();
    this.workStatusSubscription = null;
    if (this.workStatusFreshnessTimer !== null) {
      globalThis.clearTimeout(this.workStatusFreshnessTimer);
      this.workStatusFreshnessTimer = null;
    }
    if (this.workStatusReconcileRetryTimer !== null) {
      globalThis.clearTimeout(this.workStatusReconcileRetryTimer);
      this.workStatusReconcileRetryTimer = null;
    }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJsonRpcServerRequest(message: JsonRpcMessage): message is JsonRpcServerRequest {
  return (
    (typeof message.id === "number" || typeof message.id === "string") &&
    typeof message.method === "string"
  );
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
