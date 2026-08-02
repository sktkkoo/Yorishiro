import { GROUNDED_AGENT_STATES, isGroundedAgentState } from "../agent-state-expression/tool-cue";
import type { GroundedAgentState } from "../agent-state-expression/types";

export const REALTIME_EXPRESSION_TOOL_NAME = "emit_state_expression";

/** dev build で `localStorage.setItem("yorishiro:realtime-expression-tool", "1")` すると有効。 */
export const REALTIME_EXPRESSION_TOOL_FLAG_KEY = "yorishiro:realtime-expression-tool";

const EVENT_ID_PREFIX = "yorishiro-expression-tool";
const DEFAULT_MAX_SESSION_UPDATE_ATTEMPTS = 3;

/**
 * Issue #85 spike の opt-in 判定。production build では常に false、
 * dev build でも localStorage flag を明示した場合だけ有効になる。
 */
export function isRealtimeExpressionToolEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  try {
    return localStorage.getItem(REALTIME_EXPRESSION_TOOL_FLAG_KEY) === "1";
  } catch {
    return false;
  }
}

/** 検証済み function call。identity は再検証済みで、cue 適用側は表情値の解決だけを担う。 */
export interface RealtimeExpressionToolCue {
  readonly state: GroundedAgentState;
  readonly intensity?: "small" | "medium";
  readonly responseId: string;
  readonly itemId: string;
  readonly callId: string;
}

/** RTCDataChannel のうち、この handler が必要とする最小面。test では fake に差し替える。 */
export interface ExpressionToolChannelPort {
  readonly readyState: RTCDataChannelState;
  send(data: string): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface RealtimeExpressionToolChannelOptions {
  /** Codex 側 config と更新を取り合わないための session.update 送信回数上限。 */
  readonly maxSessionUpdateAttempts?: number;
  readonly log?: (message: string, data?: unknown) => void;
}

// model が音声と並行して呼ぶ非発話 side channel であることを model 自身へ明示する。
const TOOL_DEFINITION = {
  type: "function",
  name: REALTIME_EXPRESSION_TOOL_NAME,
  description:
    "Silent side channel that drives the avatar's facial expression and small body gestures. " +
    "Call it while you speak, at the moment your conversational state changes. " +
    "It returns no information and produces nothing audible. Never mention this tool, its name, " +
    "or its arguments in speech or transcripts, and never pause your spoken reply to wait for it.",
  parameters: {
    type: "object",
    properties: {
      state: {
        type: "string",
        enum: GROUNDED_AGENT_STATES,
        description: "Conversational or cognitive state grounded in what you are saying right now.",
      },
      intensity: {
        type: "string",
        enum: ["small", "medium"],
        description: "How visibly the state should show. Defaults to a subtle host-side value.",
      },
    },
    required: ["state"],
  },
} as const;

/**
 * WebRTC `oai-events` data channel 上で `emit_state_expression` function tool を運用する
 * dev 限定 spike (issue #85)。
 *
 * - session.created / session.updated で既存 session 設定を観察してから、既存 tools を
 *   一切変更せず末尾に自分の tool だけを足した `session.update` を送る。
 * - function call は `response.output_item.done` で受け、現在 active な response に
 *   属するものだけを cue として転送する。barge-in (`input_audio_buffer.speech_started`) や
 *   response 終了で active response は無効化され、stale call は破棄される。
 * - 転送は callback 一本で、追加の model call・MCP 往復・transcript への書き込みはしない。
 */
export class RealtimeExpressionToolChannel {
  private readonly maxSessionUpdateAttempts: number;
  private readonly log: (message: string, data?: unknown) => void;
  private readonly onMessage = (event: MessageEvent): void => {
    this.handleMessage((event as { readonly data?: unknown }).data);
  };
  private disposed = false;
  private sessionObserved = false;
  private registered = false;
  private updateAttempts = 0;
  private activeResponseId: string | null = null;
  private readonly handledCallIds = new Set<string>();
  private forwardedCueCount = 0;
  private staleCallCount = 0;
  private invalidCallCount = 0;
  private sendSequence = 0;

  constructor(
    private readonly channel: ExpressionToolChannelPort,
    private readonly onCue: (cue: RealtimeExpressionToolCue) => void,
    options: RealtimeExpressionToolChannelOptions = {},
  ) {
    this.maxSessionUpdateAttempts = Math.max(
      0,
      options.maxSessionUpdateAttempts ?? DEFAULT_MAX_SESSION_UPDATE_ATTEMPTS,
    );
    this.log =
      options.log ??
      ((message, data) => console.info(`[realtime-expression-tool] ${message}`, data ?? ""));
    channel.addEventListener("message", this.onMessage);
  }

  /** voice stop / disconnect / session replacement で client が呼ぶ。以後は観察も送信もしない。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.channel.removeEventListener("message", this.onMessage);
    // 実機結果の記録 (issue #85 acceptance criteria) 用の集計。
    this.log("disposed", {
      sessionObserved: this.sessionObserved,
      registered: this.registered,
      sessionUpdateAttempts: this.updateAttempts,
      forwardedCues: this.forwardedCueCount,
      staleCalls: this.staleCallCount,
      invalidCalls: this.invalidCallCount,
    });
  }

  private handleMessage(data: unknown): void {
    if (this.disposed || typeof data !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;

    switch (parsed.type) {
      case "session.created":
      case "session.updated":
        this.observeSession(parsed.session);
        return;
      case "response.created": {
        const response = parsed.response;
        if (isRecord(response) && typeof response.id === "string" && response.id.length > 0) {
          this.activeResponseId = response.id;
        }
        return;
      }
      case "response.done": {
        const response = parsed.response;
        if (isRecord(response) && response.id === this.activeResponseId) {
          this.activeResponseId = null;
        }
        return;
      }
      case "input_audio_buffer.speech_started":
        // barge-in。進行中 response の call は以後 stale として破棄する。
        this.activeResponseId = null;
        return;
      case "response.output_item.done":
        this.handleOutputItem(parsed);
        return;
      case "error": {
        const error = parsed.error;
        if (isRecord(error) && isOwnEventId(error.event_id)) {
          this.log("server rejected a client event", error);
        }
        return;
      }
      default:
        return;
    }
  }

  private observeSession(session: unknown): void {
    if (!isRecord(session)) return;
    this.sessionObserved = true;
    // 既存 tools は形を解釈せず verbatim に保持し、name の一致だけを見る。
    const tools: ReadonlyArray<unknown> = Array.isArray(session.tools) ? session.tools : [];
    const present = tools.some(
      (tool) => isRecord(tool) && tool.name === REALTIME_EXPRESSION_TOOL_NAME,
    );
    if (present) {
      if (!this.registered) this.log("tool registered", { toolCount: tools.length });
      this.registered = true;
      return;
    }
    this.registered = false;
    if (this.updateAttempts >= this.maxSessionUpdateAttempts) {
      this.log("session update attempts exhausted; leaving Codex session config as-is");
      return;
    }
    if (this.channel.readyState !== "open") return;
    this.updateAttempts += 1;
    // 観察済み tools + 自分の 1 tool のみ。他の session field には触れない。
    this.send({
      type: "session.update",
      event_id: this.nextEventId("session-update"),
      session: { tools: [...tools, TOOL_DEFINITION] },
    });
    this.log("session.update sent", { attempt: this.updateAttempts, existingTools: tools.length });
  }

  private handleOutputItem(event: Record<string, unknown>): void {
    const item = event.item;
    if (!isRecord(item) || item.type !== "function_call") return;
    if (item.name !== REALTIME_EXPRESSION_TOOL_NAME) return;
    const responseId = typeof event.response_id === "string" ? event.response_id : null;
    const itemId = typeof item.id === "string" ? item.id : null;
    const callId = typeof item.call_id === "string" ? item.call_id : null;
    if (!responseId || !itemId || !callId) return;
    if (this.handledCallIds.has(callId)) return;
    this.handledCallIds.add(callId);

    // 会話 state に dangling call を残さないため常に ack する。ただし `response.create` は
    // 送らない = この tool が新しい model turn を誘発することはない。ack は
    // function_call_output item であり、音声にも transcript にも現れない。
    this.send({
      type: "conversation.item.create",
      event_id: this.nextEventId("call-ack"),
      item: { type: "function_call_output", call_id: callId, output: '{"ok":true}' },
    });

    if (responseId !== this.activeResponseId) {
      this.staleCallCount += 1;
      this.log("stale function call discarded", { responseId, itemId });
      return;
    }
    const cue = parseCallArguments(item.arguments);
    if (!cue) {
      this.invalidCallCount += 1;
      this.log("invalid function call arguments discarded", { responseId, itemId });
      return;
    }
    this.forwardedCueCount += 1;
    this.log("cue", { state: cue.state, intensity: cue.intensity ?? null, responseId, itemId });
    this.onCue({ ...cue, responseId, itemId, callId });
  }

  private send(payload: object): void {
    if (this.disposed || this.channel.readyState !== "open") return;
    try {
      this.channel.send(JSON.stringify(payload));
    } catch (error) {
      this.log("send failed", error);
    }
  }

  private nextEventId(kind: string): string {
    return `${EVENT_ID_PREFIX}-${kind}-${++this.sendSequence}`;
  }
}

function isOwnEventId(value: unknown): boolean {
  return typeof value === "string" && value.startsWith(EVENT_ID_PREFIX);
}

function parseCallArguments(
  value: unknown,
): { readonly state: GroundedAgentState; readonly intensity?: "small" | "medium" } | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isGroundedAgentState(parsed.state)) return null;
  const intensity =
    parsed.intensity === "small" || parsed.intensity === "medium" ? parsed.intensity : undefined;
  return { state: parsed.state, ...(intensity ? { intensity } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
