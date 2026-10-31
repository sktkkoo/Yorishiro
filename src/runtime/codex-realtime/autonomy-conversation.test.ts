import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AutonomyConversationTransport,
  autonomyConversationContext,
} from "./autonomy-conversation";

function fixture() {
  let threadId: string | null = "main";
  const request = vi.fn(
    async (method: string, _params: Record<string, unknown>): Promise<unknown> => {
      if (method === "turn/start")
        return { turn: { id: "turn-1", status: "inProgress", items: [] } };
      if (method === "thread/turns/list") return { data: [] };
      return {};
    },
  );
  const selected = vi.fn(async () => {});
  const transport = new AutonomyConversationTransport({
    request,
    getThreadId: () => threadId,
    assertSelectedThread: selected,
    timeoutMs: 5_000,
  });
  const complete = (id = "turn-1", owner = "main", status = "completed") =>
    transport.onTurnCompleted({
      threadId: owner,
      turn: {
        id,
        status,
        items: [{ type: "agentMessage", phase: "final_answer", text: "まとめました" }],
      },
    });
  return {
    transport,
    request,
    selected,
    complete,
    setThread: (id: string | null) => {
      threadId = id;
    },
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe("Auto native conversation", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps host context separate from user input and inherits the Main thread's authority", async () => {
    const f = fixture();
    const answer = f.transport.send("このメモを整理して", "ja");
    await flush();
    expect(f.request.mock.calls[0]).toEqual([
      "thread/inject_items",
      {
        threadId: "main",
        items: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: autonomyConversationContext("ja") }],
          },
        ],
      },
    ]);
    expect(f.request.mock.calls[1]).toEqual([
      "turn/start",
      {
        threadId: "main",
        input: [{ type: "text", text: "このメモを整理して", text_elements: [] }],
      },
    ]);
    expect(f.request.mock.calls[0][1]).not.toEqual(
      expect.objectContaining({ text: "このメモを整理して" }),
    );
    expect(f.selected).toHaveBeenCalledTimes(2);
    f.complete();
    await expect(answer).resolves.toBe("まとめました");
  });

  it("matches an early completion to the acknowledged turn", async () => {
    const f = fixture();
    f.request.mockImplementation(async (method) => {
      if (method === "turn/start") {
        f.complete("other-turn");
        f.complete();
        return { turn: { id: "turn-1", status: "inProgress", items: [] } };
      }
      return {};
    });
    await expect(f.transport.send("進めて")).resolves.toBe("まとめました");
  });

  it("recovers a missing completion through the exact returned turn's full history", async () => {
    const f = fixture();
    f.request.mockImplementation(async (method) => {
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress" } };
      if (method === "thread/turns/list")
        return {
          data: [
            {
              id: "other-turn",
              status: "completed",
              items: [{ type: "agentMessage", text: "別の返事" }],
            },
            {
              id: "turn-1",
              status: "completed",
              items: [
                { type: "agentMessage", phase: "commentary", text: "調べています" },
                { type: "agentMessage", phase: "final_answer", text: "確認しました" },
              ],
            },
          ],
        };
      return {};
    });
    await expect(f.transport.send("どこまで進んだ？")).resolves.toBe("確認しました");
    expect(f.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
  });

  it("retrieves a reply when a completion notification omits items", async () => {
    const f = fixture();
    const answer = f.transport.send("進み具合は？");
    await flush();
    f.transport.onTurnCompleted({
      threadId: "main",
      turn: { id: "turn-1", status: "completed" },
    });
    f.request.mockResolvedValue({
      data: [
        {
          id: "turn-1",
          status: "completed",
          items: [{ type: "agentMessage", phase: "final_answer", text: "作業中です" }],
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(answer).resolves.toBe("作業中です");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["ja", "再送する前にMain Agentの会話を確認"],
    ["en", "Check the Main Agent conversation before retrying"],
  ] as const)("reports a completed conversation without a reply in %s", async (language, message) => {
    const f = fixture();
    f.request.mockImplementation(async (method) => {
      if (method === "turn/start") return { turn: { id: "turn-1", status: "inProgress" } };
      if (method === "thread/turns/list")
        return { data: [{ id: "turn-1", status: "completed", items: [] }] };
      return {};
    });
    await expect(f.transport.send("進み具合は？", language)).rejects.toThrow(message);
    expect(f.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores other threads and turns, and rejects parallel submissions", async () => {
    const f = fixture();
    const answer = f.transport.send("最初の依頼");
    await flush();
    await expect(f.transport.send("二重送信")).rejects.toThrow("返事を待って");
    f.complete("turn-1", "other-thread");
    f.complete("other-turn");
    expect(f.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    f.complete();
    await expect(answer).resolves.toBe("まとめました");
  });

  it.each([
    "failed",
    "interrupted",
  ])("surfaces a %s turn instead of claiming success", async (status) => {
    const f = fixture();
    const answer = f.transport.send("進めて");
    const rejection = expect(answer).rejects.toThrow("native failure");
    await flush();
    f.transport.onTurnCompleted({
      threadId: "main",
      turn: { id: "turn-1", status, error: { message: "native failure" } },
    });
    await rejection;
  });

  it("does not send a user turn after context delivery loses ownership", async () => {
    const f = fixture();
    let release!: () => void;
    f.request.mockImplementation(async (method) => {
      if (method === "thread/inject_items")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return {};
    });
    const answer = f.transport.send("元の会話への依頼");
    const rejection = expect(answer).rejects.toThrow("会話が切り替わりました");
    await flush();
    f.transport.cancel();
    f.setThread("next");
    release();
    await flush();
    await rejection;
    expect(f.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("rejects a changed proxy selection before sending input", async () => {
    const f = fixture();
    f.selected.mockResolvedValueOnce().mockRejectedValueOnce(new Error("selection changed"));
    await expect(f.transport.send("依頼")).rejects.toThrow("selection changed");
    expect(f.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("cancels observation without interrupting an already submitted Main turn", async () => {
    const f = fixture();
    const answer = f.transport.send("進めて");
    const rejection = expect(answer).rejects.toThrow("元の会話で確認");
    await flush();
    f.transport.cancel();
    f.complete();
    await rejection;
    expect(f.request.mock.calls.some(([method]) => method === "turn/interrupt")).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out an uncertain reply without resubmitting the user's work", async () => {
    const f = fixture();
    const answer = f.transport.send("進めて");
    const rejection = expect(answer).rejects.toThrow("再送する前");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
    expect(f.request.mock.calls.filter(([method]) => method === "turn/start")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not offer a permanent setup mode or infer activation from conversation", () => {
    const context = autonomyConversationContext("en");
    expect(context).toContain("Continue in English");
    expect(context).toContain("autonomy_setup_context");
    expect(context).toContain("autonomy_action_context");
    expect(context).toContain(
      "Before answering any progress or results question, refresh autonomy_setup_context",
    );
    expect(context).toContain("workStatus snapshot");
    expect(context).toContain("inactive draft does not modify a running worker");
    expect(context).toContain("user's explicit app action");
    expect(context).toContain("current draft.id as baseDraftId");
  });
});
