import { afterEach, describe, expect, it, vi } from "vitest";
import { ScreenObservationTransport } from "./screen-observation";

const frame = {
  imageDataUrl: "data:image/jpeg;base64,YQ==",
  capturedAt: "2026-09-05T13:00:00.000Z",
  source: "Display 1",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const loaded = (status = "idle", id = "main") => ({ thread: { id, status: { type: status } } });
afterEach(() => vi.useRealTimers());

describe("screen observation transport", () => {
  it.each([
    "idle",
    "active",
  ])("injects context in a %s thread without starting or steering work", async (status) => {
    const request = vi.fn(async (method: string) =>
      method === "thread/read" ? loaded(status) : {},
    );
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    expect((await transport.observe(frame)).status).toBe("shared");
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "thread/read",
      "thread/inject_items",
    ]);
    expect(request).toHaveBeenLastCalledWith(
      "thread/inject_items",
      expect.objectContaining({
        threadId: "main",
        items: [
          expect.objectContaining({
            role: "user",
            content: expect.arrayContaining([
              expect.objectContaining({ type: "input_image", image_url: frame.imageDataUrl }),
            ]),
          }),
        ],
      }),
    );
  });

  it("does not deliver after a cancelled preflight, and serializes a replacement", async () => {
    const read = deferred<unknown>();
    const request = vi.fn(() => read.promise);
    const transport = new ScreenObservationTransport({ request, getThreadId: () => "main" });
    const controller = new AbortController();
    const result = transport.observe(frame, controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect((await transport.observe(frame)).status).toBe("busy");
    read.resolve(loaded());
    await Promise.resolve();
    await Promise.resolve();
    expect(request).toHaveBeenCalledTimes(1);
    expect(transport.busy).toBe(false);
  });

  it("rejects stale thread results and redacts image-bearing backend errors", async () => {
    let id = "main";
    const request = vi.fn(async () => {
      id = "new-main";
      return loaded();
    });
    const transport = new ScreenObservationTransport({ request, getThreadId: () => id });
    await expect(transport.observe(frame)).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
    const fail = new ScreenObservationTransport({
      getThreadId: () => "main",
      request: async () => {
        throw new Error(frame.imageDataUrl);
      },
    });
    await expect(fail.observe(frame)).rejects.toThrow("Could not check");
  });

  it("times out without creating a second outstanding RPC", async () => {
    vi.useFakeTimers();
    const read = deferred<unknown>();
    const transport = new ScreenObservationTransport({
      request: () => read.promise,
      getThreadId: () => "main",
      timeoutMs: 100,
    });
    const pending = expect(transport.observe(frame)).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(100);
    await pending;
    expect((await transport.observe(frame)).status).toBe("busy");
    read.resolve(loaded());
    await Promise.resolve();
  });
});
