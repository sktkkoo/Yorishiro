/**
 * abandoned-factory の GLTF props.
 * asset が欠ける場合は placeholder box を表示.
 *
 * Asset 欠落検出の二段防御:
 *   1. `resolveAsset` が relativePath をそのまま返した場合 (BUNDLED_ASSETS で
 *      lookup miss) は useGLTF を呼ばずに直接 Placeholder を render. これで
 *      不要な fetch エラーと Suspense 永久 fallback を防ぐ.
 *   2. それでも GLTFProp 内で error が起きた場合は GltfErrorBoundary が catch
 *      して Placeholder にフォールスルー. 1 個の prop の error が他の R3F
 *      sibling まで unmount するのを防ぐ.
 */

import { useGLTF } from "@react-three/drei";
import { Component, type ReactNode, Suspense, useMemo } from "react";
import type { Euler } from "three";
import * as THREE from "three";
import { CRT_POSITION, LANTERN_POSITION } from "./lights";

/* ---- ErrorBoundary: GLTFLoader の throw を localize する ---- */

interface GltfErrorBoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

class GltfErrorBoundary extends Component<GltfErrorBoundaryProps, { hasError: boolean }> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.warn("[abandoned-factory] GLTF prop failed to load:", error.message);
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

/* ---- 内部: GLTF prop ---- */

interface GLTFPropProps {
  url: string;
  position: readonly [number, number, number];
  rotation?: Euler | readonly [number, number, number];
  scale?: number | readonly [number, number, number];
}

/** GLTF model を load して clone + shadow 設定して配置. */
function GLTFProp({ url, position, rotation, scale }: GLTFPropProps) {
  const { scene } = useGLTF(url);

  const cloned = useMemo(() => {
    const c = scene.clone(true);
    c.traverse((child) => {
      if (child instanceof THREE.Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    return c;
  }, [scene]);

  return (
    <primitive
      object={cloned}
      position={[...position]}
      rotation={rotation ? [...rotation] : undefined}
      scale={scale}
    />
  );
}

/* ---- 内部: placeholder box ---- */

interface PlaceholderProps {
  position: readonly [number, number, number];
  color?: string;
}

/** asset が未到着のとき表示する placeholder box. */
function Placeholder({ position, color = "#888888" }: PlaceholderProps) {
  return (
    <mesh position={[...position]}>
      <boxGeometry args={[0.3, 0.3, 0.3]} />
      <meshStandardMaterial color={color} />
    </mesh>
  );
}

/* ---- 公開: props 一式 ---- */

interface PropEntry {
  /** デバッグ用 ID. key にも使う. */
  id: string;
  /** Pack-relative path (resolveAsset 適用前) */
  relPath: string;
  position: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  scale?: number | readonly [number, number, number];
  placeholderColor?: string;
}

interface AbandonedFactoryPropsProps {
  resolveAsset: (relativePath: string) => string;
}

/**
 * 廃工場の GLTF prop 群.
 *
 * 各 entry につき:
 *   - resolveAsset(relPath) === relPath (= 解決失敗) なら直接 Placeholder.
 *   - 解決成功なら ErrorBoundary + Suspense でラップして GLTFProp を mount.
 *     ErrorBoundary は GLTFLoader の reject などの runtime error を localize.
 *     Suspense は load 中の loading promise を catch して Placeholder を表示.
 */
export function AbandonedFactoryProps({ resolveAsset }: AbandonedFactoryPropsProps) {
  const entries: PropEntry[] = useMemo(
    () => [
      {
        id: "lantern",
        relPath: "./assets/lantern.glb",
        position: LANTERN_POSITION,
        placeholderColor: "#f29e52",
      },
      {
        id: "crt-tv",
        relPath: "./assets/crt-tv.glb",
        position: CRT_POSITION,
        placeholderColor: "#b8d0f0",
      },
      {
        id: "chair",
        relPath: "./assets/chair.glb",
        position: [1.2, 0, 0.3],
      },
      {
        id: "debris-1",
        relPath: "./assets/debris-1.glb",
        position: [-0.8, 0, 0.5],
      },
      {
        id: "debris-2",
        relPath: "./assets/debris-2.glb",
        position: [1.5, 0, -0.4],
      },
      {
        id: "machinery",
        relPath: "./assets/machinery.glb",
        position: [-3.5, 0, -4],
      },
      {
        id: "oil-drum",
        relPath: "./assets/oil-drum.glb",
        position: [3, 0, -3],
      },
      {
        id: "crates",
        relPath: "./assets/crates.glb",
        position: [-2.5, 0, 2.5],
      },
    ],
    [],
  );

  return (
    <group>
      {entries.map((entry) => {
        const url = resolveAsset(entry.relPath);
        const placeholder = (
          <Placeholder position={entry.position} color={entry.placeholderColor} />
        );
        // resolveAsset が relPath をそのまま返した = BUNDLED_ASSETS lookup miss.
        // useGLTF を呼ばずに Placeholder のみ.
        if (url === entry.relPath) {
          return null;
        }
        return (
          <GltfErrorBoundary key={entry.id} fallback={placeholder}>
            <Suspense fallback={placeholder}>
              <GLTFProp
                url={url}
                position={entry.position}
                rotation={entry.rotation}
                scale={entry.scale}
              />
            </Suspense>
          </GltfErrorBoundary>
        );
      })}
    </group>
  );
}
