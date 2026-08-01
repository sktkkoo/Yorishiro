import { Channel } from "@tauri-apps/api/core";
import {
  sessionRealtimeConnect,
  sessionRealtimeDisconnect,
  sessionRealtimeSelectedThread,
  sessionRealtimeSend,
} from "../../bindings/tauri-commands";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timeoutId: number;
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

const RPC_TIMEOUT_MS = 15_000;
const RECONNECT_DELAY_MS = 250;
const TUI_SELECTION_POLL_MS = 100;

class TrackerRequestTimeoutError extends Error {}

/**
 * TUI の thread/started broadcast を voice が停止中も監視する。
 *
 * thread/loaded/list は unsubscribe 済み thread も grace period 中は返すため、
 * /clear や /resume 後の current TUI thread を一覧だけから特定することはできない。
 */
export class CodexThreadTracker {
  private readonly sessionId: string;
  private readonly onCurrentThreadChange: (threadId: string | null) => void;
  private connectionId: string | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private currentThreadId: string | null = null;
  private knownLoadedThreadIds = new Set<string>();
  private epoch = 0;
  private topLevelStartedGeneration = 0;
  private threadSelectionGeneration = 0;
  private validatingThreadId: string | null = null;
  private running = false;
  private connecting = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private selectionPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    sessionId: string,
    onCurrentThreadChange: (threadId: string | null) => void = () => {},
  ) {
    this.sessionId = sessionId;
    this.onCurrentThreadChange = onCurrentThreadChange;
  }

  getCurrentThreadId(): string | null {
    return this.currentThreadId;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const epoch = ++this.epoch;
    try {
      await this.connect(epoch);
      this.startSelectionPolling(epoch);
    } catch (error) {
      if (epoch === this.epoch && this.running) this.scheduleReconnect(epoch);
      throw error;
    }
  }

  stop(): void {
    this.epoch += 1;
    this.running = false;
    this.connecting = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.selectionPollTimer !== null) {
      clearInterval(this.selectionPollTimer);
      this.selectionPollTimer = null;
    }
    const connectionId = this.connectionId;
    this.connectionId = null;
    this.setCurrentThreadId(null);
    this.knownLoadedThreadIds.clear();
    this.rejectPending(new Error("Codex thread tracker stopped"));
    if (connectionId) void sessionRealtimeDisconnect({ connectionId }).catch(() => {});
  }

  private async connect(epoch: number): Promise<void> {
    if (!this.running || this.connecting || this.connectionId) return;
    this.connecting = true;
    try {
      const onMessage = new Channel<string>();
      onMessage.onmessage = (message) => this.handleMessage(message, epoch);
      const connectionId = await sessionRealtimeConnect({ sessionId: this.sessionId, onMessage });
      if (epoch !== this.epoch || !this.running) {
        void sessionRealtimeDisconnect({ connectionId }).catch(() => {});
        return;
      }
      this.connectionId = connectionId;

      await this.request("initialize", {
        clientInfo: {
          name: "yorishiro-thread-tracker",
          title: "Yorishiro Thread Tracker",
          version: "0.6.1",
        },
        capabilities: { experimentalApi: true },
      });
      if (epoch !== this.epoch || !this.running) return;
      this.notify("initialized", {});
      await this.discoverInitialThread(epoch);
    } catch (error) {
      const connectionId = this.connectionId;
      this.connectionId = null;
      this.rejectPending(error instanceof Error ? error : new Error(String(error)));
      if (connectionId) void sessionRealtimeDisconnect({ connectionId }).catch(() => {});
      throw error;
    } finally {
      this.connecting = false;
    }
  }

  private scheduleReconnect(epoch: number): void {
    if (!this.running || epoch !== this.epoch || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect(epoch).catch(() => this.scheduleReconnect(epoch));
    }, RECONNECT_DELAY_MS);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private async discoverInitialThread(epoch: number): Promise<void> {
    const generation = this.topLevelStartedGeneration;
    const result = (await this.request("thread/loaded/list", {})) as {
      readonly data?: ReadonlyArray<unknown>;
    };
    if (epoch !== this.epoch || generation !== this.topLevelStartedGeneration) return;
    const ids = result.data;
    if (!Array.isArray(ids)) return;
    this.knownLoadedThreadIds = new Set(
      ids.filter((id): id is string => typeof id === "string" && id.length > 0),
    );

    const topLevelIds: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) return;
      let read: unknown;
      try {
        read = await this.request("thread/read", { threadId: id, includeTurns: false });
      } catch (error) {
        if (error instanceof TrackerRequestTimeoutError) throw error;
        return;
      }
      if (epoch !== this.epoch || generation !== this.topLevelStartedGeneration) return;
      const thread = (read as { readonly thread?: unknown }).thread;
      if (!isRecord(thread) || thread.id !== id || !("parentThreadId" in thread)) return;
      if (thread.parentThreadId === null) topLevelIds.push(id);
    }

    // Startup 時に一意なら初期値にできる。複数時は過去の broadcast がないため推測しない。
    const unique = [...new Set(topLevelIds)];
    if (unique.length === 1 && generation === this.topLevelStartedGeneration) {
      this.setCurrentThreadId(unique[0] ?? null);
    }
  }

  private setCurrentThreadId(threadId: string | null): void {
    if (this.currentThreadId === threadId) return;
    this.currentThreadId = threadId;
    this.onCurrentThreadChange(threadId);
  }

  private startSelectionPolling(epoch: number): void {
    if (this.selectionPollTimer !== null) return;
    const poll = (): void => {
      void sessionRealtimeSelectedThread({ sessionId: this.sessionId })
        .then((threadId) => {
          if (epoch !== this.epoch || !this.running || !threadId) return;
          this.considerStatusThread(threadId, epoch);
        })
        .catch(() => {});
    };
    poll();
    this.selectionPollTimer = setInterval(poll, TUI_SELECTION_POLL_MS);
  }

  /**
   * TUI proxy selection and lifecycle notifications are both untrusted candidates until
   * `thread/read` confirms they are loaded top-level threads.
   */
  private considerStatusThread(threadId: string, epoch: number): void {
    if (threadId === this.currentThreadId || threadId === this.validatingThreadId) return;
    this.validatingThreadId = threadId;
    const generation = ++this.threadSelectionGeneration;
    void this.request("thread/read", { threadId, includeTurns: false })
      .then((read) => {
        if (
          epoch !== this.epoch ||
          !this.running ||
          generation !== this.threadSelectionGeneration
        ) {
          return;
        }
        const thread = (read as { readonly thread?: unknown }).thread;
        if (
          isRecord(thread) &&
          thread.id === threadId &&
          "parentThreadId" in thread &&
          thread.parentThreadId === null
        ) {
          this.setCurrentThreadId(threadId);
        }
      })
      .catch((error) => {
        if (error instanceof TrackerRequestTimeoutError) {
          console.warn("[codex-realtime] timed out validating resumed thread", error);
        }
      })
      .finally(() => {
        if (this.validatingThreadId === threadId) this.validatingThreadId = null;
      });
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connectionId = this.connectionId;
    if (!connectionId) return Promise.reject(new Error("Codex thread tracker is not connected"));
    const id = this.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new TrackerRequestTimeoutError(`Codex thread tracker request timed out: ${method}`));
      }, RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeoutId });
    });
    void sessionRealtimeSend({
      connectionId,
      message: JSON.stringify({ method, id, params }),
    }).catch((error) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timeoutId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    });
    return promise;
  }

  private notify(method: string, params: Record<string, unknown>): void {
    if (!this.connectionId) return;
    void sessionRealtimeSend({
      connectionId: this.connectionId,
      message: JSON.stringify({ method, params }),
    }).catch(() => {});
  }

  private handleMessage(raw: string, epoch: number): void {
    if (epoch !== this.epoch) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(raw) as JsonRpcMessage;
    } catch {
      return;
    }

    if (message.method === "yorishiro/realtime-bridge/closed") {
      this.connectionId = null;
      // この接続が見ていない間に /clear された可能性がある。grace period 中の
      // 旧 thread を preferred として再利用せず、再接続後に一意なら再発見する。
      this.setCurrentThreadId(null);
      this.knownLoadedThreadIds.clear();
      this.rejectPending(new Error("Codex thread tracker connection closed"));
      this.scheduleReconnect(epoch);
      return;
    }

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeoutId);
      if ("error" in message) pending.reject(new Error(jsonRpcErrorMessage(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.method === "thread/started") {
      const params = message.params;
      const thread = isRecord(params) ? params.thread : undefined;
      if (
        isRecord(thread) &&
        typeof thread.id === "string" &&
        thread.id.length > 0 &&
        thread.parentThreadId === null
      ) {
        this.topLevelStartedGeneration += 1;
        this.threadSelectionGeneration += 1;
        this.knownLoadedThreadIds.add(thread.id);
        this.setCurrentThreadId(thread.id);
      }
      return;
    }

    if (message.method === "thread/status/changed") {
      const params = message.params;
      if (
        !isRecord(params) ||
        typeof params.threadId !== "string" ||
        params.threadId.length === 0
      ) {
        return;
      }
      const status = params.status;
      if (!isRecord(status) || typeof status.type !== "string") return;
      if (status.type === "notLoaded") {
        this.knownLoadedThreadIds.delete(params.threadId);
        if (params.threadId === this.currentThreadId) this.setCurrentThreadId(null);
        return;
      }
      const wasAlreadyLoaded = this.knownLoadedThreadIds.has(params.threadId);
      this.knownLoadedThreadIds.add(params.threadId);
      // A cold /resume announces the newly loaded idle thread. If it was already kept loaded
      // by the grace period, the first reliable ownership signal is its next active turn.
      if (status.type !== "active" && wasAlreadyLoaded) return;
      this.considerStatusThread(params.threadId, epoch);
      return;
    }

    if (message.method === "thread/closed" || message.method === "thread/deleted") {
      const params = message.params;
      if (isRecord(params) && typeof params.threadId === "string") {
        this.knownLoadedThreadIds.delete(params.threadId);
      }
      if (isRecord(params) && params.threadId === this.currentThreadId) {
        this.setCurrentThreadId(null);
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonRpcErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return "Codex app-server request failed";
}
