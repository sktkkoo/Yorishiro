/**
 * 廃工場の床面. wet concrete + puddles + cracks + moss の procedural shader.
 *
 * vertex shader: vUv / vDepth を pass.
 * fragment shader: hash21 / noise2 / voronoi で
 *   base concrete → wet patch → puddle → crack → moss → rust → depth haze
 * の順に重ねる.
 */

import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type * as THREE from "three";
import { FOG, PALETTE } from "./palette";

const vertexShader = /* glsl */ `
varying vec2 vUv;
varying float vDepth;

void main() {
  vUv = uv;
  vec4 mvPos = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mvPos.z;
  gl_Position = projectionMatrix * mvPos;
}
`;

const fragmentShader = /* glsl */ `
uniform float uTime;
uniform vec3 uConcreteRoot;
uniform vec3 uConcreteMid;
uniform vec3 uConcreteWet;
uniform vec3 uMossCool;
uniform vec3 uRustCool;
uniform vec3 uHazeColor;
uniform float uFogNear;
uniform float uFogFar;

varying vec2 vUv;
varying float vDepth;

/* ---- hash / noise helpers ---- */

vec2 hash21(vec2 p) {
  vec3 q = fract(p.xyx * vec3(123.34, 234.34, 345.65));
  q += dot(q, q.yzx + 33.33);
  return fract((q.xx + q.yz) * q.zy);
}

float noise2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);

  float a = dot(hash21(i + vec2(0.0, 0.0)), vec2(0.5)) * 2.0 - 1.0;
  float b = dot(hash21(i + vec2(1.0, 0.0)), vec2(0.5)) * 2.0 - 1.0;
  float c = dot(hash21(i + vec2(0.0, 1.0)), vec2(0.5)) * 2.0 - 1.0;
  float d = dot(hash21(i + vec2(1.0, 1.0)), vec2(0.5)) * 2.0 - 1.0;

  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

/* Voronoi — cell boundary distance を返す */
float voronoi(vec2 p) {
  vec2 n = floor(p);
  vec2 f2 = fract(p);
  float md = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 o = hash21(n + g);
      vec2 r = g + o - f2;
      float d = dot(r, r);
      md = min(md, d);
    }
  }
  return sqrt(md);
}

void main() {
  vec2 uv = vUv * 20.0;

  /* base concrete: root ↔ mid を noise で mix */
  float nBase = noise2(uv * 2.3) * 0.5 + 0.5;
  vec3 col = mix(uConcreteRoot, uConcreteMid, nBase);

  /* wet patch: 低周波 noise mask */
  float wetMask = smoothstep(0.3, 0.6, noise2(uv * 0.4 + 7.7) * 0.5 + 0.5);
  col = mix(col, uConcreteWet, wetMask * 0.5);

  /* puddle: hard mask — wet 領域のさらに濃い部分 */
  float puddleMask = smoothstep(0.65, 0.75, noise2(uv * 0.3 + 3.3) * 0.5 + 0.5);
  col = mix(col, uConcreteWet * 1.15, puddleMask * wetMask * 0.7);

  /* cracks: voronoi cell boundary */
  float voro = voronoi(uv * 1.2);
  float crackMask = 1.0 - smoothstep(0.02, 0.06, voro);
  col = mix(col, uConcreteRoot * 0.6, crackMask * 0.8);

  /* moss: 高密度 noise 領域 */
  float mossMask = smoothstep(0.55, 0.7, noise2(uv * 3.5 + 11.1) * 0.5 + 0.5);
  col = mix(col, uMossCool, mossMask * 0.4);

  /* rust streak: 縦方向 noise */
  float rustMask = smoothstep(0.5, 0.65, noise2(vec2(uv.x * 1.5, uv.y * 5.0) + 19.9) * 0.5 + 0.5);
  col = mix(col, uRustCool, rustMask * 0.25);

  /* depth haze: view-space distance fog */
  float fogFactor = smoothstep(uFogNear, uFogFar, vDepth);
  col = mix(col, uHazeColor, fogFactor);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 廃工場の床面 component.
 *
 * 40x40 の plane を XZ 平面に敷く.
 * procedural shader で wet concrete / puddles / cracks / moss / rust / haze を描画.
 */
export function Floor() {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uConcreteRoot: { value: PALETTE.concreteRoot },
      uConcreteMid: { value: PALETTE.concreteMid },
      uConcreteWet: { value: PALETTE.concreteWet },
      uMossCool: { value: PALETTE.mossCool },
      uRustCool: { value: PALETTE.rustCool },
      uHazeColor: { value: PALETTE.hazeColor },
      uFogNear: { value: FOG.near },
      uFogFar: { value: FOG.far },
    }),
    [],
  );

  useFrame((_state, delta) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value += delta;
    }
  });

  return (
    <mesh rotation-x={-Math.PI / 2} position={[0, 0, 0]} receiveShadow>
      <planeGeometry args={[40, 40, 1, 1]} />
      <shaderMaterial
        ref={matRef}
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
      />
    </mesh>
  );
}
