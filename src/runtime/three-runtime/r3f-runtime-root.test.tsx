// @vitest-environment jsdom

/**
 * R3fRuntimeRoot の test。
 *
 * R3F context が test 環境でセットアップされていないため、useFrame は no-op に
 * mock する。本 test の関心は subscribeActiveEntry との接続と component mount。
 */

import { act, cleanup, render } from "@testing-library/react";
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
    setDefaultLightsEnabled: vi.fn(),
  }),
}));

import { getSceneRegistry } from "../scene-pack-registry";
import { R3fRuntimeRoot } from "./r3f-runtime-root";

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
      charminalVersion: "^0.1.0",
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
});
