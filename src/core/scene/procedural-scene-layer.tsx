import { type CSSProperties, useEffect, useRef } from "react";
import * as THREE from "three";
import type { ProceduralLayer } from "./types";

export interface ProceduralSceneLayerProps {
  readonly procedural: ProceduralLayer;
}

const hostStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  display: "block",
};

type DisposableObject = {
  dispose: () => void;
};

export function ProceduralSceneLayer({ procedural }: ProceduralSceneLayerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    if (procedural.kind !== "radiant-meadow") return;
    return mountRadiantMeadow(host);
  }, [procedural.kind]);

  return <div ref={hostRef} aria-hidden="true" style={hostStyle} />;
}

function mountRadiantMeadow(host: HTMLDivElement): () => void {
  const renderer = new THREE.WebGLRenderer({
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setClearColor(0x000000, 0);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.style.width = "100%";
  renderer.domElement.style.height = "100%";
  renderer.domElement.style.display = "block";
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 120);
  camera.position.set(0, 1.05, 5.2);
  camera.lookAt(0, 0.48, -5.6);

  const objects: DisposableObject[] = [];
  const clock = new THREE.Clock();

  const sky = createRadiantSky();
  scene.add(sky.mesh);
  objects.push(sky);

  const mountains = createMountains();
  scene.add(mountains);
  objects.push(mountains);

  const ground = createGround();
  scene.add(ground);
  objects.push(ground);

  const grass = createGrassField();
  scene.add(grass.mesh);
  objects.push(grass);

  const seedHeads = createSeedHeads();
  scene.add(seedHeads.mesh);
  objects.push(seedHeads);

  const motes = createLightMotes();
  scene.add(motes.points);
  objects.push(motes);

  const resize = () => {
    const rect = host.getBoundingClientRect();
    const width = Math.max(1, Math.floor(rect.width));
    const height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };

  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(host);
  resize();

  let frame = 0;
  const tick = () => {
    const elapsed = clock.getElapsedTime();
    sky.uniforms.uTime.value = elapsed;
    grass.uniforms.uTime.value = elapsed;
    seedHeads.uniforms.uTime.value = elapsed;
    motes.uniforms.uTime.value = elapsed;
    frame = requestAnimationFrame(tick);
    renderer.render(scene, camera);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    for (const object of objects) object.dispose();
    if (renderer.domElement.parentNode === host) {
      host.removeChild(renderer.domElement);
    }
    renderer.dispose();
  };
}

function createRadiantSky(): DisposableObject & {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly uniforms: { readonly uTime: { value: number } };
} {
  const uniforms = { uTime: { value: 0 } };
  const geometry = new THREE.PlaneGeometry(2, 2, 1, 1);
  const material = new THREE.ShaderMaterial({
    uniforms,
    depthWrite: false,
    depthTest: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.98, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform float uTime;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(41.13, 289.71))) * 45758.5453);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      float fbm(vec2 p) {
        float sum = 0.0;
        float amp = 0.5;
        for (int i = 0; i < 5; i++) {
          sum += noise(p) * amp;
          p *= 2.03;
          amp *= 0.52;
        }
        return sum;
      }

      void main() {
        vec2 uv = vUv;
        vec3 dawn = vec3(0.98, 0.67, 0.42);
        vec3 horizon = vec3(0.76, 0.88, 0.75);
        vec3 blue = vec3(0.42, 0.68, 0.96);
        vec3 high = vec3(0.19, 0.35, 0.72);
        vec3 color = mix(horizon, blue, smoothstep(0.18, 0.82, uv.y));
        color = mix(color, high, smoothstep(0.72, 1.0, uv.y) * 0.45);
        color = mix(color, dawn, smoothstep(0.58, 0.0, uv.y) * 0.2);

        vec2 sunPos = vec2(0.66, 0.58);
        float sun = smoothstep(0.18, 0.0, distance(uv, sunPos));
        float sunCore = smoothstep(0.055, 0.0, distance(uv, sunPos));
        color += vec3(1.0, 0.78, 0.38) * sun * 0.48;
        color += vec3(1.0, 0.95, 0.72) * sunCore * 0.58;

        float cloudA = fbm(vec2(uv.x * 2.2 + uTime * 0.012, uv.y * 4.6 - 0.2));
        float cloudB = fbm(vec2(uv.x * 5.2 - uTime * 0.018, uv.y * 8.0 + 2.1));
        float cloud = smoothstep(0.56, 0.86, cloudA + cloudB * 0.26);
        cloud *= smoothstep(0.18, 0.48, uv.y) * smoothstep(0.98, 0.58, uv.y);
        color = mix(color, vec3(1.0, 0.9, 0.72), cloud * 0.3);

        float horizonMist = smoothstep(0.02, 0.42, uv.y) * smoothstep(0.76, 0.22, uv.y);
        float heightVeil = smoothstep(0.68, 0.0, uv.y);
        vec3 lowAir = vec3(0.93, 0.88, 0.72);
        vec3 highAir = vec3(0.72, 0.84, 0.98);
        vec3 airColor = mix(lowAir, highAir, smoothstep(0.18, 0.88, uv.y));
        color = mix(color, airColor, horizonMist * 0.34 + heightVeil * 0.18);

        float vignette = smoothstep(0.92, 0.35, distance(uv, vec2(0.5, 0.54)));
        color *= mix(0.76, 1.0, vignette);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -1000;
  return {
    mesh,
    uniforms,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createMountains(): THREE.Group & DisposableObject {
  const group = new THREE.Group() as THREE.Group & DisposableObject;
  const layers = [
    { color: 0x71917a, y: 0.18, z: -18, scaleY: 1.1, opacity: 0.58 },
    { color: 0x4f755c, y: 0.06, z: -14, scaleY: 1.36, opacity: 0.5 },
    { color: 0x375d47, y: -0.03, z: -10.5, scaleY: 1.02, opacity: 0.44 },
  ];
  const disposables: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> = [];

  for (const [layerIndex, layer] of layers.entries()) {
    const width = 34;
    const segments = 18;
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i <= segments; i += 1) {
      const x = -width / 2 + (width * i) / segments;
      const ridge =
        Math.sin(i * 0.87 + layerIndex * 1.7) * 0.36 + Math.sin(i * 0.31 + layerIndex * 2.3) * 0.52;
      const top = layer.y + (0.76 + ridge) * layer.scaleY;
      positions.push(x, top, layer.z, x, -2.5, layer.z);
    }
    for (let i = 0; i < segments; i += 1) {
      const row = i * 2;
      indices.push(row, row + 1, row + 2, row + 1, row + 3, row + 2);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    const material = new THREE.MeshBasicMaterial({
      color: layer.color,
      transparent: true,
      opacity: layer.opacity,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = -40 + layerIndex;
    group.add(mesh);
    disposables.push({ geometry, material });
  }

  group.dispose = () => {
    for (const entry of disposables) {
      entry.geometry.dispose();
      entry.material.dispose();
    }
  };
  return group;
}

function createGround(): THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial> & DisposableObject {
  const geometry = new THREE.PlaneGeometry(80, 60, 1, 1);
  const material = new THREE.ShaderMaterial({
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() {
        vec3 nearColor = vec3(0.16, 0.42, 0.18);
        vec3 farColor = vec3(0.68, 0.76, 0.38);
        vec3 color = mix(nearColor, farColor, smoothstep(0.0, 1.0, vUv.y));
        color = mix(color, vec3(0.92, 0.82, 0.54), smoothstep(0.74, 1.0, vUv.y) * 0.22);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geometry, material) as THREE.Mesh<
    THREE.PlaneGeometry,
    THREE.ShaderMaterial
  > &
    DisposableObject;
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.set(0, -0.14, -10.5);
  mesh.renderOrder = -20;
  mesh.dispose = () => {
    geometry.dispose();
    material.dispose();
  };
  return mesh;
}

function createGrassField(): DisposableObject & {
  readonly mesh: THREE.InstancedMesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms: { readonly uTime: { value: number } };
} {
  const random = mulberry32(0x5eedcafe);
  const count = 10600;
  const geometry = createGrassBladeGeometry();
  geometry.setAttribute(
    "bladePhase",
    new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  );
  geometry.setAttribute(
    "bladeTint",
    new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  );
  geometry.setAttribute(
    "bladeStiffness",
    new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  );
  geometry.setAttribute(
    "bladeLean",
    new THREE.InstancedBufferAttribute(new Float32Array(count), 1),
  );

  const uniforms = {
    uTime: { value: 0 },
    uWindStrength: { value: 0.28 },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.DoubleSide,
    vertexShader: `
      precision highp float;
      attribute float bladePhase;
      attribute float bladeTint;
      attribute float bladeStiffness;
      attribute float bladeLean;
      varying float vY;
      varying float vTint;
      varying float vDepth;
      uniform float uTime;
      uniform float uWindStrength;

      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
      }

      void main() {
        float h = clamp(position.y, 0.0, 1.0);
        vec4 worldPosition = instanceMatrix * vec4(position, 1.0);
        vec3 anchor = instanceMatrix[3].xyz;
        vec2 windDir = normalize(vec2(1.0, 0.28));
        vec2 crossWind = vec2(-windDir.y, windDir.x);

        float slowNoise = noise(anchor.xz * 0.38 + vec2(uTime * 0.075, -uTime * 0.052)) * 2.0 - 1.0;
        float fineNoise = noise(anchor.xz * 1.44 + vec2(-uTime * 0.16, uTime * 0.13)) * 2.0 - 1.0;
        float fieldWave =
          sin(anchor.x * 0.45 + anchor.z * 0.31 + uTime * 0.72) * 0.58 +
          sin(anchor.x * -0.19 + anchor.z * 0.64 + uTime * 1.02 + bladePhase * 0.12) * 0.34;
        fieldWave += slowNoise * 0.34 + fineNoise * 0.08;

        float bendMask = smoothstep(0.06, 1.0, h);
        float baseLean = bladeLean * bendMask * 0.08;
        float tipFlutter = sin(uTime * 2.18 + bladePhase + h * 2.0 + fineNoise) * 0.028;
        float bend = (fieldWave * uWindStrength * bladeStiffness + tipFlutter) * bendMask * bendMask;
        worldPosition.xz += windDir * (bend + baseLean) + crossWind * fineNoise * 0.016 * bendMask;

        vec4 mvPosition = modelViewMatrix * worldPosition;
        gl_Position = projectionMatrix * mvPosition;
        vY = h;
        vTint = bladeTint;
        vDepth = -mvPosition.z;
      }
    `,
    fragmentShader: `
      precision highp float;
      varying float vY;
      varying float vTint;
      varying float vDepth;
      void main() {
        vec3 root = mix(vec3(0.10, 0.30, 0.13), vec3(0.18, 0.42, 0.18), vTint);
        vec3 tip = mix(vec3(0.52, 0.72, 0.26), vec3(0.86, 0.90, 0.44), vTint);
        vec3 warm = vec3(1.0, 0.78, 0.38);
        vec3 color = mix(root, tip, smoothstep(0.0, 1.0, vY));
        color = mix(color, warm, smoothstep(0.55, 1.0, vY) * 0.08);
        float haze = smoothstep(5.0, 22.0, vDepth);
        color = mix(color, vec3(0.78, 0.86, 0.54), haze * 0.62);
        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });

  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const matrix = new THREE.Matrix4();
  const dummy = new THREE.Object3D();
  const phase = geometry.getAttribute("bladePhase") as THREE.InstancedBufferAttribute;
  const tint = geometry.getAttribute("bladeTint") as THREE.InstancedBufferAttribute;
  const stiffness = geometry.getAttribute("bladeStiffness") as THREE.InstancedBufferAttribute;
  const lean = geometry.getAttribute("bladeLean") as THREE.InstancedBufferAttribute;

  for (let i = 0; i < count; i += 1) {
    const nearEdge = i < count * 0.28;
    const near = i < count * 0.62;
    const depth = random();
    const z = nearEdge
      ? 4.25 - random() * 2.45
      : near
        ? 1.85 - random() * 4.7
        : -0.65 - depth * depth * 24.0;
    const spread = nearEdge
      ? 10.0 + random() * 5.8
      : near
        ? 7.8 + random() * 4.4
        : 3.8 + depth * 19.0;
    const x = (random() - 0.5) * spread;
    const height = nearEdge
      ? 1.0 + random() * 1.42
      : near
        ? 0.66 + random() * 1.1
        : 0.34 + random() * 0.98 * (1.0 - depth * 0.32);
    const width = nearEdge
      ? 0.032 + random() * 0.052
      : near
        ? 0.023 + random() * 0.034
        : 0.016 + random() * 0.024;
    const rootY = nearEdge ? -0.32 - random() * 0.08 : -0.15;

    dummy.position.set(x, rootY, z);
    dummy.rotation.set(0, random() * Math.PI, 0);
    dummy.scale.set(width, height, 1);
    dummy.updateMatrix();
    matrix.copy(dummy.matrix);
    mesh.setMatrixAt(i, matrix);
    phase.setX(i, random() * Math.PI * 2);
    tint.setX(i, random());
    stiffness.setX(i, 0.55 + random() * 0.64);
    lean.setX(i, random() * 2.0 - 1.0);
  }
  phase.needsUpdate = true;
  tint.needsUpdate = true;
  stiffness.needsUpdate = true;
  lean.needsUpdate = true;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;

  return {
    mesh,
    uniforms,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createGrassBladeGeometry(): THREE.BufferGeometry {
  const segments = 7;
  const positions: number[] = [];
  const indices: number[] = [];

  for (let i = 0; i <= segments; i += 1) {
    const h = i / segments;
    const width = (1 - h) * (1 - h * 0.58);
    const curve = Math.sin(h * Math.PI) * 0.1;
    positions.push(-0.5 * width + curve, h, 0, 0.5 * width + curve, h, 0);
  }

  for (let i = 0; i < segments; i += 1) {
    const row = i * 2;
    indices.push(row, row + 1, row + 2, row + 1, row + 3, row + 2);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeBoundingSphere();
  return geometry;
}

function createSeedHeads(): DisposableObject & {
  readonly mesh: THREE.InstancedMesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly uniforms: { readonly uTime: { value: number } };
} {
  const random = mulberry32(0xa11ce);
  const count = 380;
  const geometry = new THREE.SphereGeometry(0.022, 8, 5);
  const uniforms = { uTime: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    vertexShader: `
      precision highp float;
      uniform float uTime;
      void main() {
        vec4 worldPosition = instanceMatrix * vec4(position, 1.0);
        vec3 anchor = instanceMatrix[3].xyz;
        float wave = sin(anchor.x * 0.42 + anchor.z * 0.5 + uTime * 0.74) * 0.045;
        worldPosition.x += wave;
        gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      void main() {
        gl_FragColor = vec4(1.0, 0.88, 0.52, 0.62);
      }
    `,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const dummy = new THREE.Object3D();
  const matrix = new THREE.Matrix4();

  for (let i = 0; i < count; i += 1) {
    const depth = random();
    const z = 0.8 - depth * depth * 16.0;
    const spread = 4.2 + depth * 11.0;
    dummy.position.set((random() - 0.5) * spread, 0.28 + random() * 0.86, z);
    dummy.scale.setScalar(0.65 + random() * 1.4);
    dummy.updateMatrix();
    matrix.copy(dummy.matrix);
    mesh.setMatrixAt(i, matrix);
  }
  mesh.instanceMatrix.needsUpdate = true;
  mesh.frustumCulled = false;

  return {
    mesh,
    uniforms,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

function createLightMotes(): DisposableObject & {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms: { readonly uTime: { value: number } };
} {
  const random = mulberry32(0x51a7e);
  const count = 520;
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const depth = random();
    positions[i * 3] = (random() - 0.5) * (5 + depth * 13);
    positions[i * 3 + 1] = 0.35 + random() * 3.5;
    positions[i * 3 + 2] = -1.4 - depth * 19;
    phases[i] = random() * Math.PI * 2;
    sizes[i] = 10 + random() * 26;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("moteSize", new THREE.BufferAttribute(sizes, 1));
  const uniforms = { uTime: { value: 0 } };
  const material = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      precision highp float;
      attribute float phase;
      attribute float moteSize;
      varying float vAlpha;
      uniform float uTime;
      void main() {
        vec3 p = position;
        p.x += sin(uTime * 0.18 + phase) * 0.12;
        p.y += sin(uTime * 0.26 + phase * 1.7) * 0.08;
        vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        float depthFade = smoothstep(24.0, 2.0, -mvPosition.z);
        vAlpha = (0.26 + sin(uTime * 0.72 + phase) * 0.12) * depthFade;
        gl_PointSize = moteSize * (1.0 / max(1.0, -mvPosition.z));
      }
    `,
    fragmentShader: `
      precision highp float;
      varying float vAlpha;
      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float glow = smoothstep(0.5, 0.0, length(uv));
        vec3 color = vec3(1.0, 0.83, 0.45);
        gl_FragColor = vec4(color, glow * vAlpha);
      }
    `,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;

  return {
    points,
    uniforms,
    dispose: () => {
      geometry.dispose();
      material.dispose();
    },
  };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
