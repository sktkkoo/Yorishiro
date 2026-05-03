/**
 * 廃工場の壁面 (back / left / right の 3 枚).
 *
 * 床より decay は弱め. stain (grey) + vertical rust streak + depth haze.
 * puddles / voronoi cracks / moss は省略.
 */

import { useMemo } from "react";
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
uniform vec3 uConcreteRoot;
uniform vec3 uConcreteMid;
uniform vec3 uStainGrey;
uniform vec3 uRustCool;
uniform vec3 uHazeColor;
uniform float uFogNear;
uniform float uFogFar;

varying vec2 vUv;
varying float vDepth;

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

void main() {
  vec2 uv = vUv * 10.0;

  /* base concrete */
  float nBase = noise2(uv * 2.0) * 0.5 + 0.5;
  vec3 col = mix(uConcreteRoot, uConcreteMid, nBase);

  /* stain: grey の染み */
  float stainMask = smoothstep(0.4, 0.65, noise2(uv * 0.8 + 5.5) * 0.5 + 0.5);
  col = mix(col, uStainGrey, stainMask * 0.3);

  /* rust streak: 縦方向 */
  float rustMask = smoothstep(0.5, 0.7, noise2(vec2(uv.x * 1.2, uv.y * 6.0) + 13.7) * 0.5 + 0.5);
  col = mix(col, uRustCool, rustMask * 0.2);

  /* depth haze */
  float fogFactor = smoothstep(uFogNear, uFogFar, vDepth);
  col = mix(col, uHazeColor, fogFactor);

  gl_FragColor = vec4(col, 1.0);
}
`;

/** 壁 1 枚を描画する内部 component. */
function WallPlane({
  position,
  rotation,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
}) {
  const uniforms = useMemo(
    () => ({
      uConcreteRoot: { value: PALETTE.concreteRoot.clone() },
      uConcreteMid: { value: PALETTE.concreteMid.clone() },
      uStainGrey: { value: PALETTE.stainGrey.clone() },
      uRustCool: { value: PALETTE.rustCool.clone() },
      uHazeColor: { value: PALETTE.hazeColor.clone() },
      uFogNear: { value: FOG.near },
      uFogFar: { value: FOG.far },
    }),
    [],
  );

  return (
    <mesh position={position} rotation={rotation} receiveShadow>
      <planeGeometry args={[16, 6, 1, 1]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
      />
    </mesh>
  );
}

/**
 * 廃工場の壁面. back / left / right の 3 枚.
 *
 * VRM を囲むように配置. 床より decay が弱い (puddles / moss / voronoi なし).
 */
export function Walls() {
  return (
    <>
      {/* Back wall */}
      <WallPlane position={[0, 3, -8]} rotation={[0, 0, 0]} />
      {/* Left wall */}
      <WallPlane position={[-8, 3, 0]} rotation={[0, Math.PI / 2, 0]} />
      {/* Right wall */}
      <WallPlane position={[8, 3, 0]} rotation={[0, -Math.PI / 2, 0]} />
    </>
  );
}
