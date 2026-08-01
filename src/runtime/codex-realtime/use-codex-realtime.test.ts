// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LipSyncSource } from "../../core/body";
import type { MouthValues } from "../../core/voice/mouth-values";
import type { CodexRealtimeState } from "./codex-realtime-client";
import {
  type CodexRealtimeClientFactory,
  type CodexRealtimeClientLike,
  useCodexRealtime,
} from "./use-codex-realtime";

const ZERO_MOUTH: MouthValues = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
} {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

class FakeClient implements CodexRealtimeClientLike {
  readonly stop = vi.fn(() => this.emit({ status: "idle" }));
  private status: CodexRealtimeState["status"] = "idle";

  constructor(
    private readonly onStateChange: (state: CodexRealtimeState) => void,
    private readonly startResult: Promise<void>,
    private readonly getPreferredThreadId: () => string | null,
    private readonly getVoice: () => string | Promise<string>,
  ) {}

  preferredThreadIdAtStart: string | null = null;

  getStatus(): CodexRealtimeState["status"] {
    return this.status;
  }

  readonly start = vi.fn(async (): Promise<void> => {
    this.preferredThreadIdAtStart = this.getPreferredThreadId();
    this.emit({ status: "connecting" });
    this.voiceAtStart = await this.getVoice();
    await this.startResult;
  });

  voiceAtStart: string | null = null;

  sampleMouth(out?: MouthValues): MouthValues {
    return out ?? { ...ZERO_MOUTH };
  }

  emit(state: CodexRealtimeState): void {
    this.status = state.status;
    this.onStateChange(state);
  }
}

function setup(
  starts: Promise<void>[],
  setFallbackPlaybackEnabled: (enabled: boolean) => void | Promise<void> = vi.fn(),
  getVoice: () => string | Promise<string> = () => "sol",
) {
  const clients: FakeClient[] = [];
  let trackedThreadId: string | null = "thread-1";
  let notifyThreadChange: (threadId: string | null) => void = () => {};
  const createClient: CodexRealtimeClientFactory = (
    _sessionId,
    onStateChange,
    _stateExpressionCallbacks,
    getPreferredThreadId = () => null,
    getVoiceForClient = () => "sol",
  ) => {
    const startResult = starts[clients.length] ?? Promise.resolve();
    const client = new FakeClient(
      onStateChange,
      startResult,
      getPreferredThreadId,
      getVoiceForClient,
    );
    clients.push(client);
    return client;
  };
  const fallback: LipSyncSource = { sampleMouth: () => ({ ...ZERO_MOUTH }) };
  const applyLipSyncSource = vi.fn<(source: LipSyncSource) => void>();
  const hook = renderHook(
    ({ sessionId, available }) =>
      useCodexRealtime({
        sessionId,
        available,
        fallbackLipSyncSource: fallback,
        applyLipSyncSource,
        setFallbackPlaybackEnabled,
        getVoice,
        createClient,
        createThreadTracker: (_sessionId, onCurrentThreadChange) => {
          notifyThreadChange = onCurrentThreadChange;
          return {
            getCurrentThreadId: () => trackedThreadId,
            start: async () => {},
            stop: () => {},
          };
        },
      }),
    { initialProps: { sessionId: "main", available: true } },
  );
  return {
    ...hook,
    clients,
    fallback,
    applyLipSyncSource,
    setFallbackPlaybackEnabled,
    changeThread: (threadId: string | null) => {
      trackedThreadId = threadId;
      notifyThreadChange(threadId);
    },
  };
}

describe("useCodexRealtime", () => {
  it("reads the configured voice for each new realtime session", async () => {
    let voice = "marin";
    const { result, clients } = setup(
      [Promise.resolve(), Promise.resolve()],
      undefined,
      () => voice,
    );

    await act(async () => result.current.toggle());
    act(() => clients[0].emit({ status: "idle" }));
    voice = "cedar";
    await act(async () => result.current.toggle());

    expect(clients.map((client) => client.voiceAtStart)).toEqual(["marin", "cedar"]);
  });

  it("mount 時に Rust 側 ownership provenance を fallback へ同期する", () => {
    const { setFallbackPlaybackEnabled } = setup([]);

    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);
  });

  it("connecting から GPT Live が audio を所有し、remote close 後に fallback を戻す", async () => {
    const start = deferred();
    const { result, clients, setFallbackPlaybackEnabled } = setup([start.promise]);

    act(() => {
      void result.current.toggle();
    });
    expect(result.current.state.status).toBe("connecting");
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(false);

    act(() => {
      clients[0].emit({ status: "active", billing: "subscription" });
    });
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(false);

    act(() => {
      clients[0].emit({ status: "idle" });
    });
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);
  });

  it("ownership provenance の claim 完了前には client を開始しない", async () => {
    const ownershipClaim = deferred();
    const setFallbackPlaybackEnabled = vi.fn((enabled: boolean) =>
      enabled ? undefined : ownershipClaim.promise,
    );
    const { result, clients } = setup([Promise.resolve()], setFallbackPlaybackEnabled);

    let toggle: Promise<void> = Promise.resolve();
    act(() => {
      toggle = result.current.toggle();
    });
    expect(clients[0].start).not.toHaveBeenCalled();

    await act(async () => {
      ownershipClaim.resolve();
      await toggle;
    });

    expect(clients[0].start).toHaveBeenCalledTimes(1);
  });

  it("ownership provenance の claim 待機中に stop した client は後から開始しない", async () => {
    const ownershipClaim = deferred();
    const setFallbackPlaybackEnabled = vi.fn((enabled: boolean) =>
      enabled ? undefined : ownershipClaim.promise,
    );
    const { result, clients } = setup([Promise.resolve()], setFallbackPlaybackEnabled);

    let toggle: Promise<void> = Promise.resolve();
    act(() => {
      toggle = result.current.toggle();
      result.current.stop();
    });
    await act(async () => {
      ownershipClaim.resolve();
      await toggle;
    });

    expect(clients[0].start).not.toHaveBeenCalled();
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);
  });

  it("connecting中のsession切替後にstartが失敗してもidleをerrorで上書きしない", async () => {
    const start = deferred();
    const { result, rerender, clients, fallback, applyLipSyncSource, setFallbackPlaybackEnabled } =
      setup([start.promise]);

    act(() => {
      void result.current.toggle();
    });
    expect(result.current.state.status).toBe("connecting");

    rerender({ sessionId: "other", available: false });
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ status: "idle" });
    expect(applyLipSyncSource).toHaveBeenLastCalledWith(fallback);
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);

    await act(async () => {
      start.reject(new Error("stale start failure"));
      await start.promise.catch(() => {});
    });

    expect(result.current.state).toEqual({ status: "idle" });
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
  });

  it("current start failure 後に fallback playback を戻す", async () => {
    const start = deferred();
    const { result, clients, setFallbackPlaybackEnabled } = setup([start.promise]);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    let toggle: Promise<void> = Promise.resolve();
    act(() => {
      toggle = result.current.toggle();
    });
    await act(async () => {
      start.reject(new Error("start failed"));
      await toggle;
    });

    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ status: "error", error: "start failed" });
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);
    consoleError.mockRestore();
  });

  it("remote closedのidleで所有権を解放し、次の1クリックで再接続する", async () => {
    const firstStart = deferred();
    const { result, clients, fallback, applyLipSyncSource } = setup([
      firstStart.promise,
      Promise.resolve(),
    ]);

    act(() => {
      void result.current.toggle();
    });
    act(() => {
      clients[0].emit({ status: "idle" });
      // remote closed 後にUI側のstopが競合しても、解放済みclientを再停止しない。
      result.current.stop();
    });
    expect(clients[0].stop).not.toHaveBeenCalled();
    expect(result.current.getLipSyncSource()).toBe(fallback);

    await act(async () => {
      await result.current.toggle();
    });
    expect(clients).toHaveLength(2);
    act(() => {
      clients[1].emit({ status: "active", billing: "subscription" });
      clients[0].emit({ status: "error", error: "stale closed client" });
    });

    expect(result.current.state).toEqual({ status: "active", billing: "subscription" });
    expect(result.current.getLipSyncSource()).toBe(clients[1]);
    expect(applyLipSyncSource).toHaveBeenLastCalledWith(clients[1]);

    await act(async () => {
      firstStart.reject(new Error("closed start rejected"));
      await firstStart.promise.catch(() => {});
    });
    expect(result.current.state.status).toBe("active");
  });

  it("/clear または /resume で current thread が変わると active voice を再接続する", async () => {
    const { result, clients, changeThread } = setup([Promise.resolve(), Promise.resolve()]);

    await act(async () => {
      await result.current.toggle();
    });
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));

    await act(async () => {
      changeThread("thread-2");
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });

    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients[1].start).toHaveBeenCalledTimes(1);
    expect(clients[1].preferredThreadIdAtStart).toBe("thread-2");
  });

  it("current thread を特定できなくなった場合は active voice を切断する", async () => {
    const { result, clients, changeThread } = setup([Promise.resolve()]);

    await act(async () => {
      await result.current.toggle();
    });
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));
    act(() => changeThread(null));

    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(1);
    expect(result.current.state).toEqual({ status: "idle" });
  });

  it("明示stopを先に所有権解除し、後着のclosed/error通知をidleへ戻さない", async () => {
    const { result, clients, fallback, applyLipSyncSource, setFallbackPlaybackEnabled } = setup([
      Promise.resolve(),
    ]);

    await act(async () => {
      await result.current.toggle();
    });
    act(() => {
      clients[0].emit({ status: "active", billing: "subscription" });
      result.current.stop();
      clients[0].emit({ status: "error", error: "late error" });
      clients[0].emit({ status: "idle" });
    });

    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ status: "idle" });
    expect(result.current.getLipSyncSource()).toBe(fallback);
    expect(applyLipSyncSource).toHaveBeenLastCalledWith(fallback);
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);
  });

  it("error後にsessionを切り替えると旧sessionのerrorをidleへ戻す", async () => {
    const { result, rerender, clients, fallback, applyLipSyncSource, setFallbackPlaybackEnabled } =
      setup([Promise.resolve()]);

    await act(async () => {
      await result.current.toggle();
    });
    act(() => {
      clients[0].emit({ status: "error", error: "old session failed" });
    });
    expect(result.current.state).toEqual({ status: "error", error: "old session failed" });

    rerender({ sessionId: "other", available: false });

    expect(result.current.state).toEqual({ status: "idle" });
    expect(applyLipSyncSource).toHaveBeenLastCalledWith(fallback);
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);
  });

  it("unmount 中に client を止めて fallback playback を戻す", async () => {
    const { result, clients, unmount, setFallbackPlaybackEnabled } = setup([Promise.resolve()]);

    await act(async () => {
      await result.current.toggle();
    });
    act(() => {
      clients[0].emit({ status: "active", billing: "subscription" });
    });

    unmount();

    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);
  });

  it.each([
    "stop",
    "error",
    "remote-close",
    "session-switch",
  ] as const)("%s path retries a rejected fallback ownership restore", async (path) => {
    vi.useFakeTimers();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let rustFallbackEnabled = true;
    let rejectNextRestore = false;
    const setFallbackPlaybackEnabled = vi.fn(async (enabled: boolean) => {
      if (enabled && rejectNextRestore) {
        rejectNextRestore = false;
        throw new Error("transient restore IPC failure");
      }
      rustFallbackEnabled = enabled;
    });

    try {
      const { result, clients, rerender, unmount } = setup(
        [Promise.resolve()],
        setFallbackPlaybackEnabled,
      );
      await act(async () => {
        await result.current.toggle();
      });
      act(() => {
        clients[0].emit({ status: "active", billing: "subscription" });
      });
      expect(rustFallbackEnabled).toBe(false);
      rejectNextRestore = true;

      if (path === "stop") {
        act(() => result.current.stop());
      } else if (path === "error") {
        act(() => clients[0].emit({ status: "error", error: "connection failed" }));
      } else if (path === "remote-close") {
        act(() => clients[0].emit({ status: "idle" }));
      } else {
        rerender({ sessionId: "other", available: false });
      }

      await act(async () => {
        await Promise.resolve();
        await vi.runAllTimersAsync();
      });

      expect(rustFallbackEnabled).toBe(true);
      expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true);
      expect(setFallbackPlaybackEnabled.mock.calls.filter(([enabled]) => enabled)).toHaveLength(3);
      unmount();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });
});
