/**
 * 廃工場の大気効果. 浮遊粒子 (DustMotes) と天光柱 (GodRays).
 *
 * leva で sizeMult / alpha / godRays alpha をリアルタイム調整可能.
 */

import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useMemo, useRef } from "react";
import * as THREE from "three";
import { PALETTE } from "./palette";

/* ---- 決定論的 LCG 乱数 ---- */

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
uniform float uSizeMult;
uniform float uAlphaBase;
uniform float uAlphaAmp;

attribute float aPhase;
attribute float aSize;

varying float vAlpha;

void main() {
  vec3 pos = position;
  float freq = 0.15;
  pos.x += sin(uTime * freq + aPhase) * 0.3;
  pos.y += sin(uTime * freq * 0.7 + aPhase * 1.3) * 0.15;
  pos.z += sin(uTime * freq * 0.5 + aPhase * 0.7) * 0.25;

  vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mvPos;
  gl_PointSize = aSize * (uSizeMult / max(1.0, -mvPos.z));

  vAlpha = uAlphaBase + uAlphaAmp * sin(uTime * 0.4 + aPhase * 2.0);
}
`;

const dustFragmentShader = /* glsl */ `
uniform vec3 uColor;

varying float vAlpha;

void main() {
  float dist = length(gl_PointCoord - vec2(0.5));
  float glow = 1.0 - smoothstep(0.0, 0.5, dist);

  gl_FragColor = vec4(uColor, glow * vAlpha);
}
`;

export function DustMotes() {
  const pointsRef = useRef<THREE.Points>(null);

  const controls = useControls("abandoned-factory", {
    dust: folder({
      sizeMult: { value: 3.0, min: 0, max: 30, step: 0.5, label: "size multiplier" },
      alphaBase: { value: 0.16, min: 0, max: 0.5, step: 0.01, label: "alpha base" },
      alphaAmp: { value: 0.08, min: 0, max: 0.3, step: 0.01, label: "alpha amplitude" },
    }),
  });

  const points = useMemo(() => {
    const rng = createLcg(0xa11ce);

    const positions = new Float32Array(MOTE_COUNT * 3);
    const phases = new Float32Array(MOTE_COUNT);
    const sizes = new Float32Array(MOTE_COUNT);

    for (let i = 0; i < MOTE_COUNT; i++) {
      positions[i * 3] = (rng() - 0.5) * 14;
      positions[i * 3 + 1] = rng() * 4 + 0.5;
      positions[i * 3 + 2] = (rng() - 0.5) * 14;
      phases[i] = rng() * Math.PI * 2;
      sizes[i] = 6 + rng() * 14;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("aPhase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("aSize", new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uColor: { value: PALETTE.hazeColor.clone() },
        uSizeMult: { value: 3.0 },
        uAlphaBase: { value: 0.16 },
        uAlphaAmp: { value: 0.08 },
      },
      vertexShader: dustVertexShader,
      fragmentShader: dustFragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    return new THREE.Points(geo, mat);
  }, []);

  useFrame((_state, delta) => {
    const mat = points.material as THREE.ShaderMaterial;
    mat.uniforms.uTime.value += delta;
    mat.uniforms.uSizeMult.value = controls.sizeMult;
    mat.uniforms.uAlphaBase.value = controls.alphaBase;
    mat.uniforms.uAlphaAmp.value = controls.alphaAmp;
  });

  return <primitive ref={pointsRef} object={points} />;
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
uniform float uAlphaMult;

varying float vY;

void main() {
  float topFade = smoothstep(3.0, -3.0, vY);
  float noise = sin(uTime * 0.3 + vY * 2.0);
  float alpha = topFade * uAlphaMult * (0.7 + noise * 0.3);

  gl_FragColor = vec4(uColor, alpha);
}
`;

export function GodRays() {
  const matRef = useRef<THREE.ShaderMaterial>(null);

  const controls = useControls("abandoned-factory", {
    godRays: folder({
      alphaMult: { value: 0.08, min: 0, max: 0.5, step: 0.01, label: "alpha multiplier" },
    }),
  });

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uColor: { value: PALETTE.skylight.clone() },
      uAlphaMult: { value: 0.08 },
    }),
    [],
  );

  useFrame((_state, delta) => {
    if (matRef.current) {
      matRef.current.uniforms.uTime.value += delta;
      matRef.current.uniforms.uAlphaMult.value = controls.alphaMult;
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
