// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LipSyncSource } from "../../core/body";
import type { MouthValues } from "../../core/voice/mouth-values";
import type {
  CodexRealtimePersonaApplication,
  CodexRealtimePersonaSnapshot,
  CodexRealtimeState,
  CodexRealtimeVoiceFallback,
} from "./codex-realtime-client";
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
    readonly sessionId: string,
    private readonly onStateChange: (state: CodexRealtimeState) => void,
    private readonly startResult: Promise<void>,
    private readonly getPreferredThreadId: () => string | null,
    private readonly getVoice: () => string | Promise<string>,
    readonly getVoiceCandidates?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>,
    readonly onVoiceFallback?: (fallback: CodexRealtimeVoiceFallback) => void,
    private readonly getPersonaSnapshot?: () =>
      | CodexRealtimePersonaSnapshot
      | Promise<CodexRealtimePersonaSnapshot>,
    readonly onPersonaApplication?: (application: CodexRealtimePersonaApplication) => void,
  ) {}

  preferredThreadIdAtStart: string | null = null;

  getStatus(): CodexRealtimeState["status"] {
    return this.status;
  }

  readonly start = vi.fn(async (): Promise<void> => {
    this.preferredThreadIdAtStart = this.getPreferredThreadId();
    this.emit({ status: "connecting" });
    this.voiceCandidatesAtStart = this.getVoiceCandidates
      ? [...(await this.getVoiceCandidates())]
      : null;
    this.voiceAtStart = this.voiceCandidatesAtStart?.[0] ?? (await this.getVoice());
    this.personaSnapshotAtStart = this.getPersonaSnapshot ? await this.getPersonaSnapshot() : null;
    await this.startResult;
  });

  voiceAtStart: string | null = null;
  voiceCandidatesAtStart: ReadonlyArray<string> | null = null;
  personaSnapshotAtStart: CodexRealtimePersonaSnapshot | null = null;

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
  options: {
    readonly getVoiceCandidates?: () => ReadonlyArray<string> | Promise<ReadonlyArray<string>>;
    readonly onVoiceFallback?: (fallback: CodexRealtimeVoiceFallback) => void;
    readonly getPersonaSnapshot?: () =>
      | CodexRealtimePersonaSnapshot
      | Promise<CodexRealtimePersonaSnapshot>;
    readonly onPersonaApplication?: (application: CodexRealtimePersonaApplication) => void;
  } = {},
) {
  const clients: FakeClient[] = [];
  let trackedThreadId: string | null = "thread-1";
  let notifyThreadChange: (threadId: string | null) => void = () => {};
  const createClient: CodexRealtimeClientFactory = (
    sessionId,
    onStateChange,
    _stateExpressionCallbacks,
    getPreferredThreadId = () => null,
    getVoiceForClient = () => "sol",
    getVoiceCandidatesForClient,
    onVoiceFallbackForClient,
    getPersonaSnapshotForClient,
    onPersonaApplicationForClient,
  ) => {
    const startResult = starts[clients.length] ?? Promise.resolve();
    const client = new FakeClient(
      sessionId,
      onStateChange,
      startResult,
      getPreferredThreadId,
      getVoiceForClient,
      getVoiceCandidatesForClient,
      onVoiceFallbackForClient,
      getPersonaSnapshotForClient,
      onPersonaApplicationForClient,
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
        getVoiceCandidates: options.getVoiceCandidates,
        onVoiceFallback: options.onVoiceFallback,
        getPersonaSnapshot: options.getPersonaSnapshot,
        onPersonaApplication: options.onPersonaApplication,
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
    setTrackedThreadId: (threadId: string | null) => {
      trackedThreadId = threadId;
    },
  };
}

describe("useCodexRealtime", () => {
  it("reads the configured voice for each new realtime session", async () => {
    let voice = "juniper";
    const { result, clients } = setup(
      [Promise.resolve(), Promise.resolve()],
      undefined,
      () => voice,
    );

    await act(async () => result.current.toggle());
    act(() => clients[0].emit({ status: "idle" }));
    voice = "maple";
    await act(async () => result.current.toggle());

    expect(clients.map((client) => client.voiceAtStart)).toEqual(["juniper", "maple"]);
  });

  it("re-reads persona voice candidates when a new session starts after a persona switch", async () => {
    // persona A → B：切替で session が作り直されると候補列が読み直される。
    let candidates: ReadonlyArray<string> = ["maple", "juniper", "sol"];
    const { result, clients } = setup(
      [Promise.resolve(), Promise.resolve()],
      undefined,
      undefined,
      {
        getVoiceCandidates: () => candidates,
      },
    );

    await act(async () => result.current.toggle());
    act(() => clients[0].emit({ status: "idle" }));
    candidates = ["vale", "juniper", "sol"];
    await act(async () => result.current.toggle());

    expect(clients.map((client) => client.voiceCandidatesAtStart)).toEqual([
      ["maple", "juniper", "sol"],
      ["vale", "juniper", "sol"],
    ]);
  });

  it("snapshots the active persona again after thread and workspace switches", async () => {
    let snapshot: CodexRealtimePersonaSnapshot = {
      personaId: "persona-a",
      instructions: "instructions A",
    };
    const { result, rerender, clients, changeThread } = setup(
      [Promise.resolve(), Promise.resolve(), Promise.resolve()],
      undefined,
      undefined,
      { getPersonaSnapshot: () => snapshot },
    );

    await act(async () => result.current.toggle());
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));

    // A running session owns its original immutable snapshot.
    snapshot = { personaId: "persona-b", instructions: "instructions B" };
    expect(clients[0].personaSnapshotAtStart?.personaId).toBe("persona-a");

    await act(async () => {
      changeThread("thread-2");
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });
    expect(clients[1].personaSnapshotAtStart).toEqual(snapshot);
    act(() => clients[1].emit({ status: "active", billing: "subscription" }));

    snapshot = { personaId: "persona-c", instructions: "instructions C" };
    rerender({ sessionId: "workspace-2-main", available: true });
    await act(async () => {
      await vi.waitFor(() => expect(clients).toHaveLength(3));
    });
    expect(clients[2].sessionId).toBe("workspace-2-main");
    expect(clients[2].personaSnapshotAtStart).toEqual(snapshot);
  });

  it("keeps the active session's voice when candidates change mid-session", async () => {
    // 接続中の切替境界：active な session は影響を受けず、反映は次 session から。
    let candidates: ReadonlyArray<string> = ["maple"];
    const { result, clients, changeThread } = setup(
      [Promise.resolve(), Promise.resolve()],
      undefined,
      undefined,
      { getVoiceCandidates: () => candidates },
    );

    await act(async () => result.current.toggle());
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));
    candidates = ["vale"];

    // 候補が変わっても active session は再起動されず、start は 1 回のまま。
    expect(clients).toHaveLength(1);
    expect(clients[0].start).toHaveBeenCalledTimes(1);
    expect(clients[0].voiceCandidatesAtStart).toEqual(["maple"]);

    // /clear 等で thread が変わると次 session が新しい候補で始まる。
    await act(async () => {
      changeThread("thread-2");
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });
    expect(clients[1].voiceCandidatesAtStart).toEqual(["vale"]);
  });

  it("re-reads voice candidates when voice follows a workspace session switch", async () => {
    let candidates: ReadonlyArray<string> = ["maple"];
    const { result, rerender, clients } = setup(
      [Promise.resolve(), Promise.resolve()],
      undefined,
      undefined,
      { getVoiceCandidates: () => candidates },
    );

    await act(async () => result.current.toggle());
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));
    candidates = ["vale"];

    rerender({ sessionId: "workspace-2-main", available: true });
    await act(async () => {
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });

    expect(clients[1].sessionId).toBe("workspace-2-main");
    expect(clients[1].voiceCandidatesAtStart).toEqual(["vale"]);
  });

  it("forwards voice fallback diagnostics from the client to the option callback", async () => {
    const fallbacks: CodexRealtimeVoiceFallback[] = [];
    const { result, clients } = setup([Promise.resolve()], undefined, undefined, {
      getVoiceCandidates: () => ["maple", "sol"],
      onVoiceFallback: (fallback) => fallbacks.push(fallback),
    });

    await act(async () => result.current.toggle());
    clients[0].onVoiceFallback?.({
      fromVoice: "maple",
      toVoice: "sol",
      reason: "Invalid voice: maple",
    });

    expect(fallbacks).toEqual([
      { fromVoice: "maple", toVoice: "sol", reason: "Invalid voice: maple" },
    ]);
  });

  it("mount 時に Rust 側 ownership provenance を fallback へ同期する", async () => {
    const { setFallbackPlaybackEnabled } = setup([]);

    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true));
  });

  it("connecting から GPT Live が audio を所有し、remote close 後に fallback を戻す", async () => {
    const start = deferred();
    const { result, clients, setFallbackPlaybackEnabled } = setup([start.promise]);

    act(() => {
      void result.current.toggle();
    });
    expect(result.current.state.status).toBe("connecting");
    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(false));

    act(() => {
      clients[0].emit({ status: "active", billing: "subscription" });
    });
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(false);

    act(() => {
      clients[0].emit({ status: "idle" });
    });
    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true));
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
    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true));

    await act(async () => {
      start.reject(new Error("stale start failure"));
      await start.promise.catch(() => {});
    });

    expect(result.current.state).toEqual({ status: "idle" });
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
  });

  it("active voice intentを保持して新しいworkspace sessionへ再接続する", async () => {
    const { result, rerender, clients, setFallbackPlaybackEnabled } = setup([
      Promise.resolve(),
      Promise.resolve(),
    ]);
    await act(async () => {
      await result.current.toggle();
    });
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));

    rerender({ sessionId: "workspace-2-main", available: true });
    await act(async () => {
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });

    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients[1].sessionId).toBe("workspace-2-main");
    expect(clients[1].start).toHaveBeenCalledTimes(1);
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(false);
  });

  it("waits for the new workspace tracker before reconnecting voice", async () => {
    const { result, rerender, clients, setTrackedThreadId, changeThread } = setup([
      Promise.resolve(),
      Promise.resolve(),
    ]);
    await act(async () => {
      await result.current.toggle();
    });
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));

    setTrackedThreadId(null);
    rerender({ sessionId: "workspace-2-main", available: true });
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(1);

    await act(async () => {
      changeThread("workspace-2-thread");
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });
    expect(clients[1].sessionId).toBe("workspace-2-main");
    expect(clients[1].preferredThreadIdAtStart).toBe("workspace-2-thread");
  });

  it("reconnects when a tracker recovers from null while voice intent remains active", async () => {
    const { result, clients, changeThread } = setup([Promise.resolve(), Promise.resolve()]);
    await act(async () => {
      await result.current.toggle();
    });
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));

    act(() => changeThread(null));
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(1);

    await act(async () => {
      changeThread("recovered-thread");
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });
    expect(clients[1].start).toHaveBeenCalledTimes(1);
    expect(clients[1].preferredThreadIdAtStart).toBe("recovered-thread");
  });

  it("unsupported destination releases audio ownership but preserves intent for the next supported workspace", async () => {
    const { result, rerender, clients, setFallbackPlaybackEnabled } = setup([
      Promise.resolve(),
      Promise.resolve(),
    ]);
    await act(async () => {
      await result.current.toggle();
    });
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));

    rerender({ sessionId: "claude-workspace", available: false });
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true));
    expect(clients).toHaveLength(1);

    rerender({ sessionId: "codex-workspace", available: true });
    await act(async () => {
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });
    expect(clients[1].sessionId).toBe("codex-workspace");
    expect(clients[1].start).toHaveBeenCalledTimes(1);
  });

  it("serializes fallback restore and the next voice claim when IPC completes out of order", async () => {
    let rustFallbackEnabled = true;
    let delayedRestore: ReturnType<typeof deferred> | null = null;
    const setFallbackPlaybackEnabled = vi.fn((enabled: boolean): void | Promise<void> => {
      if (enabled && delayedRestore) {
        const pending = delayedRestore;
        delayedRestore = null;
        return pending.promise.then(() => {
          rustFallbackEnabled = true;
        });
      }
      rustFallbackEnabled = enabled;
    });
    const { result, rerender, clients } = setup(
      [Promise.resolve(), Promise.resolve()],
      setFallbackPlaybackEnabled,
    );
    await act(async () => {
      await result.current.toggle();
    });
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));
    expect(rustFallbackEnabled).toBe(false);

    const restore = deferred();
    delayedRestore = restore;
    rerender({ sessionId: "unsupported-workspace", available: false });
    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true));
    rerender({ sessionId: "workspace-2-main", available: true });
    await vi.waitFor(() => expect(clients).toHaveLength(2));
    expect(clients).toHaveLength(2);
    expect(clients[1].start).not.toHaveBeenCalled();

    await act(async () => {
      restore.resolve();
      await vi.waitFor(() => expect(clients[1].start).toHaveBeenCalledTimes(1));
    });
    expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(false);
    expect(rustFallbackEnabled).toBe(false);
  });

  it("explicit stop clears intent so a later workspace switch does not reconnect", async () => {
    const { result, rerender, clients } = setup([Promise.resolve()]);
    await act(async () => {
      await result.current.toggle();
    });
    act(() => {
      clients[0].emit({ status: "active", billing: "subscription" });
      result.current.stop();
    });

    rerender({ sessionId: "workspace-2-main", available: true });

    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients).toHaveLength(1);
  });

  it("rapid successive session changes leave only the latest client authoritative", async () => {
    const first = deferred();
    const second = deferred();
    const { result, rerender, clients } = setup([first.promise, second.promise, Promise.resolve()]);
    act(() => {
      void result.current.toggle();
    });
    expect(clients[0].sessionId).toBe("main");

    rerender({ sessionId: "workspace-2-main", available: true });
    await act(async () => {
      await vi.waitFor(() => expect(clients).toHaveLength(2));
    });
    rerender({ sessionId: "workspace-3-main", available: true });
    await act(async () => {
      await vi.waitFor(() => expect(clients).toHaveLength(3));
    });

    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(clients[1].stop).toHaveBeenCalledTimes(1);
    expect(clients[2].sessionId).toBe("workspace-3-main");
    act(() => clients[2].emit({ status: "active", billing: "subscription" }));
    await act(async () => {
      first.reject(new Error("stale first start"));
      second.reject(new Error("stale second start"));
      await Promise.all([first.promise.catch(() => {}), second.promise.catch(() => {})]);
    });
    expect(result.current.state).toEqual({ status: "active", billing: "subscription" });
  });

  it("preserves auto-retarget intent after a transient start failure", async () => {
    const failedRetarget = deferred();
    const { result, rerender, clients } = setup([
      Promise.resolve(),
      failedRetarget.promise,
      Promise.resolve(),
    ]);
    await act(async () => {
      await result.current.toggle();
    });
    act(() => clients[0].emit({ status: "active", billing: "subscription" }));

    rerender({ sessionId: "workspace-2-main", available: true });
    await act(async () => {
      await vi.waitFor(() => expect(clients).toHaveLength(2));
      failedRetarget.reject(new Error("temporary retarget failure"));
      await failedRetarget.promise.catch(() => {});
    });
    expect(result.current.state).toEqual({
      status: "error",
      error: "temporary retarget failure",
    });

    rerender({ sessionId: "workspace-3-main", available: true });
    await act(async () => {
      await vi.waitFor(() => expect(clients).toHaveLength(3));
    });
    expect(clients[2].sessionId).toBe("workspace-3-main");
    expect(clients[2].start).toHaveBeenCalledTimes(1);
  });

  it("current start failure 後に fallback playback を戻す", async () => {
    const start = deferred();
    const { result, rerender, clients, setFallbackPlaybackEnabled } = setup([start.promise]);
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
    rerender({ sessionId: "workspace-after-manual-failure", available: true });
    expect(clients).toHaveLength(1);
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
    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true));
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
    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true));
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
    await vi.waitFor(() => expect(setFallbackPlaybackEnabled).toHaveBeenLastCalledWith(true));
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
      expect(
        setFallbackPlaybackEnabled.mock.calls.filter(([enabled]) => enabled).length,
      ).toBeGreaterThanOrEqual(2);
      unmount();
    } finally {
      consoleError.mockRestore();
      vi.useRealTimers();
    }
  });
});
