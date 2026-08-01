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
  ) {}

  getStatus(): CodexRealtimeState["status"] {
    return this.status;
  }

  start(): Promise<void> {
    this.emit({ status: "connecting" });
    return this.startResult;
  }

  sampleMouth(out?: MouthValues): MouthValues {
    return out ?? { ...ZERO_MOUTH };
  }

  emit(state: CodexRealtimeState): void {
    this.status = state.status;
    this.onStateChange(state);
  }
}

function setup(starts: Promise<void>[]) {
  const clients: FakeClient[] = [];
  const createClient: CodexRealtimeClientFactory = (_sessionId, onStateChange) => {
    const startResult = starts[clients.length] ?? Promise.resolve();
    const client = new FakeClient(onStateChange, startResult);
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
        createClient,
      }),
    { initialProps: { sessionId: "main", available: true } },
  );
  return { ...hook, clients, fallback, applyLipSyncSource };
}

describe("useCodexRealtime", () => {
  it("connecting中のsession切替後にstartが失敗してもidleをerrorで上書きしない", async () => {
    const start = deferred();
    const { result, rerender, clients, fallback, applyLipSyncSource } = setup([start.promise]);

    act(() => {
      void result.current.toggle();
    });
    expect(result.current.state.status).toBe("connecting");

    rerender({ sessionId: "other", available: false });
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual({ status: "idle" });
    expect(applyLipSyncSource).toHaveBeenLastCalledWith(fallback);

    await act(async () => {
      start.reject(new Error("stale start failure"));
      await start.promise.catch(() => {});
    });

    expect(result.current.state).toEqual({ status: "idle" });
    expect(clients[0].stop).toHaveBeenCalledTimes(1);
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

  it("明示stopを先に所有権解除し、後着のclosed/error通知をidleへ戻さない", async () => {
    const { result, clients, fallback, applyLipSyncSource } = setup([Promise.resolve()]);

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
  });

  it("error後にsessionを切り替えると旧sessionのerrorをidleへ戻す", async () => {
    const { result, rerender, clients, fallback, applyLipSyncSource } = setup([Promise.resolve()]);

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
  });
});
