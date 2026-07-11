// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LoopReelPersistedMeta,
  LoopReelPersistenceController,
  LoopReelStore,
  SessionRecording,
} from "../runtime/loop-reel";
import { LoopReelPlayer } from "./LoopReelPlayer";

vi.mock("../runtime/loop-reel", async () => {
  const actual =
    await vi.importActual<typeof import("../runtime/loop-reel")>("../runtime/loop-reel");
  return {
    ...actual,
    createReplayTerminal: () => ({
      attachTo: vi.fn(),
      detachContainer: vi.fn(),
      loadStream: vi.fn(),
      play: vi.fn(),
      playWindow: vi.fn(),
      pause: vi.fn(),
      seekLinear: vi.fn(),
      onPosition: vi.fn(() => ({ dispose: vi.fn() })),
      setHidden: vi.fn(),
      dispose: vi.fn(),
    }),
    resolveReplayTerminalSurface: () => {
      const surface = document.createElement("div");
      surface.getBoundingClientRect = () =>
        ({
          left: 0,
          top: 0,
          width: 640,
          height: 360,
          right: 640,
          bottom: 360,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect;
      return surface;
    },
  };
});

const meta = (id: string, startedAt: number): LoopReelPersistedMeta => ({
  id,
  sessionId: "default-session",
  label: id,
  kind: "agent",
  origin: "lifecycle",
  startedAt,
  endedAt: startedAt + 100,
  status: "ended",
});

const recording = (item: LoopReelPersistedMeta): SessionRecording => ({
  ...item,
  entries: [
    { kind: "marker", marker: "session-start", label: item.label, timestamp: item.startedAt },
  ],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

function createStore() {
  const listeners = new Set<() => void>();
  const store = {
    listMetas: vi.fn(() => []),
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener);
      return {
        dispose: () => {
          listeners.delete(listener);
        },
      };
    }),
  } as unknown as LoopReelStore;
  return {
    store,
    emit: () => {
      for (const listener of Array.from(listeners)) listener();
    },
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("LoopReelPlayer refresh", () => {
  it("debounces subscribed refreshes and ignores stale list responses", async () => {
    vi.useFakeTimers();
    const { store, emit } = createStore();
    const stale = deferred<readonly LoopReelPersistedMeta[]>();
    const latest = deferred<readonly LoopReelPersistedMeta[]>();
    const persistence = {
      initialize: vi.fn(),
      flushAll: vi.fn(() => Promise.resolve()),
      listRecordings: vi
        .fn<LoopReelPersistenceController["listRecordings"]>()
        .mockResolvedValueOnce([meta("initial", 100)])
        .mockReturnValueOnce(stale.promise)
        .mockReturnValueOnce(latest.promise),
      loadRecording: vi.fn(async (id: string) => recording(meta(id, id === "latest" ? 300 : 100))),
      dispose: vi.fn(),
    } satisfies LoopReelPersistenceController;

    render(
      <LoopReelPlayer
        open
        store={store}
        persistence={persistence}
        recordingActive={false}
        onToggleRecording={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByRole("option", { name: /initial/ })).toBeTruthy();
    expect(persistence.flushAll).toHaveBeenCalledTimes(1);

    act(() => {
      emit();
      vi.advanceTimersByTime(300);
    });
    expect(persistence.listRecordings).toHaveBeenCalledTimes(2);

    act(() => {
      emit();
      vi.advanceTimersByTime(300);
    });
    expect(persistence.listRecordings).toHaveBeenCalledTimes(3);
    expect(persistence.flushAll).toHaveBeenCalledTimes(1);

    await act(async () => {
      latest.resolve([meta("latest", 300)]);
      await Promise.resolve();
    });
    expect(screen.getByRole("option", { name: /latest/ })).toBeTruthy();

    await act(async () => {
      stale.resolve([meta("stale", 200)]);
      await Promise.resolve();
    });
    expect(screen.queryByRole("option", { name: /stale/ })).toBeNull();
  });
});
