import { describe, expect, it, vi } from "vitest";
import {
  AUXILIARY_CONTROLS_LABEL,
  createAuxiliarySnapshotPublisher,
  createScreenSharingSnapshot,
  latestAuxiliarySnapshot,
  type RoutedAuxiliaryAction,
  resolveWindowView,
  ScreenSharingAuxiliaryHost,
  type ScreenSharingAuxiliaryModel,
  type ScreenSharingSnapshot,
} from "./auxiliary-windows";

function model(): ScreenSharingAuxiliaryModel {
  return {
    ownerKey: "private-session-and-thread",
    available: true,
    active: false,
    busy: false,
    pointersEnabled: true,
    pointersReady: true,
    sources: [
      { id: 1, name: "Display 1" },
      { id: 2, name: "Display 2" },
    ],
    sourceId: 1,
    intervalSeconds: 30,
    language: "ja-JP",
    start: vi.fn(async () => {}),
    stop: vi.fn(),
    refreshSources: vi.fn(async () => {}),
    clearAnnotations: vi.fn(async () => {}),
    setPointersEnabled: vi.fn(async () => {}),
    retryPointers: vi.fn(async () => {}),
    setSourceId: vi.fn(),
    setIntervalSeconds: vi.fn(),
  };
}

function transport() {
  let revision = 0;
  const unlisten = vi.fn();
  return {
    listenAction: vi.fn(
      async (_callback: (request: RoutedAuxiliaryAction) => void): Promise<() => void> => unlisten,
    ),
    publish: vi.fn(async (_snapshot: ScreenSharingSnapshot) => {}),
    open: vi.fn(async () => {}),
    revision: () => `revision-${++revision}`,
    unlisten,
  };
}

describe("auxiliary window ownership", () => {
  it("publishes the delivery mode and defaults existing callers to context delivery", () => {
    expect(createScreenSharingSnapshot(model(), "revision").deliveryMode).toBe("context");
    expect(
      createScreenSharingSnapshot({ ...model(), deliveryMode: "on-demand" }, "revision")
        .deliveryMode,
    ).toBe("on-demand");
  });

  it("publishes restricted source state and allows Start to draw the first region", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = {
      ...model(),
      screenSourceKind: "region" as const,
      region: null,
      pointersReady: false,
      setScreenSourceKind: vi.fn(),
      selectRegion: vi.fn(async () => {}),
    };
    host.update(current);
    await host.open();
    const snapshot = port.publish.mock.calls[0][0];
    const request = (action: RoutedAuxiliaryAction["action"]) => ({
      revision: snapshot.revision,
      pointerRevision: snapshot.pointerRevision,
      action,
    });
    expect(snapshot.screenSourceKind).toBe("region");
    expect(await host.handleAction(request({ type: "start" }))).toBe(true);
    expect(await host.handleAction(request({ type: "select-region" }))).toBe(true);
    expect(current.selectRegion).toHaveBeenCalledOnce();
    expect(
      await host.handleAction(
        request({ type: "select-screen-source-kind", screenSourceKind: "window" }),
      ),
    ).toBe(true);
    expect(current.setScreenSourceKind).toHaveBeenCalledWith("window");
    host.dispose();
  });

  it("rejects mode and camera switches while a region is active, even from a stale auxiliary UI", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = {
      ...model(),
      sourceKind: "screen" as const,
      screenSourceKind: "region" as const,
      active: true,
      setSourceKind: vi.fn(),
      setScreenSourceKind: vi.fn(),
    };
    host.update(current);
    await host.open();
    const snapshot = port.publish.mock.calls[0][0];
    for (const action of [
      { type: "select-source-kind", sourceKind: "camera" },
      { type: "select-screen-source-kind", screenSourceKind: "window" },
      { type: "select-screen-source-kind", screenSourceKind: "display" },
    ] as const)
      expect(
        await host.handleAction({
          revision: snapshot.revision,
          pointerRevision: snapshot.pointerRevision,
          action,
        }),
      ).toBe(false);
    expect(current.stop).not.toHaveBeenCalled();
    expect(current.setSourceKind).not.toHaveBeenCalled();
    expect(current.setScreenSourceKind).not.toHaveBeenCalled();
    host.dispose();
  });

  it.each([
    "camera",
    "screen",
  ] as const)("toggles %s preview without stopping sharing and rejects stale actions", async (sourceKind) => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = {
      ...model(),
      sourceKind,
      active: true,
      busy: true,
      previewVisible: true,
      setPreviewVisible: vi.fn(),
    };
    host.update(current);
    await host.open();
    const snapshot = port.publish.mock.calls[0][0];
    const request: RoutedAuxiliaryAction = {
      revision: snapshot.revision,
      pointerRevision: snapshot.pointerRevision,
      action: { type: "set-preview-visible", visible: false },
    };
    expect(await host.handleAction(request)).toBe(true);
    expect(current.setPreviewVisible).toHaveBeenCalledExactlyOnceWith(false);
    expect(current.start).not.toHaveBeenCalled();
    expect(current.stop).not.toHaveBeenCalled();
    expect(current.setPointersEnabled).not.toHaveBeenCalled();
    host.update({ ...current, previewVisible: false });
    expect(await host.handleAction(request)).toBe(false);
    await host.open();
    expect(port.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ previewVisible: false }),
    );
    host.dispose();
  });

  it("delivers native-accepted OFF after capture progress replaces the main snapshot", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = { ...model(), active: true, busy: true };
    host.update(current);
    await host.open();
    const accepted = port.publish.mock.calls[0][0];
    host.update({ ...current, busy: false, lastObservedAt: 1234 });
    expect(
      await host.handleAction({
        revision: accepted.revision,
        pointerRevision: accepted.pointerRevision,
        action: { type: "set-pointers-enabled", enabled: false },
      }),
    ).toBe(true);
    expect(current.setPointersEnabled).toHaveBeenCalledExactlyOnceWith(false);
    expect(
      await host.handleAction({
        revision: accepted.revision,
        pointerRevision: accepted.pointerRevision,
        action: { type: "stop" },
      }),
    ).toBe(false);
    expect(current.stop).not.toHaveBeenCalled();
    host.dispose();
  });

  it("delivers an accepted marker retry across unrelated capture publication", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = { ...model(), pointersReady: false, error: "Native unavailable" };
    host.update(current);
    await host.open();
    const accepted = port.publish.mock.calls[0][0];
    host.update({ ...current, busy: true, lastObservedAt: 1234 });
    expect(
      await host.handleAction({
        revision: accepted.revision,
        pointerRevision: accepted.pointerRevision,
        action: { type: "retry-pointers" },
      }),
    ).toBe(true);
    expect(current.retryPointers).toHaveBeenCalledOnce();
    host.dispose();
  });

  it.each([
    { name: "main owner", change: { ownerKey: "new-owner" } },
    { name: "marker setting", change: { pointersEnabled: false } },
    { name: "marker readiness", change: { pointersReady: false } },
  ])("revokes old marker requests after $name changes, including a round trip", async ({
    change,
  }) => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = model();
    host.update(current);
    await host.open();
    const originalPointerRevision = port.publish.mock.calls[0][0].pointerRevision;
    host.update({ ...current, ...change });
    host.update(current);
    expect(
      await host.handleAction({
        revision: "revision-3",
        pointerRevision: originalPointerRevision,
        action: { type: "set-pointers-enabled", enabled: false },
      }),
    ).toBe(false);
    expect(current.setPointersEnabled).not.toHaveBeenCalled();
    expect(
      await host.handleAction({
        revision: "revision-3",
        pointerRevision: "revision-3",
        action: { type: "set-pointers-enabled", enabled: false },
      }),
    ).toBe(true);
    host.dispose();
  });

  it("allows initialization recovery without allowing sharing before native synchronization", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = { ...model(), pointersReady: false, error: "Native failed" };
    host.update(current);
    expect(
      await host.handleAction({
        revision: "revision-1",
        pointerRevision: "revision-1",
        action: { type: "start" },
      }),
    ).toBe(false);
    expect(
      await host.handleAction({
        revision: "revision-1",
        pointerRevision: "revision-1",
        action: { type: "retry-pointers" },
      }),
    ).toBe(true);
    expect(current.retryPointers).toHaveBeenCalledOnce();
    host.update({ ...current, pointersReady: true });
    expect(
      await host.handleAction({
        revision: "revision-2",
        pointerRevision: "revision-2",
        action: { type: "retry-pointers" },
      }),
    ).toBe(false);
    host.dispose();
  });

  it("requires the allowlisted native label and route before mounting controls", () => {
    expect(resolveWindowView("auxiliary-camera-preview", "?auxiliary=camera-preview")).toBe(
      "camera-preview",
    );
    expect(resolveWindowView("auxiliary-camera-preview", "")).toBeNull();
    expect(resolveWindowView("untrusted", "?auxiliary=camera-preview")).toBeNull();
    expect(resolveWindowView(AUXILIARY_CONTROLS_LABEL, "?auxiliary=camera-preview")).toBeNull();
    expect(resolveWindowView("main", "")).toBe("main");
    expect(resolveWindowView("main", "?auxiliary=screen-sharing-controls")).toBe("main");
    expect(resolveWindowView(AUXILIARY_CONTROLS_LABEL, "?auxiliary=screen-sharing-controls")).toBe(
      "screen-sharing-controls",
    );
    expect(resolveWindowView(AUXILIARY_CONTROLS_LABEL, "")).toBeNull();
    expect(resolveWindowView("untrusted", "?auxiliary=screen-sharing-controls")).toBeNull();
  });

  it("copies only safe display fields and redacts provider errors and owner identity", () => {
    const snapshot = createScreenSharingSnapshot(
      {
        ...model(),
        error: "Provider failed with private credential abc",
        sources: [
          { id: 1, name: "Display 1", imageDataUrl: "secret image" } as {
            id: number;
            name: string;
          },
        ],
      },
      "revision",
    );
    expect(snapshot.sources).toEqual([{ id: 1, name: "Display 1" }]);
    expect(snapshot.hasError).toBe(true);
    expect(snapshot.language).toBe("ja");
    expect(JSON.stringify(snapshot)).not.toMatch(/private|secret|credential|ownerKey|imageDataUrl/);
  });

  it("opens explicitly after publishing, then updates stop state without opening or focusing again", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = { ...model(), active: true };
    host.update(current);
    await host.open();
    expect(port.publish).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    expect(port.open).toHaveBeenCalledTimes(1);
    host.update({ ...current, active: false });
    await Promise.resolve();
    await Promise.resolve();
    expect(port.publish).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    expect(port.open).toHaveBeenCalledTimes(1);
    expect(current.start).not.toHaveBeenCalled();
    host.dispose();
    expect(port.unlisten).toHaveBeenCalledOnce();
  });

  it("rejects stale actions immediately on owner replacement, even before native publication", async () => {
    const port = transport();
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const original = model();
    host.update(original);
    const replacement = { ...model(), ownerKey: "replacement" };
    host.update(replacement);
    expect(
      await host.handleAction({
        revision: "revision-1",
        pointerRevision: "revision-1",
        action: { type: "start" },
      }),
    ).toBe(false);
    expect(
      await host.handleAction({
        revision: "revision-1",
        pointerRevision: "revision-1",
        action: { type: "stop" },
      }),
    ).toBe(false);
    expect(original.start).not.toHaveBeenCalled();
    expect(replacement.stop).not.toHaveBeenCalled();
    expect(
      await host.handleAction({
        revision: "revision-2",
        pointerRevision: "revision-2",
        action: { type: "start" },
      }),
    ).toBe(true);
    expect(replacement.start).toHaveBeenCalledOnce();
    host.dispose();
  });

  it("retries the latest unchanged publication on an explicit open after a failure", async () => {
    const port = transport();
    const failure = new Error("Could not publish controls");
    port.publish.mockRejectedValueOnce(failure).mockRejectedValueOnce(failure);
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = model();
    host.update(current);
    await expect(host.open()).rejects.toThrow("Could not publish controls");
    expect(port.publish).toHaveBeenCalledTimes(2);
    expect(port.open).not.toHaveBeenCalled();
    host.update(current);
    await host.open();
    expect(port.publish).toHaveBeenCalledTimes(3);
    expect(port.publish.mock.calls[2][0]).toEqual(port.publish.mock.calls[0][0]);
    expect(port.open).toHaveBeenCalledOnce();
    expect(current.start).not.toHaveBeenCalled();
    expect(current.stop).not.toHaveBeenCalled();
    host.dispose();
  });

  it("waits for a replacement owner publication after retrying an earlier failed snapshot", async () => {
    const port = transport();
    const failure = new Error("Could not publish controls");
    let rejectFirst!: (error: Error) => void;
    let finishLatest!: () => void;
    port.publish
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishLatest = resolve;
          }),
      );
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    host.update(model());
    const open = host.open();
    await Promise.resolve();
    const current = { ...model(), ownerKey: "replacement-owner", pointersEnabled: false };
    host.update(current);
    rejectFirst(failure);
    await vi.waitFor(() => expect(port.publish).toHaveBeenCalledTimes(2));
    expect(port.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ pointersEnabled: false }),
    );
    expect(port.open).not.toHaveBeenCalled();
    finishLatest();
    await open;
    expect(port.open).toHaveBeenCalledOnce();
    expect(port.publish).toHaveBeenCalledTimes(2);
    host.dispose();
  });

  it("retries a failed action subscription once for concurrent explicit opens", async () => {
    const port = transport();
    let finishListen!: (unlisten: () => void) => void;
    port.listenAction
      .mockRejectedValueOnce(new Error("Listener unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishListen = resolve;
          }),
      );
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    host.update(model());
    await expect(host.open()).rejects.toThrow("Listener unavailable");
    const first = host.open();
    const second = host.open();
    expect(port.listenAction).toHaveBeenCalledTimes(2);
    expect(port.open).not.toHaveBeenCalled();
    finishListen(port.unlisten);
    await Promise.all([first, second]);
    expect(port.listenAction).toHaveBeenCalledTimes(2);
    await host.open();
    expect(port.listenAction).toHaveBeenCalledTimes(2);
    host.dispose();
    expect(port.unlisten).toHaveBeenCalledOnce();
  });

  it("cleans up a retried listener that resolves after disposal and never opens the window", async () => {
    const port = transport();
    let finishListen!: (unlisten: () => void) => void;
    port.listenAction
      .mockRejectedValueOnce(new Error("Listener unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishListen = resolve;
          }),
      );
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    host.update(model());
    await expect(host.open()).rejects.toThrow("Listener unavailable");
    const opening = host.open();
    host.dispose();
    finishListen(port.unlisten);
    await opening;
    expect(port.unlisten).toHaveBeenCalledOnce();
    expect(port.open).not.toHaveBeenCalled();
  });

  it("does not report a late subscription failure to a disposed owner", async () => {
    const port = transport();
    let rejectListen!: (error: Error) => void;
    port.listenAction.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectListen = reject;
        }),
    );
    const onError = vi.fn();
    const host = new ScreenSharingAuxiliaryHost(onError, port);
    host.update(model());
    const opening = host.open();
    host.dispose();
    rejectListen(new Error("Listener unavailable"));
    await expect(opening).rejects.toThrow("Listener unavailable");
    expect(onError).not.toHaveBeenCalled();
    expect(port.open).not.toHaveBeenCalled();
  });

  it("routes clear, source, and interval operations to the current hook and protects busy capture", async () => {
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), transport());
    const current = model();
    host.update(current);
    const action = (value: RoutedAuxiliaryAction["action"]) =>
      host.handleAction({ revision: "revision-1", pointerRevision: "revision-1", action: value });
    expect(await action({ type: "select-source", sourceId: 99 })).toBe(false);
    expect(await action({ type: "select-source", sourceId: 2 })).toBe(true);
    expect(current.setSourceId).toHaveBeenCalledWith(2);
    for (const intervalSeconds of [5, 9, 20.5, 181, 300, 301]) {
      expect(await action({ type: "set-interval", intervalSeconds })).toBe(false);
    }
    expect(current.setIntervalSeconds).not.toHaveBeenCalled();
    expect(await action({ type: "set-interval", intervalSeconds: 10 })).toBe(true);
    expect(current.setIntervalSeconds).toHaveBeenLastCalledWith(10);
    expect(await action({ type: "set-interval", intervalSeconds: 180 })).toBe(true);
    expect(current.setIntervalSeconds).toHaveBeenLastCalledWith(180);
    expect(await action({ type: "clear-annotations" })).toBe(true);
    expect(current.clearAnnotations).toHaveBeenCalledOnce();
    expect(current.stop).not.toHaveBeenCalled();
    host.update({ ...current, active: true, busy: true });
    expect(
      await host.handleAction({
        revision: "revision-2",
        pointerRevision: "revision-2",
        action: { type: "select-source", sourceId: 2 },
      }),
    ).toBe(false);
    expect(
      await host.handleAction({
        revision: "revision-2",
        pointerRevision: "revision-2",
        action: { type: "refresh-sources" },
      }),
    ).toBe(false);
    expect(
      await host.handleAction({
        revision: "revision-2",
        pointerRevision: "revision-2",
        action: { type: "stop" },
      }),
    ).toBe(true);
    expect(current.stop).toHaveBeenCalledOnce();
    expect(
      await host.handleAction({
        revision: "revision-2",
        pointerRevision: "revision-1",
        action: { type: "set-pointers-enabled", enabled: false },
      }),
    ).toBe(true);
    expect(current.setPointersEnabled).toHaveBeenCalledExactlyOnceWith(false);
    host.update({ ...current, pointersReady: false });
    expect(
      await host.handleAction({
        revision: "revision-3",
        pointerRevision: "revision-3",
        action: { type: "set-pointers-enabled", enabled: true },
      }),
    ).toBe(false);
    host.dispose();
  });

  it("serializes state publications and cancels queued work when the owner unmounts", async () => {
    const port = transport();
    let finishFirst: () => void = () => {};
    port.publish.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    const current = model();
    host.update(current);
    await Promise.resolve();
    host.update({ ...current, active: true });
    expect(port.publish).toHaveBeenCalledTimes(1);
    host.dispose();
    finishFirst();
    await Promise.resolve();
    await Promise.resolve();
    expect(port.publish).toHaveBeenCalledTimes(1);
    expect(
      await host.handleAction({
        revision: "revision-2",
        pointerRevision: "revision-2",
        action: { type: "start" },
      }),
    ).toBe(false);
  });

  it("releases subscriptions that finish after an unmount", async () => {
    const port = transport();
    let completeListen: (cleanup: () => void) => void = () => {};
    port.listenAction.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          completeListen = resolve;
        }),
    );
    const host = new ScreenSharingAuxiliaryHost(vi.fn(), port);
    host.dispose();
    completeListen(port.unlisten);
    await Promise.resolve();
    expect(port.unlisten).toHaveBeenCalledOnce();
    expect(port.publish).not.toHaveBeenCalled();
  });

  it("keeps newer state if an initial read arrives after a sharing-stop event", () => {
    const current = { version: 3, snapshot: createScreenSharingSnapshot(model(), "current") };
    const stale = { version: 2, snapshot: { ...current.snapshot, active: true } };
    expect(latestAuxiliarySnapshot(current, stale)).toBe(current);
    expect(latestAuxiliarySnapshot(null, current)).toBe(current);
  });
});

describe("native snapshot compatibility", () => {
  it("opens controls when the running native version predates frame counts and themes", async () => {
    const publish = vi.fn(async (_snapshot: ScreenSharingSnapshot) => {});
    publish.mockRejectedValueOnce("unknown field `contactSheetFrameCount`");
    publish.mockRejectedValueOnce("unknown field `uiColors`");
    const send = createAuxiliarySnapshotPublisher(publish);
    await send(
      createScreenSharingSnapshot(
        { ...model(), uiColors: { "--yorishiro-accent": "#fff" } },
        "revision",
      ),
    );
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2][0]).not.toHaveProperty("contactSheetFrameCount");
    expect(publish.mock.calls[2][0]).not.toHaveProperty("uiColors");
  });
  it.each([
    "camera",
    "screen",
  ] as const)("keeps %s sharing usable with the previous native schema", async (sourceKind) => {
    const publish = vi.fn(async (_snapshot: ScreenSharingSnapshot) => {});
    publish.mockRejectedValueOnce(
      "invalid args for command auxiliary_window_publish: unknown field `region`",
    );
    const send = createAuxiliarySnapshotPublisher(publish);
    const snapshot = createScreenSharingSnapshot({ ...model(), sourceKind }, "revision");
    await send(snapshot);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][0]).not.toHaveProperty("region");
    expect(publish.mock.calls[1][0]).not.toHaveProperty("screenSourceKind");
    expect(publish.mock.calls[1][0]).toMatchObject({ sourceKind, available: true, sourceId: 1 });
    await send(snapshot);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(publish.mock.calls[2][0]).not.toHaveProperty("region");
  });
  it("does not disguise restricted sources as full displays on older native versions", async () => {
    const publish = vi.fn(async (_snapshot: ScreenSharingSnapshot) => {});
    publish.mockRejectedValueOnce("unknown field `screenSourceKind`");
    const send = createAuxiliarySnapshotPublisher(publish);
    await send(createScreenSharingSnapshot({ ...model(), screenSourceKind: "region" }, "revision"));
    expect(publish.mock.calls[1][0]).toMatchObject({
      available: false,
      sources: [],
      sourceId: null,
    });
    expect(publish.mock.calls[1][0]).not.toHaveProperty("screenSourceKind");
  });
  it("preserves restricted state with current native versions and propagates unrelated errors", async () => {
    const publish = vi.fn(async (_snapshot: ScreenSharingSnapshot) => {});
    const send = createAuxiliarySnapshotPublisher(publish);
    const snapshot = createScreenSharingSnapshot(
      { ...model(), screenSourceKind: "window" },
      "revision",
    );
    await send(snapshot);
    expect(publish).toHaveBeenCalledExactlyOnceWith(snapshot);
    publish.mockRejectedValueOnce("window closed");
    await expect(send(snapshot)).rejects.toBe("window closed");
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
