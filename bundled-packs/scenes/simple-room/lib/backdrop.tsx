/**
 * simple-room の背景. 青灰色 gradient + 光の中心を shader quad で描画.
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
    // linear-gradient(180deg, #232838 0%, #161a24 100%)
    vec3 top = vec3(0.137, 0.157, 0.220);
    vec3 bottom = vec3(0.086, 0.102, 0.141);
    vec3 color = mix(bottom, top, vUv.y);

    // radial-gradient(ellipse at 50% 30%, rgba(120,150,200,0.18), transparent 70%)
    vec2 center = vec2(0.5, 0.7);
    float dist = length((vUv - center) * vec2(1.0, 0.7));
    float radial = smoothstep(0.7, 0.0, dist) * 0.18;
    color += vec3(0.471, 0.588, 0.784) * radial;

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
