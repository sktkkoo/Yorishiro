/**
 * 廃工場の電線. 画面右上から左下へ対角に横切る 1 本の cable.
 *
 * CatmullRomCurve3 + TubeGeometry で catenary (懸垂線) を近似.
 * sin sag で中央を垂らし、useFrame で微細な風揺れを付与.
 */

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";

/** 分割数. 線形補間 + sin sag の解像度. */
const SEGMENTS = 32;

/** 始点・終点. */
const START = new THREE.Vector3(4, 5, -5);
const END = new THREE.Vector3(-4, 4, -3);

/** 中央の垂れ幅. */
const SAG = 0.4;

/**
 * 電線 component.
 *
 * 32 segment の catenary curve を TubeGeometry で描画.
 * meshBasicMaterial (黒に近い暗色) で silhouette 表現.
 */
export function PowerLine() {
  const meshRef = useRef<THREE.Mesh>(null);

  const geometry = useMemo(() => {
    const points: THREE.Vector3[] = [];

    for (let i = 0; i <= SEGMENTS; i++) {
      const t = i / SEGMENTS;
      /* 線形補間 */
      const x = THREE.MathUtils.lerp(START.x, END.x, t);
      const y = THREE.MathUtils.lerp(START.y, END.y, t);
      const z = THREE.MathUtils.lerp(START.z, END.z, t);
      /* sin sag: 中央で最大、両端で 0 */
      const sag = Math.sin(t * Math.PI) * SAG;
      points.push(new THREE.Vector3(x, y - sag, z));
    }

    const curve = new THREE.CatmullRomCurve3(points);
    return new THREE.TubeGeometry(curve, 64, 0.015, 6, false);
  }, []);

  useFrame(({ clock }) => {
    if (meshRef.current) {
      const t = clock.getElapsedTime();
      meshRef.current.rotation.z = Math.sin(t * 0.4) * 0.005;
    }
  });

  return (
    <mesh ref={meshRef} geometry={geometry}>
      <meshBasicMaterial color="#080a0c" />
    </mesh>
  );
}
