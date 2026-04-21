import { describe, expect, it, vi } from "vitest";
import { createUiStateStore } from "./ui-state-store";

describe("UiStateStore", () => {
  it("stores and retrieves values by key", () => {
    const store = createUiStateStore();
    expect(store.get("camera-panel", "camera.x")).toBeUndefined();
    store.set("camera-panel", "camera.x", 1.25);
    expect(store.get("camera-panel", "camera.x")).toBe(1.25);
  });

  it("notifies subscribers and fires current value on subscribe", () => {
    const store = createUiStateStore();
    store.set("camera-panel", "lighting.color", "#ffffff");
    const listener = vi.fn();
    const sub = store.subscribe("camera-panel", "lighting.color", listener);

    expect(listener).toHaveBeenCalledWith("#ffffff");
    store.set("camera-panel", "lighting.color", "#ff8800");
    expect(listener).toHaveBeenLastCalledWith("#ff8800");

    sub.dispose();
    store.set("camera-panel", "lighting.color", "#00ff00");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify when Object.is sees the same value", () => {
    const store = createUiStateStore();
    const listener = vi.fn();
    store.subscribe("camera-panel", "camera.fov", listener);
    listener.mockClear();

    store.set("camera-panel", "camera.fov", 35);
    store.set("camera-panel", "camera.fov", 35);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns a plain snapshot", () => {
    const store = createUiStateStore();
    store.set("camera-panel", "camera.x", 1);
    store.set("camera-panel", "camera.y", 2);
    expect(store.entries("camera-panel")).toEqual({ "camera.x": 1, "camera.y": 2 });
  });

  it("keeps values and subscriptions isolated by pack id", () => {
    const store = createUiStateStore();
    const cameraListener = vi.fn();
    const badgeListener = vi.fn();
    store.subscribe("camera-panel", "shared", cameraListener);
    store.subscribe("secondary-ui", "shared", badgeListener);
    cameraListener.mockClear();
    badgeListener.mockClear();

    store.set("camera-panel", "shared", "camera");
    store.set("secondary-ui", "shared", "badge");

    expect(store.get("camera-panel", "shared")).toBe("camera");
    expect(store.get("secondary-ui", "shared")).toBe("badge");
    expect(cameraListener).toHaveBeenCalledWith("camera");
    expect(badgeListener).toHaveBeenCalledWith("badge");
  });
});
