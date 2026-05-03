/**
 * 廃工場の大気効果. 浮遊粒子 (DustMotes) と天光柱 (GodRays).
 *
 * DustMotes: THREE.Points + additive blending で漂う微粒子.
 *   決定論的 LCG 乱数で位置 / phase / size を生成し、
 *   vertex shader で sin 揺動、fragment で soft glow circle を描画.
 *
 * GodRays: ConeGeometry + ShaderMaterial で fake volumetric light pillar.
 *   天井の隙間から差し込む光を表現.
 */

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { PALETTE } from "./palette";

/* ---- 決定論的 LCG 乱数 ---- */

const SEED = 0xa11ce;

/** Linear Congruential Generator. state を closure で保持. */
function createLcg(seed: number) {
  let s = seed | 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) | 0;
    return (s >>> 0) / 0x100000000;
  };
}

/* ---- DustMotes ---- */

const MOTE_COUNT = 200;

const dustVertexShader = /* glsl */ `
uniform float uTime;

attribute float aPhase;
attribute float aSize;

varying float vAlpha;

void main() {
  /* sin 揺動: 各 mote が独自の phase で緩やかに漂う */
  vec3 pos = position;
  float freq = 0.15;
  pos.x += sin(uTime * freq + aPhase) * 0.3;
  pos.y += sin(uTime * freq * 0.7 + aPhase * 1.3) * 0.15;
  pos.z += sin(uTime * freq * 0.5 + aPhase * 0.7) * 0.25;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;
  gl_PointSize = aSize * (300.0 / -mvPos.z);

  /* alpha を sin wave で明滅 */
  vAlpha = 0.3 + 0.7 * (0.5 + 0.5 * sin(uTime * 0.4 + aPhase * 2.0));
}
`;

const dustFragmentShader = /* glsl */ `
uniform vec3 uColor;

varying float vAlpha;

void main() {
  /* soft glow circle: 中心から smoothstep で減衰 */
  float dist = length(gl_PointCoord - vec2(0.5));
  float glow = 1.0 - smoothstep(0.0, 0.5, dist);

  gl_FragColor = vec4(uColor, glow * vAlpha);
}
`;

/**
 * 浮遊粒子 component.
 *
 * 14x4x14 の空間に 200 個の微粒子を散布.
 * additive blending で柔らかく光る.
 */
export function DustMotes() {
  const pointsRef = useRef<THREE.Points>(null);

  const { geometry, material } = useMemo(() => {
    const rng = createLcg(SEED);

    const positions = new Float32Array(MOTE_COUNT * 3);
    const phases = new Float32Array(MOTE_COUNT);
    const sizes = new Float32Array(MOTE_COUNT);

    for (let i = 0; i < MOTE_COUNT; i++) {
      /* x: -7..+7, y: 0.5..4.5, z: -7..+7 */
      positions[i * 3] = (rng() - 0.5) * 14;
      positions[i * 3 + 1] = rng() * 4 + 0.5;
      positions[i * 3 + 2] = (rng() - 0.5) * 14;
      phases[i] = rng() * Math.PI * 2;
      sizes[i] = 4 + rng() * 4; // 4..8 pt
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: PALETTE.hazeColor },
      },
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    return { geometry: geo, material: mat };
  }, []);

  useFrame((_state, delta) => {
    const points = pointsRef.current;
    if (points) {
      const mat = points.material as THREE.ShaderMaterial;
      mat.uniforms.uTime.value += delta;
    }
  });

  return <primitive ref={pointsRef} object={new THREE.Points(geometry, material)} />;
}

/* ---- GodRays ---- */

const godRaysVertexShader = /* glsl */ `
varying float vY;

void main() {
  vY = position.y;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const godRaysFragmentShader = /* glsl */ `
uniform float uTime;
uniform vec3 uColor;

varying float vY;

void main() {
  /* 上部から下部へ fade */
  float topFade = smoothstep(3.0, -3.0, vY);
  /* 微細なノイズで揺らぎ */
  float noise = sin(uTime * 0.3 + vY * 2.0);
  float alpha = topFade * 0.08 * (0.7 + noise * 0.3);

  gl_FragColor = vec4(uColor, alpha);
}
`;

/**
 * 天光柱 component. fake volumetric light.
 *
 * 天井の隙間から差し込む光を ConeGeometry + ShaderMaterial で表現.
 * additive blending + double-sided で柔らかく光る円錐.
 */
export function GodRays() {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: PALETTE.skylight },
    }),
    [],
  );

  useFrame((_state, delta) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value += delta;
    }
  });

  return (
    <mesh position={[-1.5, 3, 0]} rotation={[0, 0, Math.PI * 0.05]}>
      <coneGeometry args={[1.2, 6, 16, 1, true]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={godRaysVertexShader}
        fragmentShader={godRaysFragmentShader}
        transparent
        depthWrite={false}
        side={THREE.DoubleSide}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}
