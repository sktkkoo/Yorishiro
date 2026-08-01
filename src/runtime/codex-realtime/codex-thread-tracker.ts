import { Channel } from "@tauri-apps/api/core";
import {
  sessionRealtimeConnect,
  sessionRealtimeDisconnect,
  sessionRealtimeSend,
} from "../../bindings/tauri-commands";

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
}

interface JsonRpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

/**
 * TUI の thread/started broadcast を voice が停止中も監視する。
 *
 * thread/loaded/list は unsubscribe 済み thread も grace period 中は返すため、
 * /clear や /resume 後の current TUI thread を一覧だけから特定することはできない。
 */
export class CodexThreadTracker {
  private readonly sessionId: string;
  private connectionId: string | null = null;
  private nextRequestId = 1;
  private pending = new Map<number, PendingRequest>();
  private currentThreadId: string | null = null;
  private epoch = 0;
  private topLevelStartedGeneration = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  getCurrentThreadId(): string | null {
    return this.currentThreadId;
  }

  async start(): Promise<void> {
    if (this.connectionId) return;
    const epoch = ++this.epoch;
    try {
      const onMessage = new Channel<string>();
      onMessage.onmessage = (message) => this.handleMessage(message, epoch);
      const connectionId = await sessionRealtimeConnect({ sessionId: this.sessionId, onMessage });
      if (epoch !== this.epoch) {
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
      if (epoch !== this.epoch) return;
      this.notify("initialized", {});
      await this.discoverInitialThread(epoch);
    } catch (error) {
      if (epoch === this.epoch) this.stop();
      throw error;
    }
  }

  stop(): void {
    this.epoch += 1;
    const connectionId = this.connectionId;
    this.connectionId = null;
    this.currentThreadId = null;
    const error = new Error("Codex thread tracker stopped");
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (connectionId) void sessionRealtimeDisconnect({ connectionId }).catch(() => {});
  }

  private async discoverInitialThread(epoch: number): Promise<void> {
    const generation = this.topLevelStartedGeneration;
    const result = (await this.request("thread/loaded/list", {})) as {
      readonly data?: ReadonlyArray<unknown>;
    };
    if (epoch !== this.epoch || generation !== this.topLevelStartedGeneration) return;
    const ids = result.data;
    if (!Array.isArray(ids)) return;

    const topLevelIds: string[] = [];
    for (const id of ids) {
      if (typeof id !== "string" || id.length === 0) return;
      let read: unknown;
      try {
        read = await this.request("thread/read", { threadId: id, includeTurns: false });
      } catch {
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
      this.currentThreadId = unique[0] ?? null;
    }
  }

  private request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const connectionId = this.connectionId;
    if (!connectionId) return Promise.reject(new Error("Codex thread tracker is not connected"));
    const id = this.nextRequestId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    void sessionRealtimeSend({
      connectionId,
      message: JSON.stringify({ method, id, params }),
    }).catch((error) => {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
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

    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
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
        this.currentThreadId = thread.id;
      }
      return;
    }

    if (message.method === "thread/closed" || message.method === "thread/deleted") {
      const params = message.params;
      if (isRecord(params) && params.threadId === this.currentThreadId) {
        this.currentThreadId = null;
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
