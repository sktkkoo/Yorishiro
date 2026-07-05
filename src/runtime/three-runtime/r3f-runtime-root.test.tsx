// @vitest-environment jsdom

/**
 * R3fRuntimeRoot の test。
 *
 * R3F context が test 環境でセットアップされていないため、useFrame は no-op に
 * mock する。本 test の関心は subscribeActiveEntry との接続と component mount。
 */

import { act, cleanup, render } from "@testing-library/react";
import { levaStore } from "leva";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ScenePackComponentProps } from "../../sdk/scene-pack";
import type { ScenePackEntry, ScenePackRegistry } from "../scene-pack-registry/types";

vi.mock("@react-three/fiber", () => ({
  useFrame: vi.fn(),
}));

type ActiveEntryListener = (entry: ScenePackEntry | null) => void;

interface SceneRegistryHarness extends ScenePackRegistry {
  readonly __setActive: (entry: ScenePackEntry | null) => void;
  readonly __subscriberCount: () => number;
  readonly __reset: () => void;
}

vi.mock("../scene-pack-registry", () => {
  const subscribers = new Set<ActiveEntryListener>();
  let activeEntry: ScenePackEntry | null = null;

  const registry: SceneRegistryHarness = {
    register: () => ({ dispose: () => {} }),
    getActiveScene: () => activeEntry?.scene ?? null,
    getActiveEntry: () => activeEntry,
    subscribeActive: (listener) => {
      listener(activeEntry?.scene ?? null);
      return { dispose: () => {} };
    },
    subscribeActiveEntry: (listener) => {
      subscribers.add(listener);
      listener(activeEntry);
      return {
        dispose: () => {
          subscribers.delete(listener);
        },
      };
    },
    setActiveScene: () => {},
    getActiveSceneId: () => activeEntry?.id ?? null,
    listEntries: () => (activeEntry === null ? [] : [activeEntry]),
    __setActive: (entry) => {
      activeEntry = entry;
      for (const subscriber of subscribers) {
        subscriber(entry);
      }
    },
    __subscriberCount: () => subscribers.size,
    __reset: () => {
      activeEntry = null;
      subscribers.clear();
    },
  };

  return {
    getSceneRegistry: () => registry,
  };
});

vi.mock("../scene-pack-registry/asset-resolver", () => ({
  BUNDLED_ASSETS: {
    "/bundled-packs/scenes/with-component/assets/model.glb": "/resolved/model.glb",
  },
  isAbsoluteUrl: (src: string): boolean => /^(https?|asset|data|blob|file):/i.test(src),
  stripLeadingDotSlash: (src: string): string => (src.startsWith("./") ? src.slice(2) : src),
}));

vi.mock("../three-runtime", () => ({
  getThreeRuntime: () => ({
    setCameraTracking: vi.fn(),
    getCameraTracking: () => true,
    getCamera: () => ({
      position: { x: 0, y: 1.35, z: 1.1, set: vi.fn() },
      fov: 50,
      lookAt: vi.fn(),
      updateProjectionMatrix: vi.fn(),
    }),
    getCameraModulation: () => ({
      addPositionModulation: () => ({ dispose: () => {} }),
      addFovModulation: () => ({ dispose: () => {} }),
      clearAll: () => {},
    }),
    isCameraModulationSuspended: () => false,
  }),
}));

import simpleRoomDefinition from "../../../bundled-packs/scenes/simple-room/scene";
import { controlFolder, useYorishiroControls } from "../../sdk/controls";
import { getSceneRegistry } from "../scene-pack-registry";
import { R3fRuntimeRoot } from "./r3f-runtime-root";
import { getActiveSceneLevaStore } from "./scene-pack-leva-store";

function getMockRegistry(): SceneRegistryHarness {
  return getSceneRegistry() as SceneRegistryHarness;
}

function makeEntry(id: string, component?: ComponentType<ScenePackComponentProps>): ScenePackEntry {
  const entry: ScenePackEntry = {
    id,
    origin: "bundled",
    manifest: {
      id,
      type: "scene",
      version: "0.1.0",
      yorishiroVersion: "^0.1.0",
      entry: "scene.ts",
    },
    scene: {
      id,
      layers: [],
    },
  };

  if (component === undefined) return entry;
  return { ...entry, component };
}

afterEach(() => {
  cleanup();
  getMockRegistry().__reset();
  levaStore.dispose();
  vi.clearAllMocks();
});

describe("R3fRuntimeRoot", () => {
  it("subscribes to active entry and disposes on unmount", () => {
    const registry = getMockRegistry();
    const afterUnmountRender = vi.fn((props: ScenePackComponentProps) => {
      void props;
    });
    const AfterUnmountComponent = (props: ScenePackComponentProps) => {
      afterUnmountRender(props);
      return null;
    };

    const { container, unmount } = render(
      <R3fRuntimeRoot>
        <div data-testid="child" />
      </R3fRuntimeRoot>,
    );

    expect(registry.__subscriberCount()).toBe(1);
    expect(container.querySelector("[data-testid='child']")).not.toBeNull();

    unmount();

    expect(registry.__subscriberCount()).toBe(0);
    registry.__setActive(makeEntry("after-unmount", AfterUnmountComponent));
    expect(afterUnmountRender).not.toHaveBeenCalled();
  });

  it("renders the active pack component with scene pack props", () => {
    const renderedProps: ScenePackComponentProps[] = [];
    const FakeComponent = (props: ScenePackComponentProps) => {
      renderedProps.push(props);
      return null;
    };

    getMockRegistry().__setActive(makeEntry("with-component", FakeComponent));

    render(<R3fRuntimeRoot />);

    expect(renderedProps).toHaveLength(1);
    const [props] = renderedProps;
    if (props === undefined) throw new Error("FakeComponent が render されていない");
    expect(props.vrmSlot).toBeNull();
    expect("controls" in props).toBe(false);
    expect(props.resolveAsset("./assets/model.glb")).toBe("/resolved/model.glb");
  });

  it("re-renders when active entry changes", () => {
    const registry = getMockRegistry();
    const firstRender = vi.fn((props: ScenePackComponentProps) => {
      void props;
    });
    const secondRender = vi.fn((props: ScenePackComponentProps) => {
      void props;
    });
    const FirstComponent = (props: ScenePackComponentProps) => {
      firstRender(props);
      return null;
    };
    const SecondComponent = (props: ScenePackComponentProps) => {
      secondRender(props);
      return null;
    };

    render(<R3fRuntimeRoot />);

    act(() => {
      registry.__setActive(makeEntry("first", FirstComponent));
    });
    expect(firstRender).toHaveBeenCalledTimes(1);

    firstRender.mockClear();
    secondRender.mockClear();

    act(() => {
      registry.__setActive(makeEntry("second", SecondComponent));
    });
    expect(firstRender).not.toHaveBeenCalled();
    expect(secondRender).toHaveBeenCalledTimes(1);

    secondRender.mockClear();

    act(() => {
      registry.__setActive(makeEntry("no-component"));
    });
    expect(secondRender).not.toHaveBeenCalled();
  });

  it("mounts scene pack leva controls into the active scene store", () => {
    const registry = getMockRegistry();
    const SceneWithLights = () => {
      useYorishiroControls("lights", () => ({
        directionalColor: { value: "#ff8800", label: "light color" },
      }));
      return null;
    };

    render(<R3fRuntimeRoot />);

    act(() => {
      registry.__setActive(makeEntry("with-lights", SceneWithLights));
    });
    const sceneStore = getActiveSceneLevaStore();
    expect(sceneStore?.get("lights.directionalColor")).toBe("#ff8800");
    expect(levaStore.get("lights.directionalColor")).toBeUndefined();

    act(() => {
      registry.__setActive(null);
    });
    expect(getActiveSceneLevaStore()).toBeNull();
    expect(sceneStore?.getVisiblePaths()).not.toContain("lights.directionalColor");
  });

  it("does not reuse shared leva paths across scene packs", () => {
    const registry = getMockRegistry();
    const FirstScene = () => {
      useYorishiroControls("lights", () => ({
        ambientIntensity: { value: 0.05, label: "ambient" },
      }));
      return null;
    };
    const SecondScene = () => {
      useYorishiroControls("lights", () => ({
        ambientIntensity: { value: 0.4, label: "ambient" },
      }));
      return null;
    };

    render(<R3fRuntimeRoot />);

    act(() => {
      registry.__setActive(makeEntry("first", FirstScene));
    });
    expect(getActiveSceneLevaStore()?.get("lights.ambientIntensity")).toBe(0.05);

    act(() => {
      registry.__setActive(makeEntry("second", SecondScene));
    });
    expect(getActiveSceneLevaStore()?.get("lights.ambientIntensity")).toBe(0.4);
  });

  it("registers multiple sdk controls folders into the active scene store", () => {
    const registry = getMockRegistry();
    const SceneWithSdkControls = () => {
      useYorishiroControls("lights", () => ({
        directionalIntensity: { value: 0.8, min: 0, max: 3 },
      }));
      useYorishiroControls("post effects", () => ({
        bloom: controlFolder({
          bloomIntensity: { value: 1, min: 0, max: 3 },
        }),
      }));
      useYorishiroControls("post effects", () => ({
        vignette: controlFolder({
          vignetteDarkness: { value: 0.8, min: 0, max: 2 },
        }),
      }));
      return null;
    };

    render(<R3fRuntimeRoot />);

    act(() => {
      registry.__setActive(makeEntry("with-sdk-controls", SceneWithSdkControls));
    });

    const sceneStore = getActiveSceneLevaStore();
    expect(sceneStore?.get("lights.directionalIntensity")).toBe(0.8);
    expect(sceneStore?.get("post effects.bloom.bloomIntensity")).toBe(1);
    expect(sceneStore?.get("post effects.vignette.vignetteDarkness")).toBe(0.8);
  });

  it("registers sdk controls from bundled scene child components", () => {
    const registry = getMockRegistry();

    render(<R3fRuntimeRoot />);

    act(() => {
      registry.__setActive(makeEntry("simple-room", simpleRoomDefinition.component));
    });

    const sceneStore = getActiveSceneLevaStore();
    expect(sceneStore?.get("lights.intensity")).toBe(1.2);
    expect(sceneStore?.get("lights.color")).toBe("#ffe8ea");
    expect(levaStore.get("lights.intensity")).toBeUndefined();
  });

  it("registers scene layer controls into the active scene store", () => {
    const registry = getMockRegistry();
    const layeredEntry: ScenePackEntry = {
      ...makeEntry("layered-scene"),
      scene: {
        id: "layered-scene",
        layers: [
          { id: "background", role: "background" },
          { id: "foreground", role: "foreground" },
        ],
      },
    };

    render(<R3fRuntimeRoot />);

    act(() => {
      registry.__setActive(layeredEntry);
    });

    const sceneStore = getActiveSceneLevaStore();
    expect(sceneStore?.get("scene layers.backgroundBlur")).toBe(0);
    expect(sceneStore?.get("scene layers.foregroundBlur")).toBe(0);
    expect(levaStore.get("scene layers.backgroundBlur")).toBeUndefined();
  });
});
