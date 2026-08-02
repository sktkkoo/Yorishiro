// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ExpressionToolChannelPort,
  isRealtimeExpressionToolEnabled,
  REALTIME_EXPRESSION_TOOL_FLAG_KEY,
  REALTIME_EXPRESSION_TOOL_NAME,
  RealtimeExpressionToolChannel,
} from "./realtime-expression-tool";

class FakeChannelPort implements ExpressionToolChannelPort {
  readyState: RTCDataChannelState = "open";
  readonly sent: Array<Record<string, unknown>> = [];
  private readonly listeners = new Set<(event: MessageEvent) => void>();

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  addEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.add(listener);
  }

  removeEventListener(_type: "message", listener: (event: MessageEvent) => void): void {
    this.listeners.delete(listener);
  }

  emit(event: object): void {
    for (const listener of [...this.listeners]) {
      listener({ data: JSON.stringify(event) } as MessageEvent);
    }
  }

  emitRaw(data: unknown): void {
    for (const listener of [...this.listeners]) {
      listener({ data } as MessageEvent);
    }
  }
}

function setup(options: { maxSessionUpdateAttempts?: number } = {}) {
  const port = new FakeChannelPort();
  const onCue = vi.fn();
  const channel = new RealtimeExpressionToolChannel(port, onCue, {
    log: () => {},
    ...options,
  });
  return { port, onCue, channel };
}

const CODEX_TOOL = { type: "function", name: "codex_existing_tool", parameters: {} };

function sessionCreated(tools: ReadonlyArray<unknown>): object {
  return { type: "session.created", session: { tools } };
}

function functionCall(overrides: {
  responseId?: string;
  itemId?: string;
  callId?: string;
  name?: string;
  args?: string;
}): object {
  return {
    type: "response.output_item.done",
    response_id: overrides.responseId ?? "resp-1",
    item: {
      type: "function_call",
      id: overrides.itemId ?? "item-1",
      call_id: overrides.callId ?? "call-1",
      name: overrides.name ?? REALTIME_EXPRESSION_TOOL_NAME,
      arguments: overrides.args ?? '{"state":"considering"}',
    },
  };
}

describe("RealtimeExpressionToolChannel", () => {
  it("session設定を観察するまではsession.updateを送らない", () => {
    const h = setup();

    h.port.emit({ type: "response.created", response: { id: "resp-1" } });
    h.port.emitRaw("not json");
    h.port.emitRaw(42);

    expect(h.port.sent).toHaveLength(0);
  });

  it("既存toolsをverbatimに保持したままemit_state_expressionだけをadditiveに登録する", () => {
    const h = setup();

    h.port.emit(sessionCreated([CODEX_TOOL]));

    expect(h.port.sent).toHaveLength(1);
    const update = h.port.sent[0];
    expect(update.type).toBe("session.update");
    const session = update.session as { tools: Array<Record<string, unknown>> };
    // 既存toolsの変更・削除をせず、session.tools以外のfieldにも触れない。
    expect(Object.keys(session)).toEqual(["tools"]);
    expect(session.tools).toHaveLength(2);
    expect(session.tools[0]).toEqual(CODEX_TOOL);
    expect(session.tools[1]).toMatchObject({
      type: "function",
      name: REALTIME_EXPRESSION_TOOL_NAME,
    });
  });

  it("toolが既に登録済みのsessionには更新を送らない", () => {
    const h = setup();

    h.port.emit(
      sessionCreated([CODEX_TOOL, { type: "function", name: REALTIME_EXPRESSION_TOOL_NAME }]),
    );

    expect(h.port.sent).toHaveLength(0);
  });

  it("active responseのfunction callをcueとして転送し、response.createなしでackする", () => {
    const h = setup();
    h.port.emit(sessionCreated([]));
    h.port.emit({ type: "response.created", response: { id: "resp-1" } });

    h.port.emit(functionCall({ args: '{"state":"surprised","intensity":"medium"}' }));

    expect(h.onCue).toHaveBeenCalledExactlyOnceWith({
      state: "surprised",
      intensity: "medium",
      responseId: "resp-1",
      itemId: "item-1",
      callId: "call-1",
    });
    const ack = h.port.sent.find((message) => message.type === "conversation.item.create");
    expect(ack?.item).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: '{"ok":true}',
    });
    expect(h.port.sent.some((message) => message.type === "response.create")).toBe(false);
  });

  it("barge-in後に届いた中断済みresponseのcallをstaleとして破棄する", () => {
    const h = setup();
    h.port.emit({ type: "response.created", response: { id: "resp-1" } });

    h.port.emit({ type: "input_audio_buffer.speech_started", item_id: "user-1" });
    h.port.emit(functionCall({ responseId: "resp-1" }));

    expect(h.onCue).not.toHaveBeenCalled();
    // 会話stateの整合のためstale callもackだけは送る。
    expect(h.port.sent.some((message) => message.type === "conversation.item.create")).toBe(true);
  });

  it("active responseと異なるresponse identityのcallを破棄し、次のresponseで再び受ける", () => {
    const h = setup();
    h.port.emit({ type: "response.created", response: { id: "resp-1" } });
    h.port.emit({ type: "response.done", response: { id: "resp-1" } });

    h.port.emit(functionCall({ responseId: "resp-1", callId: "call-stale" }));
    expect(h.onCue).not.toHaveBeenCalled();

    h.port.emit({ type: "response.created", response: { id: "resp-2" } });
    h.port.emit(functionCall({ responseId: "resp-2", callId: "call-live" }));
    expect(h.onCue).toHaveBeenCalledTimes(1);
    expect(h.onCue).toHaveBeenCalledWith(expect.objectContaining({ responseId: "resp-2" }));
  });

  it("不正なargumentsや未知のstateを持つcallを破棄する", () => {
    const h = setup();
    h.port.emit({ type: "response.created", response: { id: "resp-1" } });

    h.port.emit(functionCall({ callId: "call-1", args: "not json" }));
    h.port.emit(functionCall({ callId: "call-2", args: '{"state":"angry"}' }));
    h.port.emit(functionCall({ callId: "call-3", args: '{"intensity":"small"}' }));

    expect(h.onCue).not.toHaveBeenCalled();
  });

  it("同じcall_idの重複配信を二重発火させない", () => {
    const h = setup();
    h.port.emit({ type: "response.created", response: { id: "resp-1" } });

    h.port.emit(functionCall({}));
    h.port.emit(functionCall({}));

    expect(h.onCue).toHaveBeenCalledTimes(1);
  });

  it("emit_state_expression以外のfunction callには反応しない", () => {
    const h = setup();
    h.port.emit({ type: "response.created", response: { id: "resp-1" } });

    h.port.emit(functionCall({ name: "codex_existing_tool" }));

    expect(h.onCue).not.toHaveBeenCalled();
    expect(h.port.sent).toHaveLength(0);
  });

  it("外部のsession.updatedでtoolが消えたら再登録し、送信回数上限で取り合いを止める", () => {
    const h = setup({ maxSessionUpdateAttempts: 2 });

    h.port.emit(sessionCreated([]));
    expect(h.port.sent).toHaveLength(1);

    // Codex側の再設定でtoolが消えた通知 → 残り1回で再登録を試みる。
    h.port.emit({ type: "session.updated", session: { tools: [CODEX_TOOL] } });
    expect(h.port.sent).toHaveLength(2);

    h.port.emit({ type: "session.updated", session: { tools: [CODEX_TOOL] } });
    h.port.emit({ type: "session.updated", session: { tools: [CODEX_TOOL] } });
    expect(h.port.sent).toHaveLength(2);
  });

  it("dispose後はcue転送も送信もしない", () => {
    const h = setup();
    h.port.emit(sessionCreated([]));
    h.channel.dispose();

    h.port.emit({ type: "response.created", response: { id: "resp-1" } });
    h.port.emit(functionCall({}));
    h.port.emit({ type: "session.updated", session: { tools: [] } });

    expect(h.onCue).not.toHaveBeenCalled();
    expect(h.port.sent).toHaveLength(1);
  });

  it("channelがopenでないときは送信しない", () => {
    const h = setup();
    h.port.readyState = "connecting";

    h.port.emit(sessionCreated([]));

    expect(h.port.sent).toHaveLength(0);
  });
});

describe("isRealtimeExpressionToolEnabled", () => {
  afterEach(() => {
    localStorage.removeItem(REALTIME_EXPRESSION_TOOL_FLAG_KEY);
  });

  it("dev buildでもflagが無ければdefault off", () => {
    expect(import.meta.env.DEV).toBe(true);
    expect(isRealtimeExpressionToolEnabled()).toBe(false);
  });

  it("dev build + localStorage flagで有効になる", () => {
    localStorage.setItem(REALTIME_EXPRESSION_TOOL_FLAG_KEY, "1");
    expect(isRealtimeExpressionToolEnabled()).toBe(true);
  });
});
