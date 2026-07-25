import { Channel } from "@tauri-apps/api/core";
import {
  sessionRealtimeConnect,
  sessionRealtimeDisconnect,
  sessionRealtimeSend,
} from "../../bindings/tauri-commands";
import type { LipSyncSource } from "../../core/body";
import { ensureAudioContextRunning } from "../../core/voice/audio-context";
import { LipSyncAnalyser } from "../../core/voice/lip-sync-analyser";
import type { MouthValues } from "../../core/voice/mouth-values";
import { clearMouthValues, ZERO_MOUTH } from "../../core/voice/mouth-values";

export type CodexRealtimeStatus = "idle" | "connecting" | "active" | "error";
export type CodexRealtimeBilling = "subscription" | "api";

export interface CodexRealtimeState {
  readonly status: CodexRealtimeStatus;
  readonly billing?: CodexRealtimeBilling;
  readonly error?: string;
}

interface JsonRpcResponse {
  readonly id?: number;
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly message?: string };
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timeoutId: number;
}

const RPC_TIMEOUT_MS = 15_000;
const THREAD_DISCOVERY_TIMEOUT_MS = 8_000;
const CODEX_REALTIME_VOICE = "sol";

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
  private threadId: string | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private acceptRemoteSdp: ((sdp: string) => void) | null = null;
  private rejectRemoteSdp: ((reason: Error) => void) | null = null;
  private state: CodexRealtimeState = { status: "idle" };
  private stopping = false;

  constructor(sessionId: string, onStateChange: (state: CodexRealtimeState) => void = () => {}) {
    this.sessionId = sessionId;
    this.onStateChange = onStateChange;
  }

  getStatus(): CodexRealtimeStatus {
    return this.state.status;
  }

  isMouthActive(): boolean {
    return this.state.status === "active" && this.lipSync !== null;
  }

  sampleMouth(out?: MouthValues): MouthValues {
    if (this.isMouthActive() && this.lipSync) return this.lipSync.sample(out);
    return out ? clearMouthValues(out) : { ...ZERO_MOUTH };
  }

  async start(): Promise<void> {
    if (this.state.status === "connecting" || this.state.status === "active") return;
    this.stopping = false;
    this.setState({ status: "connecting" });

    try {
      // Click gesture の直後に resume し、WebKit の autoplay 制限を先に解く。
      await ensureAudioContextRunning();
      await withTimeout(
        this.connectBridge(),
        RPC_TIMEOUT_MS,
        "Codex app-server connection timed out",
      );
      await this.request("initialize", {
        clientInfo: {
          name: "yorishiro",
          title: "Yorishiro",
          version: "0.6.1",
        },
        capabilities: { experimentalApi: true },
      });
      this.notify("initialized", {});

      const account = (await this.request("account/read", { refreshToken: false })) as {
        readonly account?: { readonly type?: string } | null;
      };
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

      this.threadId = await this.waitForLoadedThread();
      await this.startWebRtc(this.threadId);
      this.setState({ status: "active", billing });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.disposeResources();
      this.setState({ status: "error", error: message });
      throw error;
    }
  }

  stop(): void {
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

  private async connectBridge(): Promise<void> {
    const onMessage = new Channel<string>();
    onMessage.onmessage = (message) => this.handleMessage(message);
    const connectionId = await sessionRealtimeConnect({
      sessionId: this.sessionId,
      onMessage,
    });
    if (this.stopping) {
      void sessionRealtimeDisconnect({ connectionId });
      return;
    }
    this.connectionId = connectionId;
  }

  private async waitForLoadedThread(): Promise<string> {
    const deadline = Date.now() + THREAD_DISCOVERY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const result = (await this.request("thread/loaded/list", {})) as {
        readonly data?: ReadonlyArray<string>;
      };
      const threadId = result.data?.[0];
      if (threadId) return threadId;
      await new Promise((resolve) => window.setTimeout(resolve, 100));
    }
    throw new Error("Codex thread was not loaded in time");
  }

  private async startWebRtc(threadId: string): Promise<void> {
    const peer = new RTCPeerConnection();
    this.peer = peer;
    this.remoteStream = new MediaStream();
    peer.addEventListener("track", (event) => {
      const stream = event.streams[0] ?? this.remoteStream;
      if (!stream) return;
      this.remoteStream = stream;
      if (event.streams.length === 0 && !stream.getTracks().includes(event.track)) {
        stream.addTrack(event.track);
      }
      this.connectRemoteAudio(stream);
    });
    peer.addEventListener("connectionstatechange", () => {
      if (!this.stopping && peer.connectionState === "failed") {
        this.setState({ status: "error", error: `Voice connection ${peer.connectionState}` });
      }
    });

    this.microphone = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    for (const track of this.microphone.getAudioTracks()) {
      peer.addTrack(track, this.microphone);
    }
    this.eventChannel = peer.createDataChannel("oai-events");

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await withTimeout(waitForIceGathering(peer), 10_000, "WebRTC ICE gathering timed out");
    const sdp = peer.localDescription?.sdp;
    if (!sdp) throw new Error("WebRTC offer did not contain SDP");

    const remoteSdp = new Promise<string>((resolve, reject) => {
      this.acceptRemoteSdp = resolve;
      this.rejectRemoteSdp = reject;
    });
    await this.request("thread/realtime/start", {
      threadId,
      outputModality: "audio",
      version: "v3",
      voice: CODEX_REALTIME_VOICE,
      transport: { type: "webrtc", sdp },
    });
    const answerSdp = await withTimeout(
      remoteSdp,
      RPC_TIMEOUT_MS,
      "Codex realtime SDP answer timed out",
    );
    this.acceptRemoteSdp = null;
    this.rejectRemoteSdp = null;
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  private connectRemoteAudio(stream: MediaStream): void {
    if (this.remoteSource) return;
    void ensureAudioContextRunning()
      .then((context) => {
        if (this.stopping || this.remoteSource) return;
        const analyser = LipSyncAnalyser.createAnalyserNode(context);
        const source = context.createMediaStreamSource(stream);
        source.connect(analyser);
        analyser.connect(context.destination);
        this.remoteSource = source;
        this.analyserNode = analyser;
        this.lipSync = new LipSyncAnalyser(analyser);
      })
      .catch((error) => {
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

  private handleMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(raw) as JsonRpcResponse;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      window.clearTimeout(pending.timeoutId);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    const params = message.params as
      | { readonly threadId?: string; readonly sdp?: string; readonly message?: string }
      | undefined;
    if (message.method === "thread/realtime/sdp" && params?.sdp) {
      this.acceptRemoteSdp?.(params.sdp);
    } else if (message.method === "thread/realtime/error") {
      const error = new Error(params?.message ?? "Codex realtime conversation failed");
      this.rejectRemoteSdp?.(error);
      if (!this.stopping) this.setState({ status: "error", error: error.message });
    } else if (message.method === "thread/realtime/closed" && !this.stopping) {
      this.stopping = true;
      this.disposeResources();
      this.threadId = null;
      this.setState({ status: "idle" });
    } else if (message.method === "yorishiro/realtime-bridge/closed" && !this.stopping) {
      const error = new Error(params?.message ?? "Codex app-server connection closed");
      this.rejectAllPending(error);
      this.disposeResources();
      this.threadId = null;
      this.setState({ status: "error", error: error.message });
    }
  }

  private rejectAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
    this.rejectRemoteSdp?.(error);
  }

  private disposeResources(finalMessage?: string): void {
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
