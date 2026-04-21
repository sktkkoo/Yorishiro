import { describe, expect, it, vi } from "vitest";
import { createUiStateStore } from "./ui-state-store";

describe("UiStateStore", () => {
  it("stores and retrieves values by key", () => {
    const store = createUiStateStore();
    expect(store.get("camera.x")).toBeUndefined();
    store.set("camera.x", 1.25);
    expect(store.get("camera.x")).toBe(1.25);
  });

  it("notifies subscribers and fires current value on subscribe", () => {
    const store = createUiStateStore();
    store.set("lighting.color", "#ffffff");
    const listener = vi.fn();
    const sub = store.subscribe("lighting.color", listener);

    expect(listener).toHaveBeenCalledWith("#ffffff");
    store.set("lighting.color", "#ff8800");
    expect(listener).toHaveBeenLastCalledWith("#ff8800");

    sub.dispose();
    store.set("lighting.color", "#00ff00");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("does not notify when Object.is sees the same value", () => {
    const store = createUiStateStore();
    const listener = vi.fn();
    store.subscribe("camera.fov", listener);
    listener.mockClear();

    store.set("camera.fov", 35);
    store.set("camera.fov", 35);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("returns a plain snapshot", () => {
    const store = createUiStateStore();
    store.set("camera.x", 1);
    store.set("camera.y", 2);
    expect(store.entries()).toEqual({ "camera.x": 1, "camera.y": 2 });
  });
});
