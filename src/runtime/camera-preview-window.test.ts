// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  type CameraPreviewFrame,
  CameraPreviewHost,
  type CameraPreviewModel,
  startCameraPreviewRelay,
} from "./camera-preview-window";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
};
function fixture() {
  let action!: (request: { leaseId: string; action: "stop" | "attach" }) => void;
  const cleanup = vi.fn();
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  const model: CameraPreviewModel = {
    stream,
    language: "ja",
    onStop: vi.fn(),
    lastCapturedAt: 100,
  };
  const transport = {
    begin: vi.fn(async () => "lease-a"),
    open: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    publish: vi.fn(async (_frame: CameraPreviewFrame) => {}),
    listen: vi.fn(async (callback: typeof action) => {
      action = callback;
      return vi.fn();
    }),
  };
  const relay = vi.fn<typeof startCameraPreviewRelay>(() => cleanup);
  const changed = vi.fn();
  const host = new CameraPreviewHost(model, changed, transport, relay);
  return {
    host,
    model,
    transport,
    relay,
    changed,
    cleanup,
    stop,
    action: (leaseId: string, type: "stop" | "attach") => action({ leaseId, action: type }),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("a late lease registration after detach cancellation cannot open a window or start a relay", async () => {
  const f = fixture();
  const registration = deferred<string>();
  f.transport.begin.mockReturnValue(registration.promise);
  const opening = f.host.detach();
  await vi.waitFor(() => expect(f.transport.begin).toHaveBeenCalledOnce());
  const attaching = f.host.attach();
  registration.resolve("late-lease");
  await Promise.all([opening, attaching]);
  expect(f.transport.open).not.toHaveBeenCalled();
  expect(f.relay).not.toHaveBeenCalled();
  expect(f.transport.revoke).toHaveBeenCalledWith("late-lease");
  f.host.dispose();
});
it("stream null revokes and tears down local preview without stopping camera tracks", async () => {
  const f = fixture();
  await f.host.detach();
  f.host.update({ ...f.model, stream: null });
  await f.host.attach();
  expect(f.cleanup).toHaveBeenCalledOnce();
  expect(f.transport.revoke).toHaveBeenCalledWith("lease-a");
  expect(f.stop).not.toHaveBeenCalled();
  expect(f.model.onStop).not.toHaveBeenCalled();
  f.host.dispose();
});
it("late open completion cannot restart the relay after a stream replacement", async () => {
  const f = fixture();
  const nativeOpen = deferred<void>();
  f.transport.open.mockReturnValue(nativeOpen.promise);
  const opening = f.host.detach();
  await vi.waitFor(() => expect(f.transport.open).toHaveBeenCalledOnce());
  f.host.update({ ...f.model, stream: {} as MediaStream });
  expect(f.transport.revoke).toHaveBeenCalledWith("lease-a");
  nativeOpen.resolve();
  await opening;
  expect(f.relay).not.toHaveBeenCalled();
  f.host.dispose();
});
it("only the current lease may stop sharing; native close returns inline without stopping", async () => {
  const f = fixture();
  await f.host.detach();
  f.action("old-lease", "stop");
  expect(f.model.onStop).not.toHaveBeenCalled();
  f.action("lease-a", "attach");
  await f.host.attach();
  expect(f.model.onStop).not.toHaveBeenCalled();
  f.transport.begin.mockResolvedValue("lease-b");
  await f.host.detach();
  f.action("lease-a", "stop");
  expect(f.model.onStop).not.toHaveBeenCalled();
  f.action("lease-b", "stop");
  expect(f.model.onStop).toHaveBeenCalledOnce();
  f.host.dispose();
});
it("relay bounds image dimensions, limits rate and never queues while a send is pending", async () => {
  vi.useFakeTimers();
  const video = document.createElement("video");
  const canvas = document.createElement("canvas");
  Object.defineProperties(video, {
    readyState: { value: 2 },
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
  });
  const play = vi.spyOn(video, "play").mockResolvedValue();
  const pause = vi.spyOn(video, "pause").mockImplementation(() => {});
  const draw = vi.fn();
  vi.spyOn(canvas, "getContext").mockImplementation((() => ({
    drawImage: draw,
  })) as unknown as HTMLCanvasElement["getContext"]);
  vi.spyOn(canvas, "toDataURL").mockReturnValue("data:image/jpeg;base64,AAAA");
  const create = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
    tag === "video" ? video : tag === "canvas" ? canvas : create(tag),
  );
  const pending = deferred<void>();
  const publish = vi.fn(() => pending.promise);
  const fail = vi.fn();
  const stream = {} as MediaStream;
  const close = startCameraPreviewRelay(
    stream,
    () => ({ leaseId: "lease", language: "en", lastCapturedAt: 123 }),
    publish,
    fail,
  );
  await vi.advanceTimersByTimeAsync(125);
  expect(canvas.width).toBe(640);
  expect(canvas.height).toBe(360);
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledOnce();
  pending.resolve();
  await vi.advanceTimersByTimeAsync(125);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish.mock.calls[0]).toEqual([
    {
      leaseId: "lease",
      language: "en",
      lastCapturedAt: 123,
      imageDataUrl: "data:image/jpeg;base64,AAAA",
    },
  ]);
  close();
  await vi.advanceTimersByTimeAsync(1000);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(play).toHaveBeenCalledOnce();
  expect(pause).toHaveBeenCalledOnce();
  expect(video.srcObject).toBeNull();
  expect(fail).not.toHaveBeenCalled();
});

it("passes delivery mode from the current owner to detached camera frames", async () => {
  const f = fixture();
  f.host.update({ ...f.model, deliveryMode: "on-demand" });
  await f.host.detach();
  const readFrame = f.relay.mock.calls[0][1];
  expect(readFrame()?.deliveryMode).toBe("on-demand");
  f.host.update(f.model);
  expect(readFrame()?.deliveryMode).toBe("context");
  f.host.dispose();
});
