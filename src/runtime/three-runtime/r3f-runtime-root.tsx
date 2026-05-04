/**
 * ThreeRuntime が管理する R3F content の root。
 *
 * 役割:
 *   - ScenePackRegistry を subscribe し、active pack に component があれば
 *     R3F tree に mount する。
 *   - debug cube は localStorage opt-in の確認用として残す。
 *     有効化: localStorage.setItem("charminal:r3f-debug", "1") + reload
 *     無効化: localStorage.removeItem("charminal:r3f-debug") + reload
 *   - VRM は本 phase では imperative のまま。vrmSlot prop は null を渡す。
 *
 * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §4
 */

import { useFrame } from "@react-three/fiber";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type * as THREE from "three";
import type { Disposable, Vec3 } from "../../sdk/context";
import type { ScenePackCameraAPI } from "../../sdk/scene-pack";
import { getSceneRegistry } from "../scene-pack-registry";
import { BUNDLED_ASSETS } from "../scene-pack-registry/asset-resolver";
import { makeResolveAsset } from "../scene-pack-registry/asset-resolver-pack";
import type { ScenePackEntry } from "../scene-pack-registry/types";
import { getThreeRuntime } from "../three-runtime";

export interface R3fRuntimeRootProps {
  readonly children?: ReactNode;
}

export function R3fRuntimeRoot({ children }: R3fRuntimeRootProps) {
  const [activeEntry, setActiveEntry] = useState<ScenePackEntry | null>(null);

  useEffect(() => {
    const registry = getSceneRegistry();
    const subscription = registry.subscribeActiveEntry((entry) => {
      setActiveEntry(entry);
    });
    return () => {
      subscription.dispose();
    };
  }, []);

  const debugEnabled = useMemo(() => {
    try {
      return localStorage.getItem("charminal:r3f-debug") === "1";
    } catch {
      return false;
    }
  }, []);

  const ActiveComponent = activeEntry?.component;

  return (
    <>
      {debugEnabled ? <R3fDebugCube /> : null}
      {ActiveComponent ? (
        <ActivePackComponent Component={ActiveComponent} entry={activeEntry} />
      ) : null}
      {children}
    </>
  );
}

interface ActivePackComponentProps {
  readonly Component: NonNullable<ScenePackEntry["component"]>;
  readonly entry: ScenePackEntry;
}

function ActivePackComponent({ Component, entry }: ActivePackComponentProps) {
  const resolveAsset = useMemo(
    () =>
      makeResolveAsset({
        packId: entry.id,
        origin: entry.origin,
        bundledAssets: BUNDLED_ASSETS,
      }),
    [entry.id, entry.origin],
  );

  // R3F-component pack は独自 lighting を持つので ThreeRuntime の built-in
  // lights を disable する. unmount 時に restore.
  useEffect(() => {
    getThreeRuntime().setDefaultLightsEnabled(false);
    return () => {
      getThreeRuntime().setDefaultLightsEnabled(true);
    };
  }, []);

  const camera = useMemo<ScenePackCameraAPI>(() => {
    const mod = getThreeRuntime().getCameraModulation();
    return {
      addPositionModulation(
        key: string,
        evaluate: (elapsed: number, delta: number) => Vec3,
      ): Disposable {
        return mod.addPositionModulation(key, evaluate);
      },
      addFovModulation(
        key: string,
        evaluate: (elapsed: number, delta: number) => number,
      ): Disposable {
        return mod.addFovModulation(key, evaluate);
      },
      clearAll(): void {
        mod.clearAll();
      },
      get isSuspended(): boolean {
        return getThreeRuntime().isCameraModulationSuspended();
      },
    };
  }, []);

  // Pack unmount 時に全 modulation を解除
  useEffect(() => {
    return () => {
      getThreeRuntime().getCameraModulation().clearAll();
    };
  }, []);

  return <Component vrmSlot={null} resolveAsset={resolveAsset} camera={camera} />;
}

function R3fDebugCube() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.rotation.x += delta * 0.7;
    mesh.rotation.y += delta * 1.1;
  });

  return (
    <mesh ref={meshRef} position={[0.12, 1.4, 0.05]} scale={0.06}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color="#4dd9cf" wireframe />
    </mesh>
  );
}
