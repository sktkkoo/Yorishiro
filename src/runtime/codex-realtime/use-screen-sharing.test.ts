// @vitest-environment jsdom
import { listen } from "@tauri-apps/api/event";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  screenAnnotationBegin,
  screenAnnotationClear,
  screenAnnotationDocument,
  screenAnnotationEnd,
  screenCaptureFrame,
  screenCaptureListSources,
  screenCaptureRegionFrameClose,
  screenCaptureRegionFrameOpen,
  screenCaptureRequestPermission,
  screenCaptureSelectRegion,
} from "../../bindings/tauri-commands";
import { listCameraSources, openCamera } from "./camera-capture";
import { buildContactSheet } from "./contact-sheet";
import type { ScreenObservationFrame } from "./screen-observation";

let useScreenSharing: typeof import("./use-screen-sharing").useScreenSharing;

const retainedInterval = vi.hoisted(() => ({ value: undefined as number | undefined }));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) =>
      react.useState(
        initial === 30 && retainedInterval.value !== undefined ? retainedInterval.value : initial,
      ),
  };
});

vi.mock("../../bindings/tauri-commands", () => ({
  screenAnnotationBegin: vi.fn(),
  screenAnnotationClear: vi.fn(),
  screenAnnotationDocument: vi.fn(),
  screenAnnotationEnd: vi.fn(),
  screenCaptureFrame: vi.fn(),
  screenCaptureListSources: vi.fn(),
  screenCaptureRegionFrameClose: vi.fn(),
  screenCaptureRegionFrameOpen: vi.fn(),
  screenCaptureRequestPermission: vi.fn(),
  screenCaptureSelectRegion: vi.fn(),
}));

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

vi.mock("./camera-capture", () => ({ openCamera: vi.fn(), listCameraSources: vi.fn() }));

vi.mock("./contact-sheet", () => ({ buildContactSheet: vi.fn() }));

const sheet = { dataUrl: "data:image/jpeg;base64,c2hlZXQ=", width: 2560, height: 1440 };
const sampleInterval = 30_000 / 16;

const frame = {
  frameId: "frame-1",
  pointersEnabled: true,
  pointerFrameValid: true,
  pointerEpoch: 7,
  sourceId: 1,
  sourceName: "Display 1",
  dataUrl: "data:image/jpeg;base64,YQ==",
  capturedAt: 1_700_000_000_000,
  width: 1280,
  height: 720,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("useScreenSharing", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetAllMocks();
    vi.resetModules();
    ({ useScreenSharing } = await import("./use-screen-sharing"));
    vi.mocked(screenCaptureListSources).mockResolvedValue([
      { id: 1, kind: "display", name: "Display 1", width: 1920, height: 1080 },
    ]);
    vi.mocked(listen).mockResolvedValue(vi.fn());
    vi.mocked(screenCaptureRegionFrameOpen).mockResolvedValue(undefined);
    vi.mocked(screenCaptureRegionFrameClose).mockResolvedValue(undefined);
    vi.mocked(screenCaptureRequestPermission).mockResolvedValue(true);
    vi.mocked(screenAnnotationDocument).mockResolvedValue("document-1");
    vi.mocked(screenAnnotationBegin).mockResolvedValue(undefined);
    vi.mocked(screenAnnotationEnd).mockResolvedValue(undefined);
    vi.mocked(screenAnnotationClear).mockResolvedValue(undefined);
    vi.mocked(screenCaptureFrame).mockResolvedValue(frame);
    // Image decoding/canvas composition is outside this hook’s lease and scheduling tests.
    vi.mocked(buildContactSheet).mockResolvedValue(sheet);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  function setup(motionEnabled = true) {
    const share = vi.fn(async (_frame: ScreenObservationFrame, _signal: AbortSignal) => ({
      status: "shared" as const,
      capturedAt: new Date(frame.capturedAt).toISOString(),
    }));
    const hook = renderHook(
      ({ ownerKey, available }) => useScreenSharing({ available, ownerKey, share }),
      { initialProps: { ownerKey: "main:thread:active", available: true } },
    );
    // Existing scheduling tests exercise motion sheets explicitly.
    if (motionEnabled) act(() => hook.result.current.setContactSheetFrameCount(16));
    return { ...hook, share };
  }

  const region = { x: 10, y: 20, width: 400, height: 300, displayWidth: 1920, displayHeight: 1080 };

  function emitRegion(name: string, payload: unknown) {
    const callback = [...vi.mocked(listen).mock.calls]
      .reverse()
      .find(([event]) => event === name)?.[1];
    if (!callback) throw new Error(`Missing ${name} listener`);
    callback({ event: name, id: 1, payload });
  }

  async function startRegion() {
    const hook = setup();
    await act(async () => hook.result.current.refreshSources());
    await act(async () => hook.result.current.setScreenSourceKind("region"));
    vi.mocked(screenCaptureSelectRegion).mockResolvedValue({ sourceId: 1, region });
    vi.mocked(screenCaptureFrame).mockResolvedValue({ ...frame, selectionKind: "region" });
    await act(async () => hook.result.current.start());
    await act(async () => hook.result.current.captureNow());
    const frameOwner = hook.result.current.screenShareKey;
    if (!frameOwner) throw new Error("Region did not start");
    return { ...hook, frameOwner };
  }

  it("serializes region pickers across rapid start, stop and restart", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    vi.mocked(screenCaptureFrame).mockResolvedValue({ ...frame, selectionKind: "region" });
    const first = deferred<{ sourceId: number; region: typeof region } | null>();
    const second = deferred<{ sourceId: number; region: typeof region } | null>();
    vi.mocked(screenCaptureSelectRegion)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    let starting!: Promise<void>;
    let restarting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
      void result.current.start();
      void result.current.start();
    });
    expect(screenCaptureSelectRegion).toHaveBeenCalledTimes(1);
    await act(async () => {
      result.current.stop();
      restarting = result.current.start();
      void result.current.start();
    });
    expect(screenCaptureSelectRegion).toHaveBeenCalledTimes(1);
    await act(async () => {
      first.resolve({ sourceId: 1, region });
      await starting;
    });
    expect(screenCaptureSelectRegion).toHaveBeenCalledTimes(2);
    expect(screenCaptureRegionFrameOpen).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);
    await act(async () => {
      second.resolve({ sourceId: 1, region });
      await restarting;
    });
    expect(result.current.active).toBe(true);
    expect(screenCaptureRegionFrameOpen).toHaveBeenCalledTimes(1);
  });

  it("draws the first rectangle across displays on Start and sends nothing until selected", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    const selected = deferred<{ sourceId: number; region: typeof region } | null>();
    vi.mocked(screenCaptureSelectRegion).mockReturnValue(selected.promise);
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    expect(screenCaptureSelectRegion).toHaveBeenCalledWith();
    expect(result.current.active).toBe(false);
    expect(result.current.busy).toBe(true);
    expect(screenCaptureRegionFrameOpen).not.toHaveBeenCalled();
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      sourceId: 7,
      selectionKind: "region",
    });
    await act(async () => {
      selected.resolve({ sourceId: 7, region });
      await starting;
    });
    await act(async () => result.current.captureNow());
    expect(result.current.sourceId).toBe(7);
    expect(result.current.active).toBe(true);
    expect(screenCaptureRegionFrameOpen).toHaveBeenCalledWith(expect.any(String), 7, region);
    expect(screenAnnotationBegin).toHaveBeenCalledWith(expect.any(String), 7, "document-1", {
      kind: "region",
      region,
    });
    expect(share).toHaveBeenCalledOnce();
  });

  it.each([
    "cancel",
    "stop",
  ] as const)("never captures when initial drawing ends with %s", async (action) => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    const selected = deferred<{ sourceId: number; region: typeof region } | null>();
    vi.mocked(screenCaptureSelectRegion).mockReturnValue(selected.promise);
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    if (action === "stop") act(() => result.current.stop());
    await act(async () => {
      selected.resolve(action === "cancel" ? null : { sourceId: 1, region });
      await starting;
    });
    expect(result.current.active).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(screenCaptureRegionFrameOpen).not.toHaveBeenCalled();
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it("keeps the old preview during a drag and immediately shares the committed crop using a new lease", async () => {
    const { result, share, frameOwner } = await startRegion();
    const preview = result.current.screenPreviewFrame;
    await act(async () =>
      emitRegion("screen-region-adjusting", { shareId: frameOwner, sourceId: 1 }),
    );
    await act(async () => result.current.captureNow());
    expect(result.current.active).toBe(true);
    expect(result.current.busy).toBe(true);
    expect(result.current.screenPreviewFrame).toEqual(preview);
    expect(share).toHaveBeenCalledOnce();
    const moved = { ...region, x: 100, width: 350 };
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      selectionKind: "region",
      frameId: "moved",
      dataUrl: "data:image/jpeg;base64,bW92ZWQ=",
      width: 350,
    });
    await act(async () =>
      emitRegion("screen-region-changed", { shareId: frameOwner, sourceId: 1, region: moved }),
    );
    expect(result.current.region).toEqual(moved);
    expect(result.current.active).toBe(true);
    expect(result.current.busy).toBe(false);
    expect(result.current.screenShareKey).not.toBe(frameOwner);
    expect(result.current.screenPreviewKey).toBe(frameOwner);
    expect(screenAnnotationEnd).toHaveBeenCalledWith(frameOwner);
    expect(screenAnnotationBegin).toHaveBeenLastCalledWith(
      result.current.screenShareKey,
      1,
      "document-1",
      { kind: "region", region: moved },
    );
    expect(share).toHaveBeenCalledTimes(2);
    expect(result.current.screenPreviewFrame?.imageDataUrl).toBe("data:image/jpeg;base64,bW92ZWQ=");
    expect(screenCaptureRegionFrameOpen).toHaveBeenCalledOnce();
    act(() => result.current.stop());
    expect(screenCaptureRegionFrameClose).toHaveBeenCalledWith(frameOwner);
  });

  it("drains an already submitted old image before committing a new region, without prematurely aborting it", async () => {
    const { result, share, frameOwner } = await startRegion();
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    share.mockImplementationOnce(() => delivery.promise);
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      selectionKind: "region",
      frameId: "old-in-flight",
    });
    let capture!: Promise<void>;
    await act(async () => {
      capture = result.current.captureNow();
    });
    const oldSignal = share.mock.calls[1][1];
    const moved = { ...region, x: 70 };
    await act(async () => {
      emitRegion("screen-region-adjusting", { shareId: frameOwner, sourceId: 1 });
      emitRegion("screen-region-changed", { shareId: frameOwner, sourceId: 1, region: moved });
    });
    expect(oldSignal.aborted).toBe(false);
    expect(result.current.region).toEqual(region);
    expect(result.current.screenShareKey).toBe(frameOwner);
    expect(screenAnnotationBegin).toHaveBeenCalledOnce();
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      selectionKind: "region",
      frameId: "new-crop",
    });
    await act(async () => {
      delivery.resolve({ status: "shared", capturedAt: new Date(frame.capturedAt).toISOString() });
      await capture;
    });
    expect(oldSignal.aborted).toBe(true);
    expect(result.current.region).toEqual(moved);
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(2);
    expect(share.mock.calls.map(([shared]) => shared.frameId)).toEqual([
      "frame-1",
      "old-in-flight",
      "new-crop",
    ]);
  });

  it("discards an old native capture finishing after a drag begins", async () => {
    const { result, share, frameOwner } = await startRegion();
    const captured = deferred<typeof frame & { selectionKind: "region" }>();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(captured.promise);
    let capture!: Promise<void>;
    await act(async () => {
      capture = result.current.captureNow();
    });
    await act(async () => {
      emitRegion("screen-region-adjusting", { shareId: frameOwner, sourceId: 1 });
      emitRegion("screen-region-changed", {
        shareId: frameOwner,
        sourceId: 1,
        region: { ...region, y: 90 },
      });
    });
    await act(async () => {
      captured.resolve({ ...frame, frameId: "stale-native", selectionKind: "region" });
      await capture;
    });
    expect(share.mock.calls.some(([shared]) => shared.frameId === "stale-native")).toBe(false);
    expect(result.current.region?.y).toBe(90);
    expect(result.current.active).toBe(true);
  });

  it("retains the original rectangle on Escape and accepts further drags through the stable frame owner", async () => {
    const { result, frameOwner } = await startRegion();
    await act(async () => {
      emitRegion("screen-region-adjusting", { shareId: frameOwner, sourceId: 1 });
      emitRegion("screen-region-changed", { shareId: frameOwner, sourceId: 1, region });
    });
    expect(result.current.region).toEqual(region);
    expect(result.current.active).toBe(true);
    expect(result.current.busy).toBe(false);
    await act(async () =>
      emitRegion("screen-region-changed", {
        shareId: frameOwner,
        sourceId: 1,
        region: { ...region, x: 80 },
      }),
    );
    expect(result.current.region?.x).toBe(80);
    expect(screenCaptureRegionFrameOpen).toHaveBeenCalledOnce();
  });

  it("ignores stopped, mismatched-display and replaced-frame events", async () => {
    const { result, frameOwner } = await startRegion();
    await act(async () =>
      emitRegion("screen-region-changed", {
        shareId: frameOwner,
        sourceId: 9,
        region: { ...region, x: 80 },
      }),
    );
    expect(result.current.region).toEqual(region);
    act(() => result.current.stop());
    await act(async () => result.current.start());
    const newOwner = result.current.screenShareKey;
    await act(async () => {
      emitRegion("screen-region-adjusting", { shareId: frameOwner, sourceId: 1 });
      emitRegion("screen-region-changed", {
        shareId: frameOwner,
        sourceId: 1,
        region: { ...region, x: 80 },
      });
      emitRegion("screen-region-closed", { shareId: frameOwner, sourceId: 1 });
    });
    expect(result.current.screenShareKey).toBe(newOwner);
    expect(result.current.region).toEqual(region);
    expect(result.current.active).toBe(true);
    expect(result.current.busy).toBe(false);
    await act(async () => emitRegion("screen-region-closed", { shareId: newOwner, sourceId: 1 }));
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("display changed");
  });

  it("does not resume a region update after Stop while the old image is draining", async () => {
    const { result, share, frameOwner } = await startRegion();
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    share.mockImplementationOnce(() => delivery.promise);
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      selectionKind: "region",
      frameId: "pending",
    });
    let capture!: Promise<void>;
    await act(async () => {
      capture = result.current.captureNow();
    });
    await act(async () =>
      emitRegion("screen-region-changed", {
        shareId: frameOwner,
        sourceId: 1,
        region: { ...region, x: 60 },
      }),
    );
    act(() => result.current.stop());
    await act(async () => {
      delivery.resolve({ status: "shared", capturedAt: "" });
      await capture;
    });
    expect(result.current.active).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(screenAnnotationBegin).toHaveBeenCalledOnce();
    expect(result.current.screenPreviewFrame).toBeNull();
  });

  it("closes a late initial frame open after Stop without beginning capture", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    vi.mocked(screenCaptureSelectRegion).mockResolvedValue({ sourceId: 1, region });
    const opened = deferred<void>();
    vi.mocked(screenCaptureRegionFrameOpen).mockReturnValue(opened.promise);
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    const frameOwner = vi.mocked(screenCaptureRegionFrameOpen).mock.calls[0][0];
    act(() => result.current.stop());
    await act(async () => {
      opened.resolve();
      await starting;
    });
    expect(screenCaptureRegionFrameClose).toHaveBeenLastCalledWith(frameOwner);
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("sends nothing when the persistent frame is unavailable", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    vi.mocked(screenCaptureSelectRegion).mockResolvedValue({ sourceId: 1, region });
    vi.mocked(screenCaptureRegionFrameOpen).mockRejectedValue(new Error("frame unavailable"));
    await act(async () => result.current.start());
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("frame unavailable");
  });

  it("keeps a drag in progress paused if the initial native begin finishes during it", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    vi.mocked(screenCaptureSelectRegion).mockResolvedValue({ sourceId: 1, region });
    vi.mocked(screenCaptureFrame).mockResolvedValue({ ...frame, selectionKind: "region" });
    const begun = deferred<void>();
    vi.mocked(screenAnnotationBegin).mockReturnValueOnce(begun.promise);
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    const frameOwner = vi.mocked(screenCaptureRegionFrameOpen).mock.calls[0][0];
    await act(async () =>
      emitRegion("screen-region-adjusting", { shareId: frameOwner, sourceId: 1 }),
    );
    await act(async () => {
      begun.resolve();
      await starting;
    });
    expect(result.current.active).toBe(true);
    expect(result.current.busy).toBe(true);
    expect(share).not.toHaveBeenCalled();
    await act(async () =>
      emitRegion("screen-region-changed", { shareId: frameOwner, sourceId: 1, region }),
    );
    expect(result.current.busy).toBe(false);
    expect(share).toHaveBeenCalledOnce();
  });

  it("serializes successive commits and only publishes the newest region", async () => {
    const { result, share, frameOwner } = await startRegion();
    const begun = deferred<void>();
    vi.mocked(screenAnnotationBegin).mockReturnValueOnce(begun.promise);
    await act(async () =>
      emitRegion("screen-region-changed", {
        shareId: frameOwner,
        sourceId: 1,
        region: { ...region, x: 50 },
      }),
    );
    await act(async () =>
      emitRegion("screen-region-changed", {
        shareId: frameOwner,
        sourceId: 1,
        region: { ...region, x: 80 },
      }),
    );
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenCalledOnce();
    await act(async () => begun.resolve());
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(3);
    expect(result.current.region?.x).toBe(80);
    expect(result.current.busy).toBe(false);
    expect(share).toHaveBeenCalledTimes(2);
  });

  it("fails closed if an old submitted image times out during adjustment", async () => {
    const { result, share, frameOwner } = await startRegion();
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    share.mockImplementationOnce(async () => {
      await delivery.promise;
      throw new Error("Screen sharing timed out");
    });
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      selectionKind: "region",
      frameId: "pending",
    });
    let capture!: Promise<void>;
    await act(async () => {
      capture = result.current.captureNow();
    });
    await act(async () =>
      emitRegion("screen-region-changed", {
        shareId: frameOwner,
        sourceId: 1,
        region: { ...region, x: 60 },
      }),
    );
    await act(async () => {
      delivery.resolve({ status: "shared", capturedAt: "" });
      await capture;
    });
    expect(result.current.active).toBe(false);
    expect(result.current.busy).toBe(false);
    expect(result.current.error).toContain("timed out");
    expect(screenAnnotationBegin).toHaveBeenCalledOnce();
  });

  it("lists windows only after explicit permission and freezes the window selection", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    expect(screenCaptureRequestPermission).not.toHaveBeenCalled();
    vi.mocked(screenCaptureListSources).mockResolvedValue([
      { id: 1, kind: "window", name: "Editor", width: 800, height: 600 },
    ]);
    await act(async () => result.current.setScreenSourceKind("window"));
    expect(screenCaptureRequestPermission).toHaveBeenCalledTimes(1);
    expect(screenCaptureListSources).toHaveBeenLastCalledWith("window");
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      selectionKind: "window",
      pointersEnabled: false,
      pointerFrameValid: false,
    });
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    expect(screenAnnotationBegin).toHaveBeenCalledWith(expect.any(String), 1, "document-1", {
      kind: "window",
    });
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ sourceKind: "screen", pointersEnabled: false }),
      expect.any(AbortSignal),
    );
  });

  it("requires a picked region and previews the exact cropped bytes delivered to the agent", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    vi.mocked(screenCaptureSelectRegion).mockResolvedValue({ sourceId: 1, region });
    await act(async () => result.current.selectRegion());
    expect(screenCaptureSelectRegion).toHaveBeenCalledWith(1);
    const cropped = {
      ...frame,
      width: 400,
      height: 300,
      selectionKind: "region" as const,
      dataUrl: "data:image/jpeg;base64,Y3JvcA==",
      pointersEnabled: false,
      pointerFrameValid: false,
    };
    vi.mocked(screenCaptureFrame).mockResolvedValue(cropped);
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    expect(screenAnnotationBegin).toHaveBeenCalledWith(expect.any(String), 1, "document-1", {
      kind: "region",
      region,
    });
    expect(result.current.screenPreviewFrame?.imageDataUrl).toBe(cropped.dataUrl);
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({ imageDataUrl: cropped.dataUrl, width: 400, height: 300 }),
      expect.any(AbortSignal),
    );
  });

  it("discards a stale region picker result after changing source type", async () => {
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    const selected = deferred<{ sourceId: number; region: typeof region } | null>();
    vi.mocked(screenCaptureSelectRegion).mockReturnValue(selected.promise);
    let picking!: Promise<void>;
    await act(async () => {
      picking = result.current.selectRegion();
    });
    await act(async () => result.current.setScreenSourceKind("display"));
    await act(async () => {
      selected.resolve({ sourceId: 1, region });
      await picking;
    });
    expect(result.current.region).toBeNull();
    expect(result.current.busy).toBe(false);
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
  });

  it("treats region picker cancellation as a non-error and keeps sharing stopped", async () => {
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    vi.mocked(screenCaptureSelectRegion).mockResolvedValue(null);
    await act(async () => result.current.selectRegion());
    expect(result.current.region).toBeNull();
    expect(result.current.error).toBeUndefined();
    expect(result.current.active).toBe(false);
    expect(result.current.busy).toBe(false);
  });

  it("does not enumerate windows after permission is denied or its source choice becomes stale", async () => {
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    vi.mocked(screenCaptureRequestPermission).mockResolvedValueOnce(false);
    await act(async () => result.current.setScreenSourceKind("window"));
    expect(screenCaptureListSources).not.toHaveBeenCalledWith("window");
    expect(result.current.error).toContain("Screen Recording permission");
    await act(async () => result.current.setScreenSourceKind("display"));
    const permission = deferred<boolean>();
    vi.mocked(screenCaptureRequestPermission).mockReturnValueOnce(permission.promise);
    await act(async () => result.current.setScreenSourceKind("window"));
    await act(async () => result.current.setScreenSourceKind("display"));
    await act(async () => permission.resolve(true));
    expect(screenCaptureListSources).not.toHaveBeenCalledWith("window");
    expect(result.current.screenSourceKind).toBe("display");
  });

  it("does not offer displays returned by an older backend as windows", async () => {
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    vi.mocked(screenCaptureListSources).mockResolvedValue([
      { id: 1, name: "Legacy display", width: 1920, height: 1080 },
    ]);
    await act(async () => result.current.setScreenSourceKind("window"));
    expect(result.current.sources).toEqual([]);
    expect(result.current.sourceId).toBeNull();
    await act(async () => result.current.start());
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "display",
    "window",
  ] as const)("never delivers or previews a region frame with selectionKind %s", async (selectionKind) => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.setScreenSourceKind("region"));
    vi.mocked(screenCaptureSelectRegion).mockResolvedValue({ sourceId: 1, region });
    await act(async () => result.current.selectRegion());
    vi.mocked(screenCaptureFrame).mockResolvedValue({ ...frame, selectionKind });
    await act(async () => result.current.start());
    expect(share).not.toHaveBeenCalled();
    expect(result.current.screenPreviewFrame).toBeNull();
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("could not be verified");
    expect(screenAnnotationEnd).toHaveBeenCalled();
  });

  it("keeps legacy display sharing available while rejecting restricted sources", async () => {
    const { result, share } = setup();
    vi.mocked(screenCaptureListSources).mockResolvedValue([
      { id: 1, name: "Legacy display", width: 1920, height: 1080 },
    ]);
    await act(async () => result.current.refreshSources());
    expect(result.current.screenSelectionSupported).toBe(false);
    await act(async () => result.current.setScreenSourceKind("region"));
    await act(async () => result.current.selectRegion());
    expect(result.current.screenSourceKind).toBe("display");
    expect(screenCaptureSelectRegion).not.toHaveBeenCalled();
    expect(screenCaptureRequestPermission).not.toHaveBeenCalled();
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    expect(share).toHaveBeenCalled();
  });

  it("remembers native source support across an empty list and camera selection", async () => {
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    expect(result.current.screenSelectionSupported).toBe(true);
    vi.mocked(screenCaptureListSources).mockResolvedValue([]);
    await act(async () => result.current.refreshSources());
    expect(result.current.screenSelectionSupported).toBe(true);
    vi.mocked(listCameraSources).mockResolvedValue([]);
    await act(async () => result.current.setSourceKind("camera"));
    expect(result.current.screenSelectionSupported).toBe(true);
  });

  it("previews buffered screenshots before delivery and clears them when sharing stops", async () => {
    const { result, share } = setup();
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    share.mockReturnValueOnce(delivery.promise);
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    expect(result.current.screenShareKey).toBeTruthy();
    expect(result.current.screenPreviewFrame?.imageDataUrl).toBe(frame.dataUrl);
    expect(share).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 15));
    expect(share).toHaveBeenCalledOnce();
    await act(async () =>
      delivery.resolve({ status: "shared", capturedAt: new Date(frame.capturedAt).toISOString() }),
    );
    expect(result.current.screenPreviewFrame?.imageDataUrl).toBe(sheet.dataUrl);
    act(() => result.current.stop());
    expect(result.current.screenPreviewFrame).toBeNull();
    expect(result.current.screenShareKey).toBeNull();
    expect(result.current.screenPreviewKey).toBeNull();
  });

  it("does not restore a preview when delivery finishes after stop", async () => {
    const { result, share } = setup();
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    share.mockReturnValueOnce(delivery.promise);
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 15));
    expect(share).toHaveBeenCalledOnce();
    act(() => result.current.stop());
    await act(async () =>
      delivery.resolve({ status: "shared", capturedAt: new Date(frame.capturedAt).toISOString() }),
    );
    expect(result.current.screenPreviewFrame).toBeNull();
  });

  it("shares camera frames without screen capture and stops on source or owner change", async () => {
    const camera = {
      stream: {} as MediaStream,
      capture: vi.fn(() => ({
        dataUrl: frame.dataUrl,
        width: 640,
        height: 480,
        capturedAt: frame.capturedAt,
      })),
      close: vi.fn(),
    };
    vi.mocked(listCameraSources).mockResolvedValue([
      { id: 1, name: "Camera", deviceId: "camera-device" },
    ]);
    vi.mocked(openCamera).mockResolvedValue(camera);
    const { result, share, rerender } = setup();
    await act(async () => result.current.setSourceKind("camera"));
    expect(openCamera).not.toHaveBeenCalled();
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    expect(screenCaptureRequestPermission).not.toHaveBeenCalled();
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(share).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKind: "camera",
        pointersEnabled: false,
        pointerFrameValid: false,
        width: 640,
      }),
      expect.any(AbortSignal),
    );
    expect(result.current.cameraStream).toBe(camera.stream);
    expect(result.current.lastCapturedAt).toBe(frame.capturedAt);
    const signal = vi.mocked(openCamera).mock.calls[0][1];
    await act(async () => result.current.setSourceKind("screen"));
    expect(signal.aborted).toBe(true);
    expect(result.current.cameraStream).toBeNull();
    expect(result.current.lastCapturedAt).toBeUndefined();
    expect(camera.close).toHaveBeenCalledOnce();
    expect(result.current.active).toBe(false);
    await act(async () => result.current.setSourceKind("camera"));
    await act(async () => result.current.start());
    rerender({ ownerKey: "replacement-thread", available: true });
    expect(camera.close).toHaveBeenCalledTimes(2);
  });

  it("lists sources without capture and ignores a permission grant after cancellation", async () => {
    const permission = deferred<boolean>();
    vi.mocked(screenCaptureRequestPermission).mockReturnValue(permission.promise);
    const { result, share } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    expect(screenCaptureRequestPermission).toHaveBeenCalledTimes(1);
    act(() => result.current.stop());
    await act(async () => {
      permission.resolve(true);
      await starting;
    });
    expect(result.current.active).toBe(false);
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(share).not.toHaveBeenCalled();
  });

  it("does not overlap captures or deliver a frame after stop", async () => {
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValue(pending.promise);
    const { result, share } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    const shareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    expect(screenAnnotationBegin).toHaveBeenCalledWith(shareId, 1, "document-1");
    expect(screenCaptureFrame).toHaveBeenCalledWith(1, shareId);
    act(() => result.current.stop());
    expect(screenAnnotationEnd).toHaveBeenCalledWith(shareId);
    await act(async () => {
      pending.resolve(frame);
    });
    expect(share).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(false);
  });

  it("allows an explicit refresh only after opt-in setup and joins an in-flight capture", async () => {
    const { result, share } = setup();
    await act(async () => result.current.captureNow());
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    const permission = deferred<boolean>();
    vi.mocked(screenCaptureRequestPermission).mockReturnValueOnce(permission.promise);
    await act(async () => result.current.refreshSources());
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
      await result.current.captureNow();
    });
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    await act(async () => {
      permission.resolve(true);
      await starting;
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1_000));
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(pending.promise);
    let first!: Promise<void>;
    let second!: Promise<void>;
    await act(async () => {
      first = result.current.captureNow();
      second = result.current.captureNow();
    });
    expect(first).toBe(second);
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
    await act(async () => {
      pending.resolve({ ...frame, frameId: "refreshed", dataUrl: "data:image/jpeg;base64,Yg==" });
      await first;
    });
    expect(share).toHaveBeenCalledTimes(1);
    act(() => result.current.stop());
    await act(async () => result.current.captureNow());
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
  });

  it("resumes overdue periodic capture immediately after a slow delivery", async () => {
    const { result, share } = setup();
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    share.mockReturnValueOnce(delivery.promise);
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(screenCaptureFrame).toHaveBeenCalledTimes(16);
    await act(async () => {
      delivery.resolve({ status: "shared", capturedAt: new Date(frame.capturedAt).toISOString() });
    });
    await act(async () => vi.advanceTimersByTimeAsync(1));
    // The next sample was due at 30s and resumes immediately at 40s.
    expect(screenCaptureFrame).toHaveBeenCalledTimes(17);
  });

  it("starts a replacement lease's first capture as soon as the old capture settles", async () => {
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(pending.promise);
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    act(() => result.current.stop());
    await act(async () => result.current.start());
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(frame));
    expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
    expect(share).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 15));
    expect(share).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(true);
  });

  it("reports stage durations without sending captured content to diagnostics", async () => {
    const capture = deferred<typeof frame>();
    const delivery = deferred<{ status: "shared"; capturedAt: string }>();
    const onTiming = vi.fn();
    const { result } = renderHook(() =>
      useScreenSharing({
        available: true,
        ownerKey: "private-owner",
        share: () => delivery.promise,
        onTiming,
      }),
    );
    act(() => result.current.setContactSheetFrameCount(16));
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 14));
    expect(screenCaptureFrame).toHaveBeenCalledTimes(15);
    onTiming.mockClear();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(capture.promise);
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval + 100));
    await act(async () => capture.resolve(frame));
    await act(async () => vi.advanceTimersByTimeAsync(80));
    await act(async () =>
      delivery.resolve({ status: "shared", capturedAt: new Date(frame.capturedAt).toISOString() }),
    );
    expect(onTiming).toHaveBeenCalledExactlyOnceWith({
      reason: "periodic",
      captureMs: 100,
      contextMs: 80,
      totalMs: 180,
      outcome: "shared",
    });
  });

  it.each([
    "screen",
    "camera",
  ] as const)("defaults to a single %s image without motion composition", async (sourceKind) => {
    vi.mocked(listCameraSources).mockResolvedValue([{ id: 1, name: "Camera" }]);
    vi.mocked(openCamera).mockResolvedValue({
      stream: {} as MediaStream,
      capture: vi.fn(() => frame),
      close: vi.fn(),
    });
    const { result, share } = setup(false);
    if (sourceKind === "camera") await act(async () => result.current.setSourceKind("camera"));
    else await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    expect(result.current.contactSheetFrameCount).toBe(1);
    expect(buildContactSheet).not.toHaveBeenCalled();
    expect(share).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sourceKind,
        imageDataUrl: frame.dataUrl,
        width: frame.width,
        height: frame.height,
      }),
      expect.any(AbortSignal),
    );
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      frameId: "frame-2",
      dataUrl: "data:image/jpeg;base64,Yg==",
    });
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(share).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(share).toHaveBeenCalledTimes(2);
    expect(buildContactSheet).not.toHaveBeenCalled();
  });

  it("discards a composing sheet when motion is disabled", async () => {
    const pending = deferred<typeof sheet>();
    vi.mocked(buildContactSheet).mockReturnValueOnce(pending.promise);
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 15));
    expect(buildContactSheet).toHaveBeenCalledOnce();
    act(() => result.current.setContactSheetFrameCount(1));
    await act(async () => pending.resolve(sheet));
    expect(share).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(share).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ imageDataUrl: frame.dataUrl }),
      expect.any(AbortSignal),
    );
  });

  it("clamps sheet intervals to ten seconds and stops sampling on owner change", async () => {
    const { result, rerender, share } = setup();
    expect(result.current.intervalSeconds).toBe(30);
    expect(result.current.contactSheetFrameCount).toBe(16);
    await act(async () => result.current.refreshSources());
    act(() => result.current.setIntervalSeconds(5));
    expect(result.current.intervalSeconds).toBe(10);
    await act(async () => result.current.start());
    expect(share).not.toHaveBeenCalled();
    expect(result.current.screenPreviewFrame?.imageDataUrl).toBe(frame.dataUrl);
    await act(async () => vi.advanceTimersByTimeAsync(9_374));
    expect(screenCaptureFrame).toHaveBeenCalledTimes(15);
    expect(share).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(buildContactSheet).toHaveBeenCalledExactlyOnceWith(
      Array.from({ length: 16 }, () => ({ dataUrl: frame.dataUrl, capturedAt: frame.capturedAt })),
      16,
    );
    expect(share).toHaveBeenCalledExactlyOnceWith(
      {
        sourceKind: "screen",
        frameId: expect.any(String),
        pointersEnabled: false,
        pointerFrameValid: false,
        pointerEpoch: frame.pointerEpoch,
        width: sheet.width,
        height: sheet.height,
        imageDataUrl: sheet.dataUrl,
        source: frame.sourceName,
        capturedAt: new Date(frame.capturedAt).toISOString(),
      },
      expect.any(AbortSignal),
    );
    expect(share.mock.calls[0][0].frameId).not.toBe(frame.frameId);
    expect(result.current.lastObservedAt).toBe(frame.capturedAt);
    // Identical sheets still need a fresh, invalid-for-pointing reference.
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(share).toHaveBeenCalledTimes(2);
    expect(share.mock.calls[1][0].frameId).not.toBe(share.mock.calls[0][0].frameId);
    rerender({ ownerKey: "main:other-thread:active", available: true });
    expect(result.current.active).toBe(false);
    expect(screenAnnotationEnd).toHaveBeenCalledWith(
      vi.mocked(screenAnnotationBegin).mock.calls[0][0],
    );
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screenCaptureFrame).toHaveBeenCalledTimes(32);
  });

  it("discards a contact sheet that finishes composing after sharing stops", async () => {
    const pending = deferred<typeof sheet>();
    vi.mocked(buildContactSheet).mockReturnValueOnce(pending.promise);
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 15));
    expect(buildContactSheet).toHaveBeenCalledOnce();
    expect(share).not.toHaveBeenCalled();
    act(() => result.current.stop());
    await act(async () => pending.resolve(sheet));
    expect(share).not.toHaveBeenCalled();
    expect(result.current.screenPreviewFrame).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(screenCaptureFrame).toHaveBeenCalledTimes(16);
  });

  it("does not mix buffered samples from an old lease into a replacement sheet", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 14));
    expect(share).not.toHaveBeenCalled();
    act(() => result.current.stop());
    const replacement = {
      ...frame,
      dataUrl: "data:image/jpeg;base64,bmV3",
      capturedAt: frame.capturedAt + 30_000,
    };
    vi.mocked(screenCaptureFrame).mockResolvedValue(replacement);
    await act(async () => result.current.start());
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 14));
    expect(share).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval));
    expect(buildContactSheet).toHaveBeenCalledExactlyOnceWith(
      Array.from({ length: 16 }, () => ({
        dataUrl: replacement.dataUrl,
        capturedAt: replacement.capturedAt,
      })),
      16,
    );
    expect(share).toHaveBeenCalledOnce();
  });

  it("normalizes a legacy five-second React state for both publication and actual sampling", async () => {
    retainedInterval.value = 5;
    try {
      const { result } = setup();
      expect(result.current.intervalSeconds).toBe(10);
      await act(async () => result.current.refreshSources());
      await act(async () => result.current.start());
      expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(624));
      expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screenCaptureFrame).toHaveBeenCalledTimes(2);
    } finally {
      retainedInterval.value = undefined;
    }
  });

  it("deduplicates explicit refreshes but shares replacement references with identical pixels", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    await act(async () => result.current.captureNow());
    expect(share).toHaveBeenCalledOnce();
    vi.mocked(screenCaptureFrame).mockResolvedValueOnce({ ...frame, frameId: "after-expiry" });
    await act(async () => result.current.captureNow());
    expect(share).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenLastCalledWith(
      expect.objectContaining({ frameId: "after-expiry", imageDataUrl: frame.dataUrl }),
      expect.any(AbortSignal),
    );
  });

  it("continues sharing images with the native OFF and invalid-pointer-frame metadata", async () => {
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      pointersEnabled: false,
      pointerFrameValid: false,
    });
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    expect(result.current.active).toBe(true);
    expect(share).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        imageDataUrl: frame.dataUrl,
        pointersEnabled: false,
        pointerFrameValid: false,
        pointerEpoch: 7,
      }),
      expect.any(AbortSignal),
    );
    expect(screenAnnotationEnd).not.toHaveBeenCalled();
  });

  it("fails visibly without continuing capture when delivery fails", async () => {
    const { result, share } = setup();
    share.mockRejectedValue(new Error("Image context is unsupported"));
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 15));
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("unsupported");
    expect(screenAnnotationEnd).toHaveBeenCalledWith(
      vi.mocked(screenAnnotationBegin).mock.calls[0][0],
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(16);
  });

  it("does not send a burst of images while dragging the interval slider", async () => {
    const { result } = setup();
    await act(async () => {
      await result.current.refreshSources();
    });
    await act(async () => {
      await result.current.start();
    });
    for (let value = 9; value <= 181; value++) {
      act(() => result.current.setIntervalSeconds(value));
    }
    expect(result.current.intervalSeconds).toBe(180);
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(screenCaptureFrame).toHaveBeenCalledTimes(17);
  });

  it("serializes a cancelled native begin before a new sharing lease", async () => {
    const beginning = deferred<void>();
    vi.mocked(screenAnnotationBegin).mockReturnValueOnce(beginning.promise);
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    let firstStart!: Promise<void>;
    await act(async () => {
      firstStart = result.current.start();
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(1);
    const firstShareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    act(() => result.current.stop());
    expect(screenAnnotationEnd).toHaveBeenCalledWith(firstShareId);

    let secondStart!: Promise<void>;
    await act(async () => {
      secondStart = result.current.start();
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(1);
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    await act(async () => {
      beginning.resolve();
      await Promise.all([firstStart, secondStart]);
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(2);
    const secondShareId = vi.mocked(screenAnnotationBegin).mock.calls[1][0];
    expect(secondShareId).not.toBe(firstShareId);
    expect(screenAnnotationEnd).toHaveBeenLastCalledWith(firstShareId);
    const endCallOrder = vi.mocked(screenAnnotationEnd).mock.invocationCallOrder;
    expect(endCallOrder[endCallOrder.length - 1]).toBeLessThan(
      vi.mocked(screenAnnotationBegin).mock.invocationCallOrder[1],
    );
    expect(screenCaptureFrame).toHaveBeenCalledExactlyOnceWith(1, secondShareId);
    expect(result.current.active).toBe(true);
  });

  it("revokes a late native begin after unmount before another hook can start", async () => {
    const beginning = deferred<void>();
    vi.mocked(screenAnnotationBegin).mockReturnValueOnce(beginning.promise);
    const first = setup();
    await act(async () => first.result.current.refreshSources());
    let firstStart!: Promise<void>;
    await act(async () => {
      firstStart = first.result.current.start();
    });
    const firstShareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    first.unmount();
    expect(screenAnnotationEnd).toHaveBeenCalledWith(firstShareId);

    const second = setup();
    await act(async () => second.result.current.refreshSources());
    let secondStart!: Promise<void>;
    await act(async () => {
      secondStart = second.result.current.start();
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(1);
    await act(async () => {
      beginning.resolve();
      await Promise.all([firstStart, secondStart]);
    });
    expect(screenAnnotationBegin).toHaveBeenCalledTimes(2);
    expect(screenAnnotationEnd).toHaveBeenLastCalledWith(firstShareId);
    expect(first.share).not.toHaveBeenCalled();
    expect(second.share).not.toHaveBeenCalled();
    await act(async () => vi.advanceTimersByTimeAsync(sampleInterval * 15));
    expect(second.share).toHaveBeenCalledTimes(1);
    expect(second.result.current.active).toBe(true);
  });

  it("ends the lease if native annotation setup fails, without capturing an image", async () => {
    vi.mocked(screenAnnotationBegin).mockRejectedValueOnce(new Error("Display unavailable"));
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("Display unavailable");
    expect(screenAnnotationEnd).toHaveBeenCalledWith(
      vi.mocked(screenAnnotationBegin).mock.calls[0][0],
    );
    expect(screenCaptureFrame).not.toHaveBeenCalled();
  });

  it("clears markers without ending screen sharing or requesting another capture", async () => {
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => result.current.clearAnnotations());
    expect(screenAnnotationClear).toHaveBeenCalledTimes(1);
    expect(screenAnnotationEnd).not.toHaveBeenCalled();
    expect(screenCaptureFrame).toHaveBeenCalledTimes(1);
    expect(result.current.active).toBe(true);
  });

  it("stops and revokes markers when refreshed sources lose the shared display", async () => {
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    vi.mocked(screenCaptureListSources).mockResolvedValueOnce([
      { id: 2, name: "Display 2", width: 1920, height: 1080 },
    ]);
    await act(async () => result.current.refreshSources());
    expect(result.current.active).toBe(false);
    expect(result.current.sourceId).toBe(2);
    expect(result.current.error).toContain("no longer available");
    expect(screenAnnotationEnd).toHaveBeenCalledWith(
      vi.mocked(screenAnnotationBegin).mock.calls[0][0],
    );
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(share).toHaveBeenCalledTimes(1);
  });

  it("uses a new lease for a new display after stopping, even with identical pixels", async () => {
    vi.mocked(screenCaptureListSources).mockResolvedValue([
      { id: 1, name: "Display 1", width: 1920, height: 1080 },
      { id: 2, name: "Display 2", width: 1920, height: 1080 },
    ]);
    const { result, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    const firstShareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    act(() => result.current.setSourceId(2));
    expect(result.current.sourceId).toBe(2);
    expect(result.current.active).toBe(false);
    act(() => result.current.stop());
    act(() => result.current.setSourceId(2));
    vi.mocked(screenCaptureFrame).mockResolvedValue({
      ...frame,
      frameId: "frame-2",
      sourceId: 2,
      sourceName: "Display 2",
    });
    await act(async () => result.current.start());
    await act(async () => result.current.captureNow());
    const secondShareId = vi.mocked(screenAnnotationBegin).mock.calls[1][0];
    expect(secondShareId).not.toBe(firstShareId);
    expect(screenAnnotationBegin).toHaveBeenLastCalledWith(secondShareId, 2, "document-1");
    expect(screenCaptureFrame).toHaveBeenLastCalledWith(2, secondShareId);
    expect(share).toHaveBeenCalledTimes(2);
    expect(share).toHaveBeenLastCalledWith(
      expect.objectContaining({ frameId: "frame-2", source: "Display 2" }),
      expect.any(AbortSignal),
    );
  });

  it("revokes markers on loss of availability and ignores late capture success", async () => {
    const pending = deferred<typeof frame>();
    vi.mocked(screenCaptureFrame).mockReturnValueOnce(pending.promise);
    const { result, rerender, share } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    const shareId = vi.mocked(screenAnnotationBegin).mock.calls[0][0];
    rerender({ ownerKey: "main:thread:active", available: false });
    expect(screenAnnotationEnd).toHaveBeenCalledWith(shareId);
    await act(async () => pending.resolve(frame));
    expect(result.current.active).toBe(false);
    expect(share).not.toHaveBeenCalled();
  });

  it("caches the native document ID across sharing leases in the same JS document", async () => {
    const first = setup();
    await act(async () => first.result.current.refreshSources());
    await act(async () => first.result.current.start());
    first.unmount();
    vi.mocked(screenAnnotationDocument).mockResolvedValue("newer-native-document");
    const second = setup();
    await act(async () => second.result.current.refreshSources());
    await act(async () => second.result.current.start());
    expect(screenAnnotationDocument).toHaveBeenCalledTimes(1);
    expect(screenAnnotationBegin).toHaveBeenLastCalledWith(expect.any(String), 1, "document-1");
  });

  it("keeps the old document epoch while permission is pending", async () => {
    const permission = deferred<boolean>();
    vi.mocked(screenCaptureRequestPermission).mockReturnValueOnce(permission.promise);
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    let starting!: Promise<void>;
    await act(async () => {
      starting = result.current.start();
    });
    expect(screenAnnotationDocument).toHaveBeenCalledTimes(1);
    expect(screenCaptureRequestPermission).toHaveBeenCalledTimes(1);
    expect(vi.mocked(screenAnnotationDocument).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(screenCaptureRequestPermission).mock.invocationCallOrder[0],
    );
    vi.mocked(screenAnnotationDocument).mockResolvedValue("after-reload");
    vi.mocked(screenAnnotationBegin).mockRejectedValueOnce(new Error("Document has reloaded"));
    await act(async () => {
      permission.resolve(true);
      await starting;
    });
    expect(screenAnnotationDocument).toHaveBeenCalledTimes(1);
    expect(screenAnnotationBegin).toHaveBeenCalledWith(expect.any(String), 1, "document-1");
    expect(screenCaptureFrame).not.toHaveBeenCalled();
    expect(result.current.active).toBe(false);
    expect(result.current.error).toContain("Document has reloaded");
  });

  it("retries a failed document lookup on the next Start without requesting permission early", async () => {
    vi.mocked(screenAnnotationDocument).mockRejectedValueOnce(new Error("Document unavailable"));
    const { result } = setup();
    await act(async () => result.current.refreshSources());
    await act(async () => result.current.start());
    expect(result.current.error).toContain("Document unavailable");
    expect(screenCaptureRequestPermission).not.toHaveBeenCalled();
    expect(screenAnnotationBegin).not.toHaveBeenCalled();
    await act(async () => result.current.start());
    expect(screenAnnotationDocument).toHaveBeenCalledTimes(2);
    expect(screenAnnotationBegin).toHaveBeenCalledWith(expect.any(String), 1, "document-1");
    expect(result.current.active).toBe(true);
  });
});
