import { describe, expect, it } from "vitest";
import {
  enqueueNativeWindowMutation,
  resolveWindowAspectRatioStrategy,
} from "./view-mode-native-window";

describe("View Mode native window aspect ratio", () => {
  it("disables aspect enforcement on macOS for resize stability", () => {
    expect(resolveWindowAspectRatioStrategy(2 / 3, true)).toEqual({
      nativeAspectRatio: null,
      jsAspectRatio: null,
    });
    expect(resolveWindowAspectRatioStrategy(undefined, true)).toEqual({
      nativeAspectRatio: null,
      jsAspectRatio: null,
    });
  });

  it("also avoids resize correction loops on other platforms", () => {
    expect(resolveWindowAspectRatioStrategy(2 / 3, false)).toEqual({
      nativeAspectRatio: null,
      jsAspectRatio: null,
    });
  });

  it("serializes window mutations and continues after a failure", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const first = enqueueNativeWindowMutation(
      () =>
        new Promise<void>((_resolve, reject) => {
          events.push("first:start");
          releaseFirst = () => {
            events.push("first:end");
            reject(new Error("expected"));
          };
        }),
    );
    const second = enqueueNativeWindowMutation(async () => {
      events.push("second");
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);
    releaseFirst();
    await expect(first).rejects.toThrow("expected");
    await second;
    expect(events).toEqual(["first:start", "first:end", "second"]);
  });
});
