/**
 * 廃工場の天井. ほぼ闇、god-ray pillar 領域だけ faint skylight.
 *
 * floor / walls に比べて最もシンプルな shader.
 * uConcreteRoot ベースに skylight を中心付近にだけ薄く乗せる.
 */

import { useMemo } from "react";
import { PALETTE } from "./palette";

const vertexShader = /* glsl */ `
varying vec2 vUv;

void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const fragmentShader = /* glsl */ `
uniform vec3 uConcreteRoot;
uniform vec3 uSkylight;

varying vec2 vUv;

void main() {
  /* 中心からの距離で skylight の影響を falloff */
  vec2 center = vUv - 0.5;
  float dist = length(center);
  float skylightMask = smoothstep(0.4, 0.05, dist) * 0.15;

  vec3 col = mix(uConcreteRoot * 0.5, uSkylight, skylightMask);

  gl_FragColor = vec4(col, 1.0);
}
`;

/**
 * 廃工場の天井 component.
 *
 * y=6 に 40x40 の plane を伏せて配置.
 * ほぼ真っ暗だが中央付近だけ skylight が薄く滲む.
 */
export function Ceiling() {
  const uniforms = useMemo(
    () => ({
      uConcreteRoot: { value: PALETTE.concreteRoot.clone() },
      uSkylight: { value: PALETTE.skylight.clone() },
    }),
    [],
  );

  return (
    <mesh position={[0, 6, 0]} rotation-x={Math.PI / 2} receiveShadow>
      <planeGeometry args={[40, 40, 1, 1]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
      />
    </mesh>
  );
}
