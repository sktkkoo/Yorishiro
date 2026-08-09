/**
 * ThreeRuntime が管理する R3F content の root。
 *
 * 役割:
 *   - ScenePackRegistry を subscribe し、active pack に component があれば
 *     R3F tree に mount する。
 *   - debug cube は localStorage opt-in の確認用として残す。
 *     有効化: localStorage.setItem("yorishiro:r3f-debug", "1") + reload
 *     無効化: localStorage.removeItem("yorishiro:r3f-debug") + reload
 *   - 発話反射層の leva controls も localStorage opt-in。voice_say の発話中しか
 *     効かない条件依存の調整卓なので、Common panel には常駐させない。mount して
 *     いない間も body 側の既定値で反射層は動く（Body の初期値と controls の初期
 *     値が同一なため）。
 *     有効化: localStorage.setItem("yorishiro:speech-debug", "1") + reload
 *     無効化: localStorage.removeItem("yorishiro:speech-debug") + reload
 *   - VRM は本 phase では imperative のまま。vrmSlot prop は null を渡す。
 *
 * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §4
 */

import { useFrame } from "@react-three/fiber";
import { useCreateStore } from "leva";
import {
  type ErrorInfo,
  Component as ReactComponent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type * as THREE from "three";
import {
  CameraControls,
  SceneLayerControls,
  SpeechExpressionControls,
} from "../../core/debug-controls";
import type { Disposable, Vec3 } from "../../sdk/context";
import { ControlStoreProvider } from "../../sdk/controls";
import type { ScenePackCameraAPI } from "../../sdk/scene-pack";
import { getSceneRegistry } from "../scene-pack-registry";
import { BUNDLED_ASSETS } from "../scene-pack-registry/asset-resolver";
import { makeResolveAsset } from "../scene-pack-registry/asset-resolver-pack";
import type { ScenePackEntry } from "../scene-pack-registry/types";
import { getThreeRuntime } from "../three-runtime";
import { DefaultAttentionCueLight } from "./attention-cue-light";
import { setRuntimeLevaStore } from "./runtime-leva-store";
import { clearActiveSceneLevaStore, setActiveSceneLevaStore } from "./scene-pack-leva-store";

export interface R3fRuntimeRootProps {
  readonly children?: ReactNode;
}

/** localStorage の debug opt-in flag を読む。access 不能な環境では無効扱いにする。 */
function readDebugFlag(key: string): boolean {
  try {
    return localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function R3fRuntimeRoot({ children }: R3fRuntimeRootProps) {
  const [activeEntry, setActiveEntry] = useState<ScenePackEntry | null>(null);
  const runtimeLevaStore = useCreateStore();

  useEffect(() => {
    const registry = getSceneRegistry();
    const subscription = registry.subscribeActiveEntry((entry) => {
      setActiveEntry(entry);
    });
    return () => {
      subscription.dispose();
    };
  }, []);

  const debugEnabled = useMemo(() => readDebugFlag("yorishiro:r3f-debug"), []);
  const speechDebugEnabled = useMemo(() => readDebugFlag("yorishiro:speech-debug"), []);

  useEffect(() => {
    setRuntimeLevaStore(runtimeLevaStore);
    return () => {
      setRuntimeLevaStore(null);
      runtimeLevaStore.dispose();
    };
  }, [runtimeLevaStore]);

  return (
    <>
      {debugEnabled ? <R3fDebugCube /> : null}
      {activeEntry ? (
        <ActiveSceneControlsBoundary key={activeEntry.id} entry={activeEntry} />
      ) : null}
      <DefaultAttentionCueLight />
      <CameraControls store={runtimeLevaStore} />
      {speechDebugEnabled ? <SpeechExpressionControls store={runtimeLevaStore} /> : null}
      {children}
    </>
  );
}

interface ActiveSceneControlsBoundaryProps {
  readonly entry: ScenePackEntry;
}

function ActiveSceneControlsBoundary({ entry }: ActiveSceneControlsBoundaryProps) {
  const sceneLevaStore = useCreateStore();
  const resolveAsset = useMemo(
    () =>
      makeResolveAsset({
        packId: entry.id,
        origin: entry.origin,
        bundledAssets: BUNDLED_ASSETS,
      }),
    [entry.id, entry.origin],
  );

  const camera = useMemo<ScenePackCameraAPI>(() => {
    const mod = getThreeRuntime().getCameraModulation();
    return {
      addPositionModulation(
        key: string,
        evaluate: (elapsed: number, delta: number, out: Vec3) => Vec3 | undefined,
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

  useEffect(() => {
    setActiveSceneLevaStore(sceneLevaStore);
    return () => {
      clearActiveSceneLevaStore(sceneLevaStore);
    };
  }, [sceneLevaStore]);

  const Component = entry.component;

  return (
    <ControlStoreProvider store={sceneLevaStore}>
      {Component ? (
        <SceneComponentErrorBoundary sceneId={entry.id} component={Component}>
          <Component vrmSlot={null} resolveAsset={resolveAsset} camera={camera} />
        </SceneComponentErrorBoundary>
      ) : null}
      <SceneLayerControls store={sceneLevaStore} />
    </ControlStoreProvider>
  );
}

interface SceneComponentErrorBoundaryProps {
  readonly sceneId: string;
  readonly component: ScenePackEntry["component"];
  readonly children: ReactNode;
}

interface SceneComponentErrorBoundaryState {
  readonly failed: boolean;
}

/**
 * A broken scene must not tear down the shared R3F root. The VRM is owned by
 * ThreeRuntime outside this React tree, so keep it visible with neutral
 * fallback lighting while preserving common controls and scene switching.
 */
class SceneComponentErrorBoundary extends ReactComponent<
  SceneComponentErrorBoundaryProps,
  SceneComponentErrorBoundaryState
> {
  state: SceneComponentErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): SceneComponentErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(
      `[r3f-runtime] scene '${this.props.sceneId}' crashed; using fallback lighting`,
      error,
      info.componentStack,
    );
  }

  componentDidUpdate(previousProps: SceneComponentErrorBoundaryProps): void {
    if (this.state.failed && previousProps.component !== this.props.component) {
      this.setState({ failed: false });
    }
  }

  render(): ReactNode {
    if (this.state.failed) return <FailedSceneLighting />;
    return this.props.children;
  }
}

function FailedSceneLighting() {
  return (
    <>
      <hemisphereLight
        name="yorishiro-scene-error-fill"
        color="#fff4ed"
        groundColor="#30343a"
        intensity={1.1}
      />
      <directionalLight
        name="yorishiro-scene-error-key"
        position={[-1.5, 2.5, 2]}
        intensity={1.2}
        color="#ffffff"
      />
    </>
  );
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
