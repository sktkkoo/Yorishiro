import { describe, expect, it, vi } from "vitest";
import { ClaudeChatTranscriptStore, chatTranscriptFromCodexTurns } from "./chat-transcript";

function hook(seq: number, event: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    agent: "claude",
    sessionId: "main",
    session_id: "claude-1",
    _yorishiro_seq: seq,
    event,
    ...fields,
  });
}

describe("ClaudeChatTranscriptStore", () => {
  it("records observed turns, ignores delivery duplicates, and preserves identical later turns", () => {
    const store = new ClaudeChatTranscriptStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.ingestHook(hook(1, "prompt", { prompt: " 同じ質問 " }));
    expect(store.read("main").working).toBe(true);
    store.ingestHook(hook(1, "prompt", { prompt: " 同じ質問 " }));
    store.ingestHook(hook(2, "stop", { last_assistant_message: "同じ答え" }));
    store.ingestHook(hook(3, "prompt", { prompt: "同じ質問" }));
    store.ingestHook(hook(4, "stop", { last_assistant_message: "同じ答え" }));
    expect(store.read("main")).toEqual({
      conversationId: "claude-1",
      working: false,
      messages: [
        { id: "claude-1:1", role: "user", text: "同じ質問" },
        { id: "claude-1:2", role: "assistant", text: "同じ答え" },
        { id: "claude-1:3", role: "user", text: "同じ質問" },
        { id: "claude-1:4", role: "assistant", text: "同じ答え" },
      ],
    });
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    store.clear("main");
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("binds session-start, isolates host sessions and replaces the provider conversation", () => {
    const store = new ClaudeChatTranscriptStore();
    store.ingestHook(hook(1, "prompt", { prompt: "old" }));
    store.ingestHook(hook(2, "prompt", { sessionId: "other", prompt: "other" }));
    store.ingestHook(hook(3, "session-start", { session_id: "claude-2" }));
    expect(store.read("main")).toEqual({
      conversationId: "claude-2",
      messages: [],
      working: false,
    });
    store.ingestHook(hook(2, "stop", { last_assistant_message: "delayed old reply" }));
    expect(store.read("main").conversationId).toBe("claude-2");
    expect(store.read("main").messages).toEqual([]);
    expect(store.read("other").messages[0]?.text).toBe("other");
  });

  it("never presents subagent output or API errors as assistant conversation", () => {
    const store = new ClaudeChatTranscriptStore();
    store.ingestHook(hook(1, "prompt", { prompt: "hello" }));
    store.ingestHook(hook(2, "subagent-stop", { last_assistant_message: "subagent output" }));
    expect(store.read("main").working).toBe(true);
    store.ingestHook(hook(3, "stop-failure", { last_assistant_message: "API Error" }));
    expect(store.read("main").working).toBe(false);
    expect(store.read("main").needsAttention).toBe(true);
    expect(store.read("main").messages.map((message) => message.text)).toEqual(["hello"]);
  });

  it.each([
    "prompt",
    "session-start",
    "stop",
  ])("clears a previous failure on %s without exposing technical errors as messages", (event) => {
    const store = new ClaudeChatTranscriptStore();
    store.ingestHook(hook(1, "stop-failure", { last_assistant_message: "API Error" }));
    expect(store.read("main").needsAttention).toBe(true);
    const listener = vi.fn();
    store.subscribe(listener);
    store.ingestHook(hook(2, event));
    expect(store.read("main").needsAttention).not.toBe(true);
    expect(store.read("main").messages).toEqual([]);
    expect(listener).toHaveBeenCalledOnce();
  });

  it("ignores malformed/unscoped hooks and retains a stable empty snapshot", () => {
    const store = new ClaudeChatTranscriptStore();
    const empty = store.read("main");
    for (const raw of [
      "not json",
      "null",
      "[]",
      hook(1, "prompt", { agent: "codex", prompt: "no" }),
      hook(2, "prompt", { sessionId: null, prompt: "no" }),
      hook(3, "prompt", { session_id: "", prompt: "no" }),
      hook(4, "prompt", { _yorishiro_seq: null, prompt: "no" }),
      hook(5, "unknown", { prompt: "no" }),
    ]) {
      store.ingestHook(raw);
    }
    expect(store.read("main")).toBe(empty);
  });

  it("bounds retained text and prevents cleared observations from replaying", () => {
    const store = new ClaudeChatTranscriptStore();
    for (let seq = 1; seq <= 402; seq += 1) {
      store.ingestHook(hook(seq, "prompt", { prompt: `message ${seq}` }));
    }
    expect(store.read("main").messages).toHaveLength(400);
    expect(store.read("main").messages[0]?.text).toBe("message 3");
    store.clear("main");
    store.ingestHook(hook(402, "prompt", { prompt: "message 402" }));
    expect(store.read("main").messages).toEqual([]);
    store.ingestHook(hook(403, "session-start", { session_id: "new" }));
    expect(store.read("main").conversationId).toBe("new");
  });
});

describe("chatTranscriptFromCodexTurns", () => {
  it.each([
    "failed",
    "interrupted",
  ])("requires attention for a latest %s turn, but not for older failures", (status) => {
    const failed = { id: "failed", status, items: [] };
    expect(chatTranscriptFromCodexTurns("thread", [failed]).needsAttention).toBe(true);
    for (const newerStatus of ["completed", "inProgress"]) {
      const latest = { id: "latest", status: newerStatus, items: [] };
      const transcript = chatTranscriptFromCodexTurns("thread", [latest, failed]);
      expect(transcript.needsAttention).not.toBe(true);
      expect(transcript.working).toBe(newerStatus === "inProgress");
    }
  });

  it("orders turns chronologically and retains text commentary without tools or reasoning", () => {
    const turns = [
      {
        id: "new",
        status: "inProgress",
        items: [
          { id: "u2", type: "userMessage", content: [{ type: "text", text: "next" }] },
          { id: "comment", type: "agentMessage", phase: "commentary", text: "Checking…" },
          { id: "tool", type: "commandExecution", text: "secret tool output" },
          { id: "thought", type: "reasoning", text: "private reasoning" },
        ],
      },
      {
        id: "old",
        status: "completed",
        items: [
          {
            id: "u1",
            type: "userMessage",
            content: [
              { type: "text", text: "he" },
              { type: "image", text: "not text" },
              { type: "text", text: "llo" },
            ],
          },
          { id: "a1", type: "agentMessage", phase: "final_answer", text: "hi" },
        ],
      },
    ];
    const transcript = chatTranscriptFromCodexTurns("thread", turns);
    expect(transcript.working).toBe(true);
    expect(transcript.messages.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
      { role: "user", text: "next" },
      { role: "assistant", text: "Checking…" },
    ]);
    expect(chatTranscriptFromCodexTurns("thread", turns).messages).toEqual(transcript.messages);
  });

  it("filters malformed/empty items and uses turn-scoped fallback IDs for identical text", () => {
    const item = { type: "agentMessage", text: "same" };
    const transcript = chatTranscriptFromCodexTurns("thread", [
      { id: "second", items: [item] },
      { id: "first", items: [item, null, { type: "agentMessage", text: " " }] },
      { items: [item] },
      null,
    ]);
    expect(transcript.messages).toEqual([
      { id: "thread:first:0", role: "assistant", text: "same" },
      { id: "thread:second:0", role: "assistant", text: "same" },
    ]);
    expect(transcript.working).toBe(false);
  });
});
