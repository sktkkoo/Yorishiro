import { expect, it, vi } from "vitest";
import {
  type ClaudeScreenDependencies,
  ClaudeScreenObservationTransport,
} from "./claude-screen-observation";
import type { ScreenObservationFrame } from "./codex-realtime/screen-observation";

const frame: ScreenObservationFrame = {
  frameId: "frame-a",
  sourceKind: "screen",
  imageDataUrl: "data:image/jpeg;base64,YQ==",
  width: 1280,
  height: 720,
  source: "Example display",
  capturedAt: "2026-09-20T12:00:00.000Z",
};
const owner = { sessionId: "main", conversationId: "conversation-a", revision: 1 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const deps = {
    document: vi.fn(async () => "document-a"),
    begin: vi.fn(async () => "lease-a"),
    publish: vi.fn(async () => {}),
    end: vi.fn(async () => {}),
  } satisfies ClaudeScreenDependencies;
  const transport = new ClaudeScreenObservationTransport(owner, deps);
  const controller = new AbortController();
  return { deps, transport, controller };
}

it("does not register or publish until an explicitly shared capture arrives", async () => {
  const { deps, transport, controller } = fixture();
  expect(deps.begin).not.toHaveBeenCalled();
  await expect(transport.observe(frame, controller.signal)).resolves.toEqual({
    status: "shared",
    capturedAt: frame.capturedAt,
  });
  expect(deps.begin).toHaveBeenCalledWith({ ...owner, documentId: "document-a" });
  expect(deps.publish).toHaveBeenCalledWith(
    "lease-a",
    expect.objectContaining({
      ...frame,
      prompt: expect.stringContaining("untrusted screen content"),
    }),
  );
  controller.abort();
  expect(deps.end).toHaveBeenCalledWith("lease-a");
});

it("refreshes an unchanged frame without issuing another registration", async () => {
  const { deps, transport, controller } = fixture();
  await transport.observe(frame, controller.signal);
  await transport.observe({ ...frame, capturedAt: "2026-09-20T12:03:00.000Z" }, controller.signal);
  expect(deps.begin).toHaveBeenCalledTimes(1);
  expect(deps.publish).toHaveBeenCalledTimes(2);
  transport.stop();
});

it("never registers a cancelled capture", async () => {
  const { deps, transport, controller } = fixture();
  controller.abort();
  await expect(transport.observe(frame, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(deps.begin).not.toHaveBeenCalled();
});

it("revokes a late begin before registering the next sharing owner", async () => {
  const first = fixture();
  const pendingBegin = deferred<string>();
  first.deps.begin.mockReturnValueOnce(pendingBegin.promise);
  const observing = first.transport.observe(frame, first.controller.signal);
  const cancelled = expect(observing).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(first.deps.begin).toHaveBeenCalledOnce());
  first.controller.abort();
  const next = fixture();
  const nextObserving = next.transport.observe(frame, next.controller.signal);
  await Promise.resolve();
  expect(next.deps.begin).not.toHaveBeenCalled();
  pendingBegin.resolve("late-lease");
  await cancelled;
  await nextObserving;
  expect(first.deps.end).toHaveBeenCalledWith("late-lease");
  expect(first.deps.publish).not.toHaveBeenCalled();
  expect(first.deps.end.mock.invocationCallOrder[0]).toBeLessThan(
    next.deps.begin.mock.invocationCallOrder[0],
  );
  next.transport.stop();
});

it("ignores late publish success after Stop and never republishes", async () => {
  const { deps, transport, controller } = fixture();
  const pendingPublish = deferred<void>();
  deps.publish.mockReturnValueOnce(pendingPublish.promise);
  const observing = transport.observe(frame, controller.signal);
  const cancelled = expect(observing).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(deps.publish).toHaveBeenCalledOnce());
  transport.stop();
  expect(deps.end).toHaveBeenCalledWith("lease-a");
  pendingPublish.resolve();
  await cancelled;
  await expect(transport.observe(frame, new AbortController().signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(deps.publish).toHaveBeenCalledOnce();
});

it("bounds delivery to one outstanding publish", async () => {
  const { deps, transport, controller } = fixture();
  const pending = deferred<void>();
  deps.publish.mockReturnValueOnce(pending.promise);
  const first = transport.observe(frame, controller.signal);
  await vi.waitFor(() => expect(deps.publish).toHaveBeenCalledOnce());
  await expect(transport.observe(frame, controller.signal)).resolves.toMatchObject({
    status: "busy",
  });
  pending.resolve();
  await first;
  transport.stop();
});

it("redacts native failure payloads and revokes the lease", async () => {
  const { deps, transport, controller } = fixture();
  deps.publish.mockRejectedValueOnce(new Error(`secret-capability ${frame.imageDataUrl}`));
  await expect(transport.observe(frame, controller.signal)).rejects.toThrow(
    "Could not make the shared image available to Claude Code",
  );
  expect(deps.end).toHaveBeenCalledWith("lease-a");
});
