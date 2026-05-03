/**
 * CRT 画面の砂嵐 procedural shader.
 *
 * CRT_POSITION の前面に小さな plane を配置し、
 * 高頻度 noise + scanline + sync drop で CRT モニタの砂嵐を表現.
 */

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type * as THREE from "three";
import { CRT_POSITION } from "./lights";

/* ---- shader ---- */

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;

varying vec2 vUv;

/* 簡易 hash. pseudo-random noise 生成用 */
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  /* 高頻度 noise: UV をスケーリングして時間で変化 */
  float noise = hash(vUv * 1000.0 + uTime * 10.0);

  /* 水平 scanline: y 方向に密な stripe */
  float scan = step(0.5, fract(vUv.y * 200.0));

  /* sync drop: 時間ベースの垂直バー (低確率で出現) */
  float dropSeed = hash(vec2(floor(uTime * 3.0), 0.0));
  float dropX = hash(vec2(floor(uTime * 3.0), 1.0));
  float dropMask = step(0.85, dropSeed) * step(abs(vUv.x - dropX), 0.03);

  /* 最終合成 */
  vec3 color = vec3(noise * (0.7 + scan * 0.2)) + dropMask * vec3(0.6, 0.7, 0.9);
  gl_FragColor = vec4(color, 1.0);
}
`;

/* ---- component ---- */

/**
 * CRT 砂嵐 plane. CRT_POSITION の少し手前に配置.
 *
 * ShaderMaterial の uTime を useFrame で毎フレーム更新.
 */
export function CrtScreen() {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
    }),
    [],
  );

  useFrame((_state, delta) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value += delta;
    }
  });

  return (
    <mesh
      position={[CRT_POSITION[0], CRT_POSITION[1], CRT_POSITION[2] + 0.05]}
      rotation={[0, Math.PI / 6, 0]}
    >
      <planeGeometry args={[0.4, 0.3]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
      />
    </mesh>
  );
}
