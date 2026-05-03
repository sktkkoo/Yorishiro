/**
 * abandoned-factory の GLTF props.
 * asset が欠ける場合は placeholder box を表示.
 *
 * useGLTF で GLB を load し、Suspense fallback で placeholder box を表示.
 * asset が存在しない場合でも scene 全体が壊れない graceful degradation.
 */

import { useGLTF } from "@react-three/drei";
import { Suspense, useMemo } from "react";
import type { Euler } from "three";
import * as THREE from "three";
import { CRT_POSITION, LANTERN_POSITION } from "./lights";

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
  url: string;
  position: readonly [number, number, number];
  rotation?: readonly [number, number, number];
  scale?: number | readonly [number, number, number];
  placeholderColor?: string;
}

interface AbandonedFactoryPropsProps {
  resolveAsset: (relativePath: string) => string;
}

/**
 * 廃工場の GLTF prop 群を Suspense 付きで mount.
 *
 * 各 prop は Suspense fallback で placeholder box を表示するため、
 * GLB asset が欠落していても scene は正常に動作する.
 */
export function AbandonedFactoryProps({ resolveAsset }: AbandonedFactoryPropsProps) {
  const entries: PropEntry[] = useMemo(
    () => [
      {
        id: "lantern",
        url: resolveAsset("./assets/lantern.glb"),
        position: LANTERN_POSITION,
        placeholderColor: "#f29e52",
      },
      {
        id: "crt-tv",
        url: resolveAsset("./assets/crt-tv.glb"),
        position: CRT_POSITION,
        placeholderColor: "#b8d0f0",
      },
      {
        id: "chair",
        url: resolveAsset("./assets/chair.glb"),
        position: [1.2, 0, 0.3],
      },
      {
        id: "debris-1",
        url: resolveAsset("./assets/debris-1.glb"),
        position: [-0.8, 0, 0.5],
      },
      {
        id: "debris-2",
        url: resolveAsset("./assets/debris-2.glb"),
        position: [1.5, 0, -0.4],
      },
      {
        id: "machinery",
        url: resolveAsset("./assets/machinery.glb"),
        position: [-3.5, 0, -4],
      },
      {
        id: "oil-drum",
        url: resolveAsset("./assets/oil-drum.glb"),
        position: [3, 0, -3],
      },
      {
        id: "crates",
        url: resolveAsset("./assets/crates.glb"),
        position: [-2.5, 0, 2.5],
      },
    ],
    [resolveAsset],
  );

  return (
    <group>
      {entries.map((entry) => (
        <Suspense
          key={entry.id}
          fallback={<Placeholder position={entry.position} color={entry.placeholderColor} />}
        >
          <GLTFProp
            url={entry.url}
            position={entry.position}
            rotation={entry.rotation}
            scale={entry.scale}
          />
        </Suspense>
      ))}
    </group>
  );
}
