import { Channel } from "@tauri-apps/api/core";
import {
  sessionRealtimeConnect,
  sessionRealtimeDisconnect,
  sessionRealtimeSelectedThread,
  sessionRealtimeSend,
} from "../../bindings/tauri-commands";
import { type ScreenObservationFrame, ScreenObservationTransport } from "./screen-observation";

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
const QUICK_CHAT_POLL_MS = 200;
const QUICK_CHAT_BASELINE_WAIT_MS = 500;
const QUICK_CHAT_PROMPT_TTL_MS = 10 * 60 * 1_000;
const MAX_PENDING_QUICK_CHAT_PROMPTS = 8;

class TrackerRequestTimeoutError extends Error {}

export interface CodexQuickChatResponse {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string;
  readonly text: string;
}

interface PendingQuickChatPrompt {
  readonly requestId: string;
  readonly prompt: string;
  readonly threadId: string;
  readonly submittedAt: number;
  readonly baselineUserMessageTokens: ReadonlySet<string>;
  readonly baselineKnown: boolean;
}

interface TrackedQuickChatTurn {
  readonly requestId: string;
  readonly threadId: string;
  readonly submittedAt: number;
}

/**
 * TUI proxy が確認した選択 thread を voice が停止中も追跡する。
 *
 * app-server の `thread/started` は全 client の内部 thread も broadcast するため、
 * TUI ownership の根拠にはできない。`thread/loaded/list` も unsubscribe 済み thread を
 * grace period 中は返すので、接続後の /clear や /resume は proxy 選択だけを正本にする。
 */
export class CodexThreadTracker {
  private readonly sessionId: string;
  private readonly onCurrentThreadChange: (threadId: string | null) => void;
  private readonly onQuickChatResponse: (response: CodexQuickChatResponse) => void;
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
  private quickChatPollTimer: ReturnType<typeof setInterval> | null = null;
  private quickChatPollInFlight = false;
  private nextQuickChatRequestId = 1;
  private pendingQuickChatPrompts: PendingQuickChatPrompt[] = [];
  private readonly trackedQuickChatTurns = new Map<string, TrackedQuickChatTurn>();
  private readonly screenObservation = new ScreenObservationTransport({
    request: (method, params) => this.request(method, params as Record<string, unknown>),
    getThreadId: () => (this.running && this.connectionId ? this.currentThreadId : null),
  });

  constructor(
    sessionId: string,
    onCurrentThreadChange: (threadId: string | null) => void = () => {},
    onQuickChatResponse: (response: CodexQuickChatResponse) => void = () => {},
  ) {
    this.sessionId = sessionId;
    this.onCurrentThreadChange = onCurrentThreadChange;
    this.onQuickChatResponse = onQuickChatResponse;
  }

  getCurrentThreadId(): string | null {
    return this.currentThreadId;
  }

  shareScreenObservation(frame: ScreenObservationFrame, signal?: AbortSignal) {
    return this.screenObservation.observe(frame, signal);
  }

  cancelScreenObservation(): void {
    this.screenObservation.cancel();
  }

  /**
   * PTY から送る quick-chat prompt と app-server の userMessage を照合し、
   * その turn の最終 assistant message だけを callback へ返す。
   */
  async trackQuickChatPrompt(prompt: string): Promise<string | null> {
    const normalized = prompt.trim();
    const threadId = this.currentThreadId;
    if (!this.running || !threadId || normalized.length === 0) return null;
    let baseline: ReadonlyArray<Record<string, unknown>> = [];
    let baselineKnown = true;
    try {
      baseline = await this.readRecentTurns(threadId);
    } catch {
      // A fresh Codex thread has no materialized turn history yet. In that case
      // app-server may reject the baseline read, so fall back to startedAt gating.
      baselineKnown = false;
    }
    if (!this.running || this.currentThreadId !== threadId) return null;
    this.pruneQuickChatTracking();
    const requestId = `${this.sessionId}:${this.nextQuickChatRequestId++}`;
    this.pendingQuickChatPrompts.push({
      requestId,
      prompt: normalized,
      threadId,
      submittedAt: Date.now(),
      baselineUserMessageTokens: new Set(baseline.flatMap((turn) => userMessageTokens(turn))),
      baselineKnown,
    });
    if (this.pendingQuickChatPrompts.length > MAX_PENDING_QUICK_CHAT_PROMPTS) {
      this.pendingQuickChatPrompts.splice(
        0,
        this.pendingQuickChatPrompts.length - MAX_PENDING_QUICK_CHAT_PROMPTS,
      );
    }
    this.ensureQuickChatPolling();
    return requestId;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const epoch = ++this.epoch;
    try {
      await this.connect(epoch);
    } catch (error) {
      if (epoch === this.epoch && this.running) this.scheduleReconnect(epoch);
      throw error;
    }
  }

  stop(): void {
    this.screenObservation.cancel();
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
    if (this.quickChatPollTimer !== null) {
      clearInterval(this.quickChatPollTimer);
      this.quickChatPollTimer = null;
    }
    this.quickChatPollInFlight = false;
    const connectionId = this.connectionId;
    this.connectionId = null;
    this.setCurrentThreadId(null);
    this.knownLoadedThreadIds.clear();
    this.pendingQuickChatPrompts = [];
    this.trackedQuickChatTurns.clear();
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
      if (epoch !== this.epoch || !this.running) return;
      // Initial connect and every later reconnect share this path. Keep proxy polling alive even
      // when the first connection attempt failed before start() could install it.
      this.startSelectionPolling(epoch);
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
      if (thread.parentThreadId === null && thread.ephemeral !== true) topLevelIds.push(id);
    }

    // Startup 時に一意なら初期値にできる。複数時は過去の broadcast がないため推測しない。
    const unique = [...new Set(topLevelIds)];
    if (unique.length === 1 && generation === this.topLevelStartedGeneration) {
      this.setCurrentThreadId(unique[0] ?? null);
    }
  }

  private setCurrentThreadId(threadId: string | null): void {
    if (this.currentThreadId === threadId) return;
    this.screenObservation.cancel();
    this.currentThreadId = threadId;
    this.onCurrentThreadChange(threadId);
  }

  private startSelectionPolling(epoch: number): void {
    if (this.selectionPollTimer !== null) return;
    const poll = (): void => {
      void sessionRealtimeSelectedThread({ sessionId: this.sessionId })
        .then((threadId) => {
          if (epoch !== this.epoch || !this.running || !threadId) return;
          this.considerProxyThread(threadId, epoch);
        })
        .catch(() => {});
    };
    poll();
    this.selectionPollTimer = setInterval(poll, TUI_SELECTION_POLL_MS);
  }

  /**
   * TUI proxy selection is authoritative for ownership, but its ID is still validated with
   * `thread/read` before voice uses it.
   */
  private considerProxyThread(threadId: string, epoch: number): void {
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
          thread.parentThreadId === null &&
          thread.ephemeral !== true
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
        thread.parentThreadId === null &&
        (!("forkedFromId" in thread) || thread.forkedFromId === null)
      ) {
        // This broadcast is app-server-global. Realtime handoffs, title generation, and other
        // clients can all create indistinguishable top-level threads. It may invalidate an
        // in-flight startup snapshot, but only the TUI proxy may retarget an established voice.
        this.topLevelStartedGeneration += 1;
        this.knownLoadedThreadIds.add(thread.id);
      }
      return;
    }

    if (message.method === "item/completed") {
      this.handleCompletedItem(message.params);
      return;
    }

    if (message.method === "turn/completed") {
      this.handleCompletedTurn(message.params);
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
      this.knownLoadedThreadIds.add(params.threadId);
      // Status is global thread activity, not evidence that the TUI selected this thread. In
      // particular side forks and other top-level work can become active independently.
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

  private handleCompletedItem(value: unknown): void {
    if (!isRecord(value)) return;
    const threadId = typeof value.threadId === "string" ? value.threadId : null;
    const turnId = typeof value.turnId === "string" ? value.turnId : null;
    const item = value.item;
    if (!threadId || !turnId || !isRecord(item) || item.type !== "userMessage") return;
    const prompt = userMessageText(item);
    if (prompt === null) return;

    this.pruneQuickChatTracking();
    const pendingIndex = this.pendingQuickChatPrompts.findIndex(
      (pending) => pending.prompt === prompt && pending.threadId === threadId,
    );
    if (pendingIndex < 0) return;
    const [pending] = this.pendingQuickChatPrompts.splice(pendingIndex, 1);
    if (!pending) return;
    this.trackedQuickChatTurns.set(turnTrackingKey(threadId, turnId), {
      requestId: pending.requestId,
      threadId,
      submittedAt: pending.submittedAt,
    });
  }

  private handleCompletedTurn(value: unknown): void {
    if (!isRecord(value) || typeof value.threadId !== "string" || !isRecord(value.turn)) return;
    const turnId = typeof value.turn.id === "string" ? value.turn.id : null;
    if (!turnId) return;
    const key = turnTrackingKey(value.threadId, turnId);
    const tracking = this.trackedQuickChatTurns.get(key);
    if (!tracking) return;
    const text = assistantReplyText(value.turn.items);
    if (text.length === 0 && value.turn.status === "completed") return;
    this.trackedQuickChatTurns.delete(key);
    this.onQuickChatResponse({
      requestId: tracking.requestId,
      threadId: tracking.threadId,
      turnId,
      text,
    });
  }

  private pruneQuickChatTracking(now = Date.now()): void {
    this.pendingQuickChatPrompts = this.pendingQuickChatPrompts.filter(
      (pending) => now - pending.submittedAt <= QUICK_CHAT_PROMPT_TTL_MS,
    );
    for (const [key, tracked] of this.trackedQuickChatTurns) {
      if (now - tracked.submittedAt > QUICK_CHAT_PROMPT_TTL_MS) {
        this.trackedQuickChatTurns.delete(key);
      }
    }
    if (this.pendingQuickChatPrompts.length === 0 && this.trackedQuickChatTurns.size === 0) {
      this.stopQuickChatPolling();
    }
  }

  private ensureQuickChatPolling(): void {
    if (this.quickChatPollTimer !== null) return;
    const poll = (): void => void this.pollQuickChatTurns();
    this.quickChatPollTimer = setInterval(poll, QUICK_CHAT_POLL_MS);
    poll();
  }

  private stopQuickChatPolling(): void {
    if (this.quickChatPollTimer === null) return;
    clearInterval(this.quickChatPollTimer);
    this.quickChatPollTimer = null;
  }

  private async pollQuickChatTurns(): Promise<void> {
    if (!this.running || this.quickChatPollInFlight) return;
    this.pruneQuickChatTracking();
    const threadIds = new Set<string>([
      ...this.pendingQuickChatPrompts.map((pending) => pending.threadId),
      ...[...this.trackedQuickChatTurns.values()].map((tracked) => tracked.threadId),
    ]);
    if (threadIds.size === 0) return;
    this.quickChatPollInFlight = true;
    try {
      for (const threadId of threadIds) {
        const turns = await this.readRecentTurns(threadId).catch(() => []);
        this.ingestQuickChatTurns(threadId, turns);
      }
    } finally {
      this.quickChatPollInFlight = false;
      this.pruneQuickChatTracking();
    }
  }

  private async readRecentTurns(threadId: string): Promise<ReadonlyArray<Record<string, unknown>>> {
    const result = (await new Promise<unknown>((resolve, reject) => {
      const timeoutId = setTimeout(
        () => reject(new TrackerRequestTimeoutError("Quick-chat turn lookup timed out")),
        QUICK_CHAT_BASELINE_WAIT_MS,
      );
      void this.request("thread/turns/list", {
        threadId,
        limit: 8,
        sortDirection: "desc",
        itemsView: "full",
      }).then(
        (value) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        (error) => {
          clearTimeout(timeoutId);
          reject(error);
        },
      );
    })) as { readonly data?: unknown };
    return Array.isArray(result.data) ? result.data.filter(isRecord) : [];
  }

  private ingestQuickChatTurns(
    threadId: string,
    turns: ReadonlyArray<Record<string, unknown>>,
  ): void {
    for (const pending of [...this.pendingQuickChatPrompts]) {
      if (pending.threadId !== threadId) continue;
      const turn = turns.find((candidate) => {
        const turnId = turnIdOf(candidate);
        if (!turnId) return false;
        if (!pending.baselineKnown) {
          const startedAt = candidate.startedAt;
          if (
            typeof startedAt !== "number" ||
            startedAt * 1_000 < pending.submittedAt - QUICK_CHAT_POLL_MS
          ) {
            return false;
          }
        }
        return turnHasNewUserMessage(candidate, pending.prompt, pending.baselineUserMessageTokens);
      });
      const turnId = turn ? turnIdOf(turn) : null;
      if (!turn || !turnId) continue;
      this.pendingQuickChatPrompts = this.pendingQuickChatPrompts.filter(
        (candidate) => candidate.requestId !== pending.requestId,
      );
      this.trackedQuickChatTurns.set(turnTrackingKey(threadId, turnId), {
        requestId: pending.requestId,
        threadId,
        submittedAt: pending.submittedAt,
      });
    }

    for (const turn of turns) {
      const turnId = turnIdOf(turn);
      if (!turnId || turn.status === "inProgress") continue;
      const key = turnTrackingKey(threadId, turnId);
      const tracking = this.trackedQuickChatTurns.get(key);
      if (!tracking) continue;
      this.trackedQuickChatTurns.delete(key);
      this.onQuickChatResponse({
        requestId: tracking.requestId,
        threadId,
        turnId,
        text: assistantReplyText(turn.items),
      });
    }
  }
}

function turnTrackingKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function userMessageText(item: Record<string, unknown>): string | null {
  if (!Array.isArray(item.content)) return null;
  const text = item.content
    .filter(
      (part): part is Record<string, unknown> =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length > 0 ? text : null;
}

function turnIdOf(turn: Record<string, unknown>): string | null {
  return typeof turn.id === "string" && turn.id.length > 0 ? turn.id : null;
}

function userMessageTokens(turn: Record<string, unknown>): string[] {
  if (!Array.isArray(turn.items)) return [];
  const turnId = turnIdOf(turn);
  return turn.items.flatMap((item, index) => {
    if (!isRecord(item) || item.type !== "userMessage") return [];
    const token = userMessageToken(turnId, item, index);
    return token ? [token] : [];
  });
}

function userMessageToken(
  turnId: string | null,
  item: Record<string, unknown>,
  itemIndex: number,
): string | null {
  if (typeof item.id === "string" && item.id.length > 0) return `item:${item.id}`;
  const text = userMessageText(item);
  return turnId && text ? `turn:${turnId}:${itemIndex}:${text}` : null;
}

function turnHasNewUserMessage(
  turn: Record<string, unknown>,
  prompt: string,
  baselineTokens: ReadonlySet<string>,
): boolean {
  if (!Array.isArray(turn.items)) return false;
  const turnId = turnIdOf(turn);
  for (const [index, item] of turn.items.entries()) {
    if (!isRecord(item) || item.type !== "userMessage") continue;
    const token = userMessageToken(turnId, item, index);
    if (userMessageText(item) === prompt && token && !baselineTokens.has(token)) return true;
  }
  return false;
}

function assistantReplyText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  let fallback = "";
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    if (isRecord(item) && item.type === "agentMessage" && typeof item.text === "string") {
      const text = item.text.trim();
      if (text.length === 0) continue;
      if (item.phase === "final_answer") return text;
      if (item.phase !== "commentary" && fallback.length === 0) fallback = text;
    }
  }
  if (fallback.length > 0) return fallback;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const item = value[index];
    if (isRecord(item) && item.type === "agentMessage" && typeof item.text === "string") {
      const text = item.text.trim();
      if (text.length > 0) return text;
    }
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function jsonRpcErrorMessage(value: unknown): string {
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return "Codex app-server request failed";
}
