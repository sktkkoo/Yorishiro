import { describe, expect, it, vi } from "vitest";
import { ScenePackRegistryImpl } from "./scene-pack-registry";
import type { ScenePackEntry } from "./types";

const makeEntry = (id: string, origin: "bundled" | "user"): ScenePackEntry => ({
  id,
  origin,
  manifest: {
    id,
    type: "scene",
    version: "0.1.0",
    charminalVersion: "^0.1.0",
    entry: "scene.ts",
  },
  scene: { id, layers: [{ id: "bg", role: "background" }] },
});

describe("ScenePackRegistryImpl", () => {
  it("starts with no active scene", () => {
    const registry = new ScenePackRegistryImpl();
    expect(registry.getActiveScene()).toBeNull();
    expect(registry.listEntries()).toHaveLength(0);
  });

  it("picks up a single bundled as active via fallback", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    expect(registry.getActiveScene()?.id).toBe("a");
  });

  it("user origin overrides bundled at same id (dispose existing)", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry("same", "bundled"));
    registry.register(makeEntry("same", "user"));
    const entries = registry.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe("user");
  });

  it("does NOT auto-select user over bundled at different ids", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.register(makeEntry("b", "user"));
    expect(registry.getActiveScene()?.id).toBe("a");
    expect(registry.getActiveScene()?.id).not.toBe("b");
  });

  it("subscribeActive fires on subscription with current active", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    const listener = vi.fn();
    registry.subscribeActive(listener);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("subscribeActive fires when active changes after register", () => {
    const registry = new ScenePackRegistryImpl();
    const listener = vi.fn();
    registry.subscribeActive(listener);
    expect(listener).toHaveBeenCalledWith(null);
    registry.register(makeEntry("a", "bundled"));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("subscribeActive does not fire when active does not change", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    const listener = vi.fn();
    registry.subscribeActive(listener);
    const initialCalls = listener.mock.calls.length;
    // 別 id の bundled を register — "a" < "b" なので active は "a" のまま
    registry.register(makeEntry("b", "bundled"));
    expect(listener.mock.calls.length).toBe(initialCalls);
  });

  it("unsubscribes via returned Disposable", () => {
    const registry = new ScenePackRegistryImpl();
    const listener = vi.fn();
    const sub = registry.subscribeActive(listener);
    const initialCalls = listener.mock.calls.length;
    sub.dispose();
    registry.register(makeEntry("a", "bundled"));
    expect(listener.mock.calls.length).toBe(initialCalls);
  });

  it("setActiveScene picks the named pack", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.register(makeEntry("b", "user"));
    registry.setActiveScene("b");
    expect(registry.getActiveScene()?.id).toBe("b");
  });

  it("setActiveScene with non-existent id falls through to bundled default", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.setActiveScene("missing");
    expect(registry.getActiveScene()?.id).toBe("a");
  });

  it("setActiveScene(null) restores bundled fallback", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.register(makeEntry("b", "user"));
    registry.setActiveScene("b");
    registry.setActiveScene(null);
    expect(registry.getActiveScene()?.id).toBe("a");
  });

  it("register Disposable removes entry", () => {
    const registry = new ScenePackRegistryImpl();
    const handle = registry.register(makeEntry("a", "bundled"));
    expect(registry.getActiveScene()?.id).toBe("a");
    handle.dispose();
    expect(registry.listEntries()).toHaveLength(0);
    expect(registry.getActiveScene()).toBeNull();
  });

  it("bundled registration over existing user is ignored with warning", () => {
    const warnings: string[] = [];
    const registry = new ScenePackRegistryImpl({
      warn: (msg) => warnings.push(msg),
    });
    registry.register(makeEntry("same", "user"));
    registry.register(makeEntry("same", "bundled"));
    const entries = registry.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe("user");
    expect(warnings.some((w) => w.includes("same"))).toBe(true);
  });

  it("fires listener when same id is overridden with different scene", () => {
    const registry = new ScenePackRegistryImpl();
    const bundledEntry = makeEntry("same-id", "bundled");
    const userEntry: ScenePackEntry = {
      id: "same-id",
      origin: "user",
      manifest: {
        id: "same-id",
        type: "scene",
        version: "0.1.0",
        charminalVersion: "^0.1.0",
        entry: "scene.js",
      },
      scene: {
        id: "same-id",
        layers: [{ id: "user-bg", role: "background", backgroundColor: "#abc" }],
      },
    };
    registry.register(bundledEntry);
    const listener = vi.fn();
    registry.subscribeActive(listener);
    listener.mockClear();
    registry.register(userEntry);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(userEntry.scene);
  });
});
