// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  LoopReelPersistedMeta,
  LoopReelPersistenceController,
  LoopReelStore,
  RecordedEntry,
  SessionRecording,
} from "../runtime/loop-reel";
import { LoopReelPlayer } from "./LoopReelPlayer";

const replayState = vi.hoisted(() => ({
  instances: [] as Array<{
    readonly attachTo: ReturnType<typeof vi.fn>;
    readonly detachContainer: ReturnType<typeof vi.fn>;
    readonly loadStream: ReturnType<typeof vi.fn>;
    readonly appendEntries: ReturnType<typeof vi.fn>;
    readonly play: ReturnType<typeof vi.fn>;
    readonly playWindow: ReturnType<typeof vi.fn>;
    readonly pause: ReturnType<typeof vi.fn>;
    readonly seekLinear: ReturnType<typeof vi.fn>;
    readonly onPosition: ReturnType<typeof vi.fn>;
    readonly setHidden: ReturnType<typeof vi.fn>;
    readonly dispose: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("../runtime/loop-reel", async () => {
  const actual =
    await vi.importActual<typeof import("../runtime/loop-reel")>("../runtime/loop-reel");
  return {
    ...actual,
    createReplayTerminal: () => {
      const replay = {
        attachTo: vi.fn(),
        detachContainer: vi.fn(),
        loadStream: vi.fn(),
        appendEntries: vi.fn(),
        play: vi.fn(),
        playWindow: vi.fn(),
        pause: vi.fn(),
        seekLinear: vi.fn(),
        onPosition: vi.fn(() => ({ dispose: vi.fn() })),
        setHidden: vi.fn(),
        dispose: vi.fn(),
      };
      replayState.instances.push(replay);
      return replay;
    },
    loadLoopReelRedactionSources: vi.fn(async () => ({
      username: "secret",
      homeBasename: null,
      hostname: null,
      gitUserName: null,
      gitUserEmail: null,
    })),
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

const meta = (
  id: string,
  startedAt: number,
  status: LoopReelPersistedMeta["status"] = "ended",
): LoopReelPersistedMeta => ({
  id,
  sessionId: "default-session",
  label: id,
  kind: "agent",
  origin: "lifecycle",
  startedAt,
  endedAt: status === "ended" ? startedAt + 100 : null,
  status,
});

const recording = (item: LoopReelPersistedMeta): SessionRecording => ({
  ...item,
  entries: [
    { kind: "marker", marker: "session-start", label: item.label, timestamp: item.startedAt },
    { kind: "pty", text: "initial\n", timestamp: item.startedAt + 50 },
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
  const recordingSubscribers = new Set<{
    readonly onEntriesAppended?: (event: {
      readonly recordingId: string;
      readonly meta: LoopReelPersistedMeta;
      readonly entries: readonly RecordedEntry[];
    }) => void;
  }>();
  const store = {
    listMetas: vi.fn(() => []),
    subscribeRecordingEvents: vi.fn((callbacks) => {
      recordingSubscribers.add(callbacks);
      return {
        dispose: () => {
          recordingSubscribers.delete(callbacks);
        },
      };
    }),
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
    emitEntries: (
      recordingId: string,
      item: LoopReelPersistedMeta,
      entries: readonly RecordedEntry[],
    ) => {
      for (const subscriber of Array.from(recordingSubscribers)) {
        subscriber.onEntriesAppended?.({ recordingId, meta: item, entries });
      }
    },
  };
}

afterEach(() => {
  cleanup();
  replayState.instances.length = 0;
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
      flushRecording: vi.fn(() => Promise.resolve()),
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

  it("keeps running recordings selectable for catch-up", async () => {
    const { store } = createStore();
    const persistence = {
      initialize: vi.fn(),
      flushAll: vi.fn(() => Promise.resolve()),
      flushRecording: vi.fn(() => Promise.resolve()),
      listRecordings: vi.fn(async () => [meta("active", 300, "recording")]),
      loadRecording: vi.fn(async (id: string) => recording(meta(id, 300, "recording"))),
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

    const option = screen.getByRole("option", { name: /active.*録画中/ }) as HTMLOptionElement;
    expect(option.disabled).toBe(false);
    expect(persistence.flushRecording).toHaveBeenCalledWith("active");
  });

  it("keeps playing when speed changes during playback", async () => {
    const { store } = createStore();
    const persistence = {
      initialize: vi.fn(),
      flushAll: vi.fn(() => Promise.resolve()),
      flushRecording: vi.fn(() => Promise.resolve()),
      listRecordings: vi.fn(async () => [meta("ended", 100)]),
      loadRecording: vi.fn(async (id: string) => recording(meta(id, 100))),
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

    fireEvent.click(screen.getByRole("button", { name: "Play Loop Reel" }));
    expect(screen.getByRole("button", { name: "Pause Loop Reel" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "2x" }));

    expect(screen.getByRole("button", { name: "Pause Loop Reel" })).toBeTruthy();
    expect(replayState.instances[0].playWindow).toHaveBeenLastCalledWith(
      expect.any(Number),
      expect.any(Number),
      2,
      expect.any(Function),
    );
  });

  it("coalesces live tail state while appending RAW replay entries immediately", async () => {
    vi.useFakeTimers();
    const active = meta("active", 100, "recording");
    const { store, emitEntries } = createStore();
    const persistence = {
      initialize: vi.fn(),
      flushAll: vi.fn(() => Promise.resolve()),
      flushRecording: vi.fn(() => Promise.resolve()),
      listRecordings: vi.fn(async () => [active]),
      loadRecording: vi.fn(async () => recording(active)),
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
    const replay = replayState.instances[0];

    act(() => {
      emitEntries("active", active, [
        { kind: "marker", marker: "command-failed", label: "first fail", timestamp: 180 },
      ]);
      emitEntries("active", active, [
        { kind: "marker", marker: "command-failed", label: "second fail", timestamp: 190 },
      ]);
    });

    expect(replay.appendEntries).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: "Jump to first fail" })).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(screen.getByRole("button", { name: "Jump to first fail" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Jump to second fail" })).toBeTruthy();
  });

  it("reloads the full stream for MASKED live tail instead of appending chunks", async () => {
    vi.useFakeTimers();
    const active = meta("active", 100, "recording");
    const { store, emitEntries } = createStore();
    const persistence = {
      initialize: vi.fn(),
      flushAll: vi.fn(() => Promise.resolve()),
      flushRecording: vi.fn(() => Promise.resolve()),
      listRecordings: vi.fn(async () => [active]),
      loadRecording: vi.fn(async () => recording(active)),
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
    const replay = replayState.instances[0];
    replay.loadStream.mockClear();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Toggle Loop Reel mask" }));
      await Promise.resolve();
    });
    replay.loadStream.mockClear();

    act(() => {
      emitEntries("active", active, [{ kind: "pty", text: "sec", timestamp: 180 }]);
      emitEntries("active", active, [{ kind: "pty", text: "ret\n", timestamp: 190 }]);
    });

    expect(replay.appendEntries).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(replay.loadStream).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(replay.loadStream).toHaveBeenCalledTimes(1);
    expect(replay.seekLinear).toHaveBeenCalled();
  });
});
