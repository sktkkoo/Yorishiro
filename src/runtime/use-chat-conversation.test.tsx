// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ChatTranscript, ClaudeChatTranscriptStore } from "./chat-transcript";
import { useChatConversation } from "./use-chat-conversation";

type Options = Parameters<typeof useChatConversation>[0];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function transcript(conversationId: string, text: string): ChatTranscript {
  return {
    conversationId,
    messages: [{ id: `${conversationId}:reply`, role: "assistant", text }],
    working: false,
  };
}

function options(overrides: Partial<Options> = {}): Options {
  return {
    enabled: true,
    sessionId: "session-a",
    agent: "codex",
    generation: 1,
    selectedThreadId: "thread-a",
    claudeStore: new ClaudeChatTranscriptStore(),
    readCodexTranscript: vi.fn().mockResolvedValue(transcript("thread-a", "Hello")),
    submit: vi.fn().mockResolvedValue(undefined),
    canSend: true,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useChatConversation", () => {
  it.each([
    { sessionId: "session-b" },
    { generation: 2 },
    { selectedThreadId: "thread-b" },
  ])("ignores an old Codex read after the conversation changes: %j", async (change) => {
    const oldRead = deferred<ChatTranscript>();
    const currentRead = deferred<ChatTranscript>();
    const read = vi
      .fn<() => Promise<ChatTranscript>>()
      .mockReturnValueOnce(oldRead.promise)
      .mockReturnValueOnce(currentRead.promise);
    const initial = options({ readCodexTranscript: read });
    const { result, rerender } = renderHook(useChatConversation, { initialProps: initial });
    const next = { ...initial, ...change };
    rerender(next);
    const currentThread = next.selectedThreadId ?? "thread-a";
    await act(async () => currentRead.resolve(transcript(currentThread, "Current conversation")));
    expect(result.current.transcript.messages[0]?.text).toBe("Current conversation");

    await act(async () => oldRead.resolve(transcript("thread-a", "Stale conversation")));
    expect(result.current.transcript.messages[0]?.text).toBe("Current conversation");
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("does not surface a rejected read from the previously selected thread", async () => {
    const oldRead = deferred<ChatTranscript>();
    const read = vi
      .fn<() => Promise<ChatTranscript>>()
      .mockReturnValueOnce(oldRead.promise)
      .mockResolvedValue(transcript("thread-b", "Current conversation"));
    const initial = options({ readCodexTranscript: read });
    const { result, rerender } = renderHook(useChatConversation, { initialProps: initial });
    rerender({ ...initial, selectedThreadId: "thread-b" });
    await act(async () => oldRead.reject(new Error("Old connection closed")));
    expect(result.current.error).toBeNull();
    expect(result.current.transcript.conversationId).toBe("thread-b");
  });

  it("preserves the draft after a failed submission and allows retrying it", async () => {
    const submit = vi
      .fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Disconnected"))
      .mockResolvedValueOnce(undefined);
    const { result } = renderHook(useChatConversation, { initialProps: options({ submit }) });
    act(() => result.current.setDraft("first line\nsecond line"));
    await act(async () => result.current.send());
    expect(result.current.draft).toBe("first line\nsecond line");
    expect(result.current.error).toBe("send");
    expect(result.current.sending).toBe(false);

    await act(async () => result.current.send());
    expect(submit.mock.calls).toEqual([["first line\nsecond line"], ["first line\nsecond line"]]);
    expect(result.current.draft).toBe("");
    expect(result.current.error).toBeNull();
  });

  it("does not clear a newer draft when an older submission completes", async () => {
    const pending = deferred<void>();
    const submit = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(useChatConversation, { initialProps: options({ submit }) });
    act(() => result.current.setDraft("Send this"));
    let sending: Promise<void> | undefined;
    act(() => {
      sending = result.current.send();
    });
    act(() => result.current.setDraft("Keep this newer draft"));
    await act(async () => {
      pending.resolve(undefined);
      await sending;
    });
    expect(result.current.draft).toBe("Keep this newer draft");
    expect(result.current.sending).toBe(false);
  });

  it("does not clear the next session's draft or stop its pending submission", async () => {
    const oldSend = deferred<void>();
    const newSend = deferred<void>();
    const submit = vi
      .fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(oldSend.promise)
      .mockReturnValueOnce(newSend.promise);
    const initial = options({ submit });
    const { result, rerender } = renderHook(useChatConversation, { initialProps: initial });
    act(() => result.current.setDraft("Same text in both sessions"));
    let oldSending: Promise<void> | undefined;
    act(() => {
      oldSending = result.current.send();
    });
    rerender({ ...initial, sessionId: "session-b" });
    act(() => result.current.setDraft("Same text in both sessions"));
    let newSending: Promise<void> | undefined;
    act(() => {
      newSending = result.current.send();
    });
    await act(async () => {
      oldSend.resolve(undefined);
      await oldSending;
    });
    expect(result.current.draft).toBe("Same text in both sessions");
    expect(result.current.sending).toBe(true);
    await act(async () => {
      newSend.resolve(undefined);
      await newSending;
    });
    expect(result.current.draft).toBe("");
    expect(result.current.sending).toBe(false);
  });

  it("does not clear a newly selected thread's draft when the old submission completes", async () => {
    const pending = deferred<void>();
    const initial = options({ submit: vi.fn().mockReturnValue(pending.promise) });
    const { result, rerender } = renderHook(useChatConversation, { initialProps: initial });
    await act(async () => {});
    act(() => result.current.setDraft("Repeated draft"));
    let sending: Promise<void> | undefined;
    act(() => {
      sending = result.current.send();
    });
    rerender({
      ...initial,
      selectedThreadId: "thread-b",
      readCodexTranscript: vi.fn().mockResolvedValue(transcript("thread-b", "New thread")),
    });
    await act(async () => {});
    act(() => result.current.setDraft("Repeated draft"));
    await act(async () => {
      pending.resolve(undefined);
      await sending;
    });
    expect(result.current.draft).toBe("Repeated draft");
  });

  it("does not let an old send finish the new send after returning to the same session", async () => {
    const oldSend = deferred<void>();
    const newSend = deferred<void>();
    const submit = vi
      .fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(oldSend.promise)
      .mockReturnValueOnce(newSend.promise);
    const initial = options({ submit });
    const { result, rerender } = renderHook(useChatConversation, { initialProps: initial });
    act(() => result.current.setDraft("Earlier visit"));
    let oldSending: Promise<void> | undefined;
    act(() => {
      oldSending = result.current.send();
    });
    rerender({ ...initial, sessionId: "session-b" });
    rerender(initial);
    act(() => result.current.setDraft("New visit"));
    let newSending: Promise<void> | undefined;
    act(() => {
      newSending = result.current.send();
    });
    await act(async () => {
      oldSend.resolve(undefined);
      await oldSending;
    });
    expect(result.current.sending).toBe(true);
    expect(result.current.draft).toBe("New visit");
    await act(async () => {
      newSend.resolve(undefined);
      await newSending;
    });
    expect(result.current.sending).toBe(false);
  });

  it("preserves a draft typed in the new thread while its first transcript is loading", async () => {
    const nextRead = deferred<ChatTranscript>();
    const initial = options();
    const { result, rerender } = renderHook(useChatConversation, { initialProps: initial });
    await act(async () => {});
    rerender({
      ...initial,
      selectedThreadId: "thread-b",
      readCodexTranscript: vi.fn().mockReturnValue(nextRead.promise),
    });
    act(() => result.current.setDraft("A new thought for thread B"));
    await act(async () => nextRead.resolve(transcript("thread-b", "Thread B history")));
    expect(result.current.draft).toBe("A new thought for thread B");
  });

  it("does not show a previous thread's failed send as an error in the current thread", async () => {
    const pending = deferred<void>();
    const initial = options({ submit: vi.fn().mockReturnValue(pending.promise) });
    const { result, rerender } = renderHook(useChatConversation, { initialProps: initial });
    await act(async () => {});
    act(() => result.current.setDraft("For thread A"));
    let sending: Promise<void> | undefined;
    act(() => {
      sending = result.current.send();
    });
    rerender({
      ...initial,
      selectedThreadId: "thread-b",
      readCodexTranscript: vi.fn().mockResolvedValue(transcript("thread-b", "New thread")),
    });
    await act(async () => {});
    await act(async () => {
      pending.reject(new Error("Old submission failed"));
      await sending;
    });
    expect(result.current.error).toBeNull();
  });

  it("only submits once when send is requested twice before React rerenders", async () => {
    const pending = deferred<void>();
    const submit = vi.fn().mockReturnValue(pending.promise);
    const { result } = renderHook(useChatConversation, { initialProps: options({ submit }) });
    act(() => result.current.setDraft("Only once"));
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = result.current.send();
      second = result.current.send();
    });
    expect(submit).toHaveBeenCalledExactlyOnceWith("Only once");
    expect(result.current.sending).toBe(true);
    await act(async () => {
      pending.resolve(undefined);
      await Promise.all([first, second]);
    });
    expect(result.current.sending).toBe(false);
  });

  it.each([
    { enabled: false },
    { canSend: false },
  ])("does not submit when blocked: %j", async (gate) => {
    const initial = options(gate);
    const { result } = renderHook(useChatConversation, { initialProps: initial });
    act(() => result.current.setDraft("Still a draft"));
    await act(async () => result.current.send());
    expect(initial.submit).not.toHaveBeenCalled();
    expect(result.current.draft).toBe("Still a draft");
  });

  it("refreshes Claude text from authenticated hooks and catches up after re-enabling", async () => {
    const claudeStore = new ClaudeChatTranscriptStore();
    const initial = options({ agent: "claude", claudeStore });
    const { result, rerender } = renderHook(useChatConversation, { initialProps: initial });
    const ingest = (seq: number, event: string, text: string) => {
      claudeStore.ingestHook(
        JSON.stringify({
          agent: "claude",
          sessionId: "session-a",
          session_id: "claude-conversation",
          _yorishiro_seq: seq,
          event,
          ...(event === "prompt" ? { prompt: text } : { last_assistant_message: text }),
        }),
      );
    };
    expect(result.current.loading).toBe(false);
    act(() => ingest(1, "prompt", "A real prompt"));
    expect(result.current.transcript.messages[0]?.text).toBe("A real prompt");
    expect(result.current.transcript.working).toBe(true);
    act(() => ingest(2, "stop", "A real answer"));
    expect(result.current.transcript.messages.map((message) => message.text)).toEqual([
      "A real prompt",
      "A real answer",
    ]);
    expect(result.current.transcript.working).toBe(false);
    expect(initial.readCodexTranscript).not.toHaveBeenCalled();

    rerender({ ...initial, enabled: false });
    act(() => ingest(3, "prompt", "While chat is hidden"));
    expect(result.current.transcript.messages).toHaveLength(2);
    rerender(initial);
    expect(result.current.transcript.messages[2]?.text).toBe("While chat is hidden");
  });

  it("stops scheduling reads when disabled, resumes on demand, and stops on unmount", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockResolvedValue(transcript("thread-a", "Current"));
    const initial = options({ readCodexTranscript: read });
    const { rerender, unmount } = renderHook(useChatConversation, { initialProps: initial });
    await act(async () => {});
    expect(read).toHaveBeenCalledOnce();
    await act(async () => vi.advanceTimersByTimeAsync(800));
    expect(read.mock.calls.length).toBeGreaterThan(1);

    rerender({ ...initial, enabled: false });
    const pausedCount = read.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(read).toHaveBeenCalledTimes(pausedCount);
    rerender(initial);
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(pausedCount + 1);

    unmount();
    await act(async () => vi.advanceTimersByTimeAsync(5000));
    expect(read).toHaveBeenCalledTimes(pausedCount + 1);
  });

  it("does not restart polling if an in-flight read finishes after unmount", async () => {
    vi.useFakeTimers();
    const pending = deferred<ChatTranscript>();
    const read = vi.fn().mockReturnValue(pending.promise);
    const { unmount } = renderHook(useChatConversation, {
      initialProps: options({ readCodexTranscript: read }),
    });
    unmount();
    await act(async () => {
      pending.resolve(transcript("thread-a", "Too late"));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(read).toHaveBeenCalledOnce();
  });
});
