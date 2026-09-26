// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  type ScreenPreviewFrame,
  ScreenPreviewHost,
  type ScreenPreviewModel,
  startScreenPreviewRelay,
} from "./screen-preview-window";

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

  const model: ScreenPreviewModel = {
    sourceKey: "source-a",
    frame: { imageDataUrl: "data:image/jpeg;base64,AAAA", lastCapturedAt: 100 },
    language: "ja",
    onStop: vi.fn(),
  };
  const transport = {
    begin: vi.fn(async () => "lease-a"),
    open: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    publish: vi.fn(async (_frame: ScreenPreviewFrame) => {}),
    listen: vi.fn(async (callback: typeof action) => {
      action = callback;
      return vi.fn();
    }),
  };
  const relay = vi.fn<typeof startScreenPreviewRelay>(() => cleanup);
  const changed = vi.fn();
  const host = new ScreenPreviewHost(model, changed, transport, relay);
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
  f.host.update({ ...f.model, sourceKey: null });
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
  f.host.update({ ...f.model, sourceKey: "source-b" });
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

it("still relay publishes the latest image after an in-flight publish without queuing intermediates", async () => {
  vi.useFakeTimers();
  const pending = deferred<void>();
  let frame: ScreenPreviewFrame = { leaseId: "lease", language: "ja", imageDataUrl: "first" };
  const publish = vi.fn(async (_frame: ScreenPreviewFrame) => {});
  publish.mockReturnValueOnce(pending.promise);
  const fail = vi.fn();
  const close = startScreenPreviewRelay("source", () => frame, publish, fail);
  frame = { ...frame, imageDataUrl: "second" };
  await vi.advanceTimersByTimeAsync(125);
  frame = { ...frame, imageDataUrl: "third" };
  await vi.advanceTimersByTimeAsync(125);
  expect(publish).toHaveBeenCalledTimes(1);
  pending.resolve();
  await vi.advanceTimersByTimeAsync(125);
  expect(publish).toHaveBeenLastCalledWith(frame);
  await vi.advanceTimersByTimeAsync(500);
  expect(publish).toHaveBeenCalledTimes(2);
  close();
  frame = { ...frame, imageDataUrl: "fourth" };
  await vi.advanceTimersByTimeAsync(500);
  expect(publish).toHaveBeenCalledTimes(2);
});

it("keeps the detached window while a resized crop waits for a fresh frame", async () => {
  const f = fixture();
  await f.host.detach();
  f.host.update({ ...f.model, frame: null });
  f.host.update({ ...f.model, frame: { imageDataUrl: "data:image/jpeg;base64,BBBB" } });
  expect(f.transport.open).toHaveBeenCalledOnce();
  expect(f.transport.revoke).not.toHaveBeenCalled();
  expect(f.cleanup).not.toHaveBeenCalled();
  expect(f.changed).toHaveBeenLastCalledWith({ detached: true, opening: false });
  f.host.dispose();
});

it("republishes delivery mode changes even when the image has not changed", async () => {
  vi.useFakeTimers();
  let frame: ScreenPreviewFrame = {
    leaseId: "lease",
    language: "en",
    imageDataUrl: "same-image",
    deliveryMode: "context",
  };
  const publish = vi.fn(async (_frame: ScreenPreviewFrame) => {});
  const close = startScreenPreviewRelay("source", () => frame, publish, vi.fn());
  await vi.advanceTimersByTimeAsync(125);
  frame = { ...frame, deliveryMode: "on-demand" };
  await vi.advanceTimersByTimeAsync(125);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(publish).toHaveBeenLastCalledWith(expect.objectContaining({ deliveryMode: "on-demand" }));
  close();
});

it("passes delivery mode from the current owner to detached screen frames", async () => {
  const f = fixture();
  f.host.update({ ...f.model, deliveryMode: "on-demand" });
  await f.host.detach();
  const readFrame = f.relay.mock.calls[0][1];
  expect(readFrame()?.deliveryMode).toBe("on-demand");
  f.host.update(f.model);
  expect(readFrame()?.deliveryMode).toBe("context");
  f.host.dispose();
});
