/**
 * simple-room の背景. 中立 charcoal の縦グラデ + vignette を shader quad で描画.
 *
 * NOTE: 現構成では未使用（背景は scene.tsx の DOM layer = CSS gradient が描く）。
 * 色は scene.tsx と同期させておく。腐敗防止のための保守対象。
 */

import { useMemo } from "react";

const vertexShader = `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.999, 1.0);
  }
`;

const fragmentShader = `
  precision highp float;
  varying vec2 vUv;
  void main() {
    // linear-gradient(180deg, #26282c 0%, #16181b 100%)
    vec3 top = vec3(0.149, 0.157, 0.173);
    vec3 bottom = vec3(0.086, 0.094, 0.106);
    vec3 color = mix(bottom, top, vUv.y);

    // vignette: radial-gradient(ellipse at 50% 60%, transparent 60%, rgba(0,0,0,0.35) 100%)
    vec2 vigCenter = vec2(0.5, 0.4);
    float vigDist = length((vUv - vigCenter) * vec2(1.0, 0.8));
    float vig = smoothstep(0.6, 1.0, vigDist) * 0.35;
    color *= (1.0 - vig);

    gl_FragColor = vec4(color, 1.0);
  }
`;

export function Backdrop() {
  const uniforms = useMemo(() => ({}), []);

  return (
    <mesh renderOrder={-1000} frustumCulled={false}>
      <planeGeometry args={[2, 2, 1, 1]} />
      <shaderMaterial
        uniforms={uniforms}
        vertexShader={vertexShader}
        fragmentShader={fragmentShader}
        depthWrite={false}
        depthTest={false}
      />
    </mesh>
  );
}
