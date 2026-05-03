/**
 * 遠景の配管 forest silhouette.
 *
 * far zone (z = -10..-16) に細い box を 24 本立てて
 * 霧に溶ける industrial skyline を表現.
 * 決定論的 LCG 乱数で配置を固定.
 */

import { useMemo } from "react";
import * as THREE from "three";

/** 配管の本数. */
const PIPE_COUNT = 24;

/** LCG seed. */
const SEED = 0xf07e57b;

/** Linear Congruential Generator. state を closure で保持. */
function createLcg(seed: number) {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 0x100000000;
  };
}

/**
 * 遠景配管 component.
 *
 * 24 本の thin box を deterministic random で配置.
 * transparent + opacity 0.85 で霧に馴染む silhouette.
 */
export function DistantPipes() {
  const { geometry, material, matrices } = useMemo(() => {
    const rng = createLcg(SEED);

    const geo = new THREE.BoxGeometry(0.08, 5, 0.08);
    const mat = new THREE.MeshBasicMaterial({
      color: "#1a1f24",
      transparent: true,
      opacity: 0.85,
    });

    const mats: THREE.Matrix4[] = [];

    for (let i = 0; i < PIPE_COUNT; i++) {
      const x = rng() * 18 - 9; // -9..+9
      const z = -(rng() * 6 + 10); // -10..-16
      const y = 2.5 + rng() * 0.5; // 2.5..3.0
      const scale = 0.6 + rng() * 0.8; // 0.6..1.4

      const m = new THREE.Matrix4();
      m.compose(
        new THREE.Vector3(x, y, z),
        new THREE.Quaternion(),
        new THREE.Vector3(scale, scale, scale),
      );
      mats.push(m);
    }

    return { geometry: geo, material: mat, matrices: mats };
  }, []);

  return (
    <group>
      {matrices.map((matrix, i) => (
        <mesh
          key={`pipe-${i.toString()}`}
          geometry={geometry}
          material={material}
          matrix={matrix}
          matrixAutoUpdate={false}
        />
      ))}
    </group>
  );
}
