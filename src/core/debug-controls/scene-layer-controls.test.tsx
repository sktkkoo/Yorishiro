// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, renderHook } from "@testing-library/react";
import { useCreateStore } from "leva";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScenePackEntry } from "../../runtime/scene-pack-registry";
import type { Layer } from "../scene/types";

const { subscribeActiveEntry, updateLayer, resetLayer } = vi.hoisted(() => ({
  subscribeActiveEntry: vi.fn(),
  updateLayer: vi.fn(),
  resetLayer: vi.fn(),
}));
vi.mock("../../runtime/scene-pack-registry", () => ({
  getSceneRegistry: () => ({ subscribeActiveEntry }),
}));
vi.mock("../scene/scene-layer-bridge", () => ({
  getSceneLayerBridge: () => ({ updateLayer, resetLayer }),
}));

import { SceneLayerControls } from "./scene-layer-controls";

let activeEntry: ScenePackEntry | null;
const listeners = new Set<(entry: ScenePackEntry | null) => void>();
const sceneEntry = (id: string, layers: readonly Layer[]): ScenePackEntry => ({
  id,
  origin: "bundled",
  manifest: { id, type: "scene", version: "0.1.0", yorishiroVersion: "^0.1.0", entry: "scene.ts" },
  scene: { id, layers },
});
const bg: Layer = { id: "backdrop", role: "background" };
const fg: Layer = { id: "overlay", role: "foreground" };
const inputs = () => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="file"]'));

function activate(entry: ScenePackEntry | null) {
  act(() => {
    activeEntry = entry;
    for (const listener of listeners) listener(entry);
  });
}

beforeEach(() => {
  activeEntry = null;
  listeners.clear();
  vi.clearAllMocks();
  subscribeActiveEntry.mockImplementation((listener: (entry: ScenePackEntry | null) => void) => {
    listeners.add(listener);
    listener(activeEntry);
    return { dispose: () => listeners.delete(listener) };
  });
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn((file: File) => `blob:${file.name}`);
      static revokeObjectURL = vi.fn();
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Scene layer controls", () => {
  it("exposes foreground only when the background is procedural, including StrictMode inputs", () => {
    activeEntry = sceneEntry("cafe", [{ ...bg, procedural: { kind: "misty-grasslands" } }, fg]);
    const { result } = renderHook(() => useCreateStore());
    render(
      <StrictMode>
        <SceneLayerControls store={result.current} />
      </StrictMode>,
    );
    const paths = result.current.getVisiblePaths();
    expect(paths).toContain("scene layers.foregroundOpacity");
    expect(paths).toContain("scene layers.load fg");
    expect(paths.some((path) => /background| bg$/.test(path))).toBe(false);
    expect(inputs()).toHaveLength(1);
    const input = inputs()[0];
    const click = vi.spyOn(input, "click");
    const load = result.current.getInput("scene layers.load fg");
    if (!load || !("onClick" in load) || typeof load.onClick !== "function") {
      throw new Error("expected a foreground load button");
    }
    load.onClick();
    expect(click).toHaveBeenCalledOnce();
    fireEvent.change(input, {
      target: { files: [new File(["image"], "leaves.png", { type: "image/png" })] },
    });
    expect(updateLayer).toHaveBeenLastCalledWith(
      { role: "foreground" },
      { src: "blob:leaves.png", mediaType: "image" },
    );
  });

  it("removes obsolete roles and input listeners while preserving the remaining role on hot reload", () => {
    activeEntry = sceneEntry("room", [bg, fg]);
    const { result } = renderHook(() => useCreateStore());
    const { unmount } = render(<SceneLayerControls store={result.current} />);
    const [background, foreground] = inputs();
    expect(result.current.getVisiblePaths()).toContain("scene layers.backgroundOpacity");
    fireEvent.change(background, {
      target: { files: [new File(["bg"], "bg.png", { type: "image/png" })] },
    });
    fireEvent.change(foreground, {
      target: { files: [new File(["fg"], "fg.png", { type: "image/png" })] },
    });

    activate(sceneEntry("room", [fg]));
    expect(inputs()).toEqual([foreground]);
    expect(result.current.getVisiblePaths().some((path) => /background| bg$/.test(path))).toBe(
      false,
    );
    expect(result.current.get("scene layers.foregroundFile")).toBe("fg.png");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:bg.png");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:fg.png");
    updateLayer.mockClear();
    fireEvent.change(background, { target: { files: [new File(["old"], "stale.png")] } });
    expect(updateLayer).not.toHaveBeenCalled();

    activate(sceneEntry("another-room", [bg]));
    expect(inputs()).toHaveLength(1);
    expect(inputs()[0]).not.toBe(background);
    expect(inputs()[0]).not.toBe(foreground);
    expect(result.current.get("scene layers.backgroundFile")).toBe("(none)");
    expect(result.current.getVisiblePaths()).toContain("scene layers.backgroundOpacity");
    expect(result.current.getVisiblePaths().some((path) => /foreground| fg$/.test(path))).toBe(
      false,
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fg.png");

    activate(sceneEntry("empty", []));
    expect(result.current.getVisiblePaths()).toEqual([]);
    expect(inputs()).toHaveLength(0);
    unmount();
    expect(listeners.size).toBe(0);
  });
});
