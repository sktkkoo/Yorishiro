import { type CSSProperties, useEffect, useRef } from "react";
import * as THREE from "three";
import type { ProceduralLayer } from "./types";

/**
 * radiant-meadow procedural renderer の shared parameters.
 *
 * Tarkovsky『鏡』の麦畑シーン (overcast morning, 低彩度, 風の波) を reference に
 * 全 component が共有する palette / fog / wind 値。
 *
 * Internal design-record: 2026-04-29-radiant-meadow-mirror-redesign.md
 *
 * 各 create* 関数はこの const を参照し、shader uniform に渡す。
 * inline literal で hand-tune しないこと（component 間で色味が崩れる）。
 */
export const PALETTE = {
  /** 灰青（天頂） */
  skyZenith: new THREE.Color(0.72, 0.78, 0.82),
  /** 淡い cream-grey（地平線） */
  skyHorizon: new THREE.Color(0.86, 0.86, 0.8),
  /** 灰緑（forest 近） */
  forestNear: new THREE.Color(0.42, 0.5, 0.42),
  /** 霧に溶ける遠 */
  forestFar: new THREE.Color(0.68, 0.72, 0.68),
  /** 暗い dusty green */
  grassRoot: new THREE.Color(0.22, 0.3, 0.18),
  /** mid green-khaki */
  grassMid: new THREE.Color(0.46, 0.52, 0.32),
  /** dry cream-khaki */
  grassTip: new THREE.Color(0.74, 0.74, 0.54),
  /** off-white */
  wildflower: new THREE.Color(0.95, 0.94, 0.86),
  /** dust cream */
  particle: new THREE.Color(0.92, 0.9, 0.82),
  /** 霧の色 */
  hazeColor: new THREE.Color(0.84, 0.86, 0.82),
} as const;

/**
 * Atmospheric haze (depth-based, applied in shaders that have view-space distance).
 * Camera linear depth ではなく view-space distance（既存 `vDepth` と同じ semantics）。
 */
export const FOG = {
  /** 霧が始まる距離 */
  near: 4.0,
  /** 完全に空気に溶ける距離 */
  far: 28.0,
} as const;

/**
 * 風の parameters。
 *
 * - direction: 既存の風向き
 * - long-wavelength traveling wave: Mirror の signature。風向きに沿って画面を横切る波
 * - rustle: 既存の高周波 noise の強さ（保持）
 */
export const WIND = {
  direction: new THREE.Vector2(1.0, 0.28).normalize(),
  /** 波長 (world units) */
  waveLength: 6.0,
  /** 波の進行速度 (world units / sec) */
  waveSpeed: 1.6,
  /** bendMask 最大時の peak bend (radians 相当) */
  waveAmplitude: 0.42,
  /** 既存の高周波 rustle の強さ */
  rustleStrength: 0.28,
} as const;

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

  // ---- Post-processing pipeline -------------------------------------------
  // Scene を一旦 renderTarget に描いてから、fullscreen quad shader で
  // tonemap / desaturation / grain / vignette を掛けて canvas に出す。
  // Mirror (1975) の 35mm film 的な質感を作る subtle pass。
  // Spec: internal design-record 2026-04-29-radiant-meadow-mirror-redesign.md Component 5

  // HalfFloat が使えれば tonemap headroom が広がるが、低スペック GPU では
  // 未対応のことがあるので render context capability を見て fallback する
  const supportsHalfFloat =
    renderer.capabilities.isWebGL2 || renderer.extensions.has("OES_texture_half_float");
  const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
    type: supportsHalfFloat ? THREE.HalfFloatType : THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    colorSpace: THREE.SRGBColorSpace,
    depthBuffer: true,
    stencilBuffer: false,
    minFilter: THREE.LinearFilter,
    magFilter: THREE.LinearFilter,
  });

  const postScene = new THREE.Scene();
  // NDC をそのまま覆う ortho。vertex shader 側で gl_Position を直接書く
  const postCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const postUniforms: {
    readonly tDiffuse: { value: THREE.Texture | null };
    readonly uTime: { value: number };
    readonly uResolution: { value: THREE.Vector2 };
  } = {
    tDiffuse: { value: renderTarget.texture },
    uTime: { value: 0 },
    uResolution: { value: new THREE.Vector2(1, 1) },
  };

  const postGeometry = new THREE.PlaneGeometry(2, 2);
  const postMaterial = new THREE.ShaderMaterial({
    uniforms: postUniforms,
    depthTest: false,
    depthWrite: false,
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D tDiffuse;
      uniform float uTime;
      uniform vec2 uResolution;

      // Krzysztof Narkowicz の simplified ACES Filmic
      vec3 acesFilmic(vec3 x) {
        return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
      }

      // 軽量 hash。grain 専用なので品質より速さ
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
      }

      void main() {
        vec3 color = texture2D(tDiffuse, vUv).rgb;

        // 1) Tonemap: linear-ish → displayable curve、弱め
        color = acesFilmic(color);

        // 2) Mild desaturation (~12%): Mirror 的な低彩度に寄せる
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        color = mix(color, vec3(luma), 0.12);

        // 3) Subtle film grain: 時間で動く低 amplitude noise
        float grain = (hash(gl_FragCoord.xy + uTime * 60.0) - 0.5) * 0.04;
        color += grain;

        // 4) Vignette: 緩やかな edge falloff
        float vig = length(vUv * 2.0 - 1.0);
        color *= mix(1.0, 0.78, smoothstep(0.4, 1.05, vig));

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });

  const postQuad = new THREE.Mesh(postGeometry, postMaterial);
  // NDC 直書き quad は frustum culling を切らないと cull される
  postQuad.frustumCulled = false;
  postScene.add(postQuad);
  // -------------------------------------------------------------------------

  const sky = createRadiantSky();
  scene.add(sky.mesh);
  objects.push(sky);

  const distantForest = createDistantForest();
  scene.add(distantForest);
  objects.push(distantForest);

  const ground = createGround();
  scene.add(ground);
  objects.push(ground);

  const grass = createGrassField();
  scene.add(grass.mesh);
  objects.push(grass);

  const seedHeads = createSeedHeads();
  scene.add(seedHeads.mesh);
  objects.push(seedHeads);

  const wildflowers = createWildflowers();
  scene.add(wildflowers.mesh);
  objects.push(wildflowers);

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
    // RT も同じ pixel 解像度に合わせる（pixelRatio は renderer 側で
    // drawingBufferSize に反映済み）。setSize は内部で再 alloc するので
    // dispose+recreate しなくて良い
    const pr = renderer.getPixelRatio();
    const rtWidth = Math.max(1, Math.floor(width * pr));
    const rtHeight = Math.max(1, Math.floor(height * pr));
    renderTarget.setSize(rtWidth, rtHeight);
    postUniforms.uResolution.value.set(rtWidth, rtHeight);
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
    wildflowers.uniforms.uTime.value = elapsed;
    motes.uniforms.uTime.value = elapsed;
    postUniforms.uTime.value = elapsed;
    frame = requestAnimationFrame(tick);

    // 1) scene → renderTarget。既存の renderOrder / depthWrite はそのまま効く
    //    （RT も color + depth を持つ通常の framebuffer 相当）
    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);

    // 2) RT を fullscreen quad で sample しながら post pass を canvas に
    renderer.setRenderTarget(null);
    renderer.render(postScene, postCamera);
  };
  frame = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(frame);
    resizeObserver.disconnect();
    for (const object of objects) object.dispose();
    // Post pass の resources を解放
    postScene.remove(postQuad);
    postGeometry.dispose();
    postMaterial.dispose();
    renderTarget.dispose();
    if (renderer.domElement.parentNode === host) {
      host.removeChild(renderer.domElement);
    }
    renderer.dispose();
  };
}

function createRadiantSky(): DisposableObject & {
  readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  readonly uniforms: {
    readonly uTime: { value: number };
    readonly uSkyZenith: { value: THREE.Color };
    readonly uSkyHorizon: { value: THREE.Color };
    readonly uHazeColor: { value: THREE.Color };
  };
} {
  // Tarkovsky『鏡』の曇天の朝を意識した、静かで目立たない sky。
  // 太陽の spot は描かない（拡散光のみ）。zenith ↔ horizon の 2-color gradient に
  // 大きく soft な雲塊と地平の霧を重ねる。vignette は post-processing 側に移管。
  const uniforms = {
    uTime: { value: 0 },
    uSkyZenith: { value: PALETTE.skyZenith.clone() },
    uSkyHorizon: { value: PALETTE.skyHorizon.clone() },
    uHazeColor: { value: PALETTE.hazeColor.clone() },
  };
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
      uniform vec3 uSkyZenith;
      uniform vec3 uSkyHorizon;
      uniform vec3 uHazeColor;

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

      void main() {
        vec2 uv = vUv;

        // 2-color gradient: 地平 → 天頂。直線的すぎないよう smoothstep で軽くカーブ
        vec3 color = mix(uSkyHorizon, uSkyZenith, smoothstep(0.0, 0.95, uv.y));

        // 大きく soft な雲塊。FBM の周波数を旧版の約半分に落として、
        // 小さい雲ではなくゆっくり流れる雲塊にする
        float cloudA = noise(vec2(uv.x * 1.1 + uTime * 0.006, uv.y * 2.3 - 0.1));
        float cloudB = noise(vec2(uv.x * 2.6 - uTime * 0.009, uv.y * 4.0 + 1.0));
        float cloud = smoothstep(0.48, 0.92, cloudA + cloudB * 0.32);
        cloud *= smoothstep(0.18, 0.50, uv.y) * smoothstep(1.02, 0.55, uv.y);
        // 雲色は warm tint を捨て、white に haze を 30% 混ぜた中性 cream
        vec3 cloudColor = mix(vec3(1.0), uHazeColor, 0.3);
        color = mix(color, cloudColor, cloud * 0.55);

        // 地平 mist：地平線の geometry が空気に溶けるよう強める
        float horizonMist = smoothstep(0.0, 0.32, uv.y) * smoothstep(0.55, 0.10, uv.y);
        color = mix(color, uHazeColor, horizonMist * 0.55);

        // vignette は post pass 側で globally かけるため、ここではかけない
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

function createDistantForest(): THREE.Group & DisposableObject {
  // 山ではなく、霧の向こうに溶ける森の silhouette。
  // 三角の山稜を撤廃し、木の凹凸を持つ skyline を 2 layer (近 + 遠) で重ねる。
  const group = new THREE.Group() as THREE.Group & DisposableObject;

  // 既存の ground (createGround) は y = -0.14 に置かれているため、
  // 森の baseline はそこに合わせて地平線から立ち上がるように見せる
  const baselineY = -0.14;

  // far layer は霧色に寄せて空気に溶ける
  const farColor = PALETTE.forestFar.clone().lerp(PALETTE.hazeColor, 0.5);

  const layers = [
    {
      // 近景の森：灰緑、輪郭がやや明瞭
      color: PALETTE.forestNear,
      z: -10,
      width: 38,
      segments: 40,
      heightBase: 0.62,
      heightVariation: 0.34,
      seed: 0xf07e57a,
      renderOrder: -38,
      opacity: 0.78,
    },
    {
      // 遠景の森：霧色に寄せて、輪郭は柔らかく
      color: farColor,
      z: -16,
      width: 44,
      segments: 46,
      heightBase: 0.78,
      heightVariation: 0.42,
      seed: 0xf07e57b,
      renderOrder: -42,
      opacity: 0.62,
    },
  ];

  const disposables: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }> = [];

  for (const layer of layers) {
    const random = mulberry32(layer.seed);

    // 低周波 noise pass の制御点。skyline 全幅を粗く覆う bumpy curve を作る
    const noiseControlCount = 8;
    const noiseControls: number[] = [];
    for (let i = 0; i < noiseControlCount; i += 1) {
      noiseControls.push(random() * 2 - 1);
    }

    // 個々の木のピーク用 random offset を per-segment に持つ
    const treePeaks: number[] = [];
    for (let i = 0; i <= layer.segments; i += 1) {
      treePeaks.push(random());
    }

    // 2-3 本の sin 波の位相と振幅。layer ごとに seed で揺らす
    const sinA = { freq: 1.7, amp: 0.18, phase: random() * Math.PI * 2 };
    const sinB = { freq: 3.1, amp: 0.11, phase: random() * Math.PI * 2 };
    const sinC = { freq: 5.3, amp: 0.07, phase: random() * Math.PI * 2 };

    const positions: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i <= layer.segments; i += 1) {
      const t = i / layer.segments;
      const x = -layer.width / 2 + layer.width * t;

      // 低周波 noise: control 配列を線形補間して滑らかな大きなうねりを作る
      const cf = t * (noiseControlCount - 1);
      const cIdx = Math.floor(cf);
      const cFrac = cf - cIdx;
      const cA = noiseControls[cIdx] ?? 0;
      const cB = noiseControls[Math.min(cIdx + 1, noiseControlCount - 1)] ?? 0;
      const smooth = cFrac * cFrac * (3 - 2 * cFrac);
      const lowFreq = cA * (1 - smooth) + cB * smooth;

      // sin の重ね合わせで木の塊感を出す
      const sinSum =
        Math.sin(t * sinA.freq * Math.PI * 2 + sinA.phase) * sinA.amp +
        Math.sin(t * sinB.freq * Math.PI * 2 + sinB.phase) * sinB.amp +
        Math.sin(t * sinC.freq * Math.PI * 2 + sinC.phase) * sinC.amp;

      // 個々の木のピーク（per-x random）。中心が低めになるよう負方向にバイアス
      const peak = (treePeaks[i] ?? 0.5) - 0.5;

      // 合成: 低周波うねり + sin 重ね + 個別ピーク
      const profile = lowFreq * 0.55 + sinSum + peak * 0.32;

      const top = baselineY + layer.heightBase + profile * layer.heightVariation;

      // 上端 → 下端（地平線下へ十分伸ばして seam を隠す）
      positions.push(x, top, layer.z, x, baselineY - 2.2, layer.z);
    }

    for (let i = 0; i < layer.segments; i += 1) {
      const row = i * 2;
      indices.push(row, row + 1, row + 2, row + 1, row + 3, row + 2);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);

    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: layer.opacity,
      depthWrite: false,
    });
    // PALETTE の色は raw literal ではなく copy で渡す（spec 規約）
    material.color.copy(layer.color);

    const mesh = new THREE.Mesh(geometry, material);
    mesh.renderOrder = layer.renderOrder;
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

  // shared params (PALETTE / FOG / WIND) を uniform に流し込む。
  // GLSL 内に inline literal を書かないことで component 間の色味ズレを防ぐ
  const uniforms = {
    uTime: { value: 0 },
    // 高周波 rustle の強さ。長波長 wave を読ませるため従来 0.28 → 0.18 に絞る
    uWindStrength: { value: 0.18 },
    // 風向き（XZ 平面）。WIND.direction を共有
    uWindDir: { value: new THREE.Vector2(WIND.direction.x, WIND.direction.y) },
    // Mirror signature: 長波長 traveling wave の空間波長 (world units)
    uWaveLength: { value: WIND.waveLength },
    // wave の進行速度 (world units / sec)
    uWaveSpeed: { value: WIND.waveSpeed },
    // bendMask 最大時の peak bend (radians 相当)
    uWaveAmplitude: { value: WIND.waveAmplitude },
    // root / mid / tip color。fragment 側で 2 段 mix して gradient を組む
    uGrassRoot: {
      value: new THREE.Vector3(PALETTE.grassRoot.r, PALETTE.grassRoot.g, PALETTE.grassRoot.b),
    },
    uGrassMid: {
      value: new THREE.Vector3(PALETTE.grassMid.r, PALETTE.grassMid.g, PALETTE.grassMid.b),
    },
    uGrassTip: {
      value: new THREE.Vector3(PALETTE.grassTip.r, PALETTE.grassTip.g, PALETTE.grassTip.b),
    },
    // 霧の color と range (FOG.near ↔ FOG.far)
    uHazeColor: {
      value: new THREE.Vector3(PALETTE.hazeColor.r, PALETTE.hazeColor.g, PALETTE.hazeColor.b),
    },
    uFogNear: { value: FOG.near },
    uFogFar: { value: FOG.far },
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
      uniform vec2 uWindDir;
      uniform float uWaveLength;
      uniform float uWaveSpeed;
      uniform float uWaveAmplitude;

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
        vec2 windDir = normalize(uWindDir);
        vec2 crossWind = vec2(-windDir.y, windDir.x);

        // 既存の rustle 系: 大局的 noise + 小スケール noise + 重ね合わせ sin
        float slowNoise = noise(anchor.xz * 0.38 + vec2(uTime * 0.075, -uTime * 0.052)) * 2.0 - 1.0;
        float fineNoise = noise(anchor.xz * 1.44 + vec2(-uTime * 0.16, uTime * 0.13)) * 2.0 - 1.0;
        float fieldWave =
          sin(anchor.x * 0.45 + anchor.z * 0.31 + uTime * 0.72) * 0.58 +
          sin(anchor.x * -0.19 + anchor.z * 0.64 + uTime * 1.02 + bladePhase * 0.12) * 0.34;
        fieldWave += slowNoise * 0.34 + fineNoise * 0.08;

        float bendMask = smoothstep(0.06, 1.0, h);
        float baseLean = bladeLean * bendMask * 0.08;
        float tipFlutter = sin(uTime * 2.18 + bladePhase + h * 2.0 + fineNoise) * 0.028;

        // Mirror signature: 風向きに沿って画面を横切る long-wavelength traveling wave。
        // anchor を風向き軸に投影 → 波長で正規化 → 時間で進行させる。
        // bendMask の 2 乗で根本を固定し、穂先側ほど大きく傾く
        float waveCoord = dot(anchor.xz, windDir) / uWaveLength * 6.2832;
        float traveling = sin(waveCoord - uTime * uWaveSpeed * 6.2832 / uWaveLength);
        float travelingBend = traveling * uWaveAmplitude * bendMask * bendMask;

        float bend = (fieldWave * uWindStrength * bladeStiffness + tipFlutter) * bendMask * bendMask;
        worldPosition.xz += windDir * (bend + baseLean + travelingBend) + crossWind * fineNoise * 0.016 * bendMask;

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
      uniform vec3 uGrassRoot;
      uniform vec3 uGrassMid;
      uniform vec3 uGrassTip;
      uniform vec3 uHazeColor;
      uniform float uFogNear;
      uniform float uFogFar;

      void main() {
        // root → mid → tip を 2 段 smoothstep で繋ぐ。warm overlay は撤廃
        vec3 color = mix(uGrassRoot, uGrassMid, smoothstep(0.0, 0.5, vY));
        color = mix(color, uGrassTip, smoothstep(0.5, 1.0, vY));

        // bladeTint で個体差を僅かに散らす（mid 寄り ↔ tip 寄りの揺らぎ）
        float tintShift = (vTint - 0.5) * 0.12;
        color += vec3(tintShift * 0.6, tintShift * 0.5, tintShift * 0.3);

        // Depth haze: 遠景は霧色に溶ける。far 側はほぼ完全に dissolve
        float haze = smoothstep(uFogNear, uFogFar, vDepth);
        color = mix(color, uHazeColor, haze * 0.92);

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
      ? 3.15 - random() * 2.05
      : near
        ? 1.35 - random() * 4.15
        : -0.65 - depth * depth * 24.0;
    const spread = nearEdge
      ? 10.0 + random() * 5.8
      : near
        ? 7.8 + random() * 4.4
        : 3.8 + depth * 19.0;
    const x = (random() - 0.5) * spread;
    const height = nearEdge
      ? 0.42 + random() * 0.52
      : near
        ? 0.36 + random() * 0.58
        : 0.22 + random() * 0.62 * (1.0 - depth * 0.32);
    const width = nearEdge
      ? 0.018 + random() * 0.034
      : near
        ? 0.016 + random() * 0.028
        : 0.016 + random() * 0.024;
    const rootY = nearEdge ? -0.3 - random() * 0.06 : -0.15;

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
  readonly uniforms: {
    readonly uTime: { value: number };
    readonly uColor: { value: THREE.Color };
  };
} {
  const random = mulberry32(0xa11ce);
  const count = 260;
  const geometry = new THREE.SphereGeometry(0.022, 8, 5);
  // 色を uniform 経由で渡し、PALETTE.particle と単一 source で揃える
  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: PALETTE.particle.clone() },
  };
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
      precision highp float;
      uniform vec3 uColor;
      void main() {
        // alpha は元の 0.62 から少し落として 0.55、cream dust の控えめさへ
        gl_FragColor = vec4(uColor, 0.55);
      }
    `,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const dummy = new THREE.Object3D();
  const matrix = new THREE.Matrix4();

  for (let i = 0; i < count; i += 1) {
    const depth = random();
    const z = 0.25 - depth * depth * 15.0;
    const spread = 4.2 + depth * 11.0;
    dummy.position.set((random() - 0.5) * spread, 0.1 + random() * 0.46, z);
    dummy.scale.setScalar(0.42 + random() * 0.78);
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

function createWildflowers(): DisposableObject & {
  readonly mesh: THREE.InstancedMesh<THREE.IcosahedronGeometry, THREE.ShaderMaterial>;
  readonly uniforms: {
    readonly uTime: { value: number };
    readonly uColor: { value: THREE.Color };
  };
} {
  // 草の中に散る白い小花（カモミール / 蕎麦花の点）
  const random = mulberry32(0xf10ce5);
  const count = 180;
  // 小さい low-poly 球。view angle に依存せず、点として認識される程度の粒
  const geometry = new THREE.IcosahedronGeometry(0.018, 0);
  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: PALETTE.wildflower.clone() },
  };
  const material = new THREE.ShaderMaterial({
    uniforms,
    // 不透明にして草を綺麗に occlude させる
    transparent: false,
    depthWrite: true,
    vertexShader: `
      precision highp float;
      uniform float uTime;
      void main() {
        vec4 worldPosition = instanceMatrix * vec4(position, 1.0);
        vec3 anchor = instanceMatrix[3].xyz;
        // seedHeads と同じ pattern。小花なので amplitude は控えめ (0.045 → 0.025)
        float wave = sin(anchor.x * 0.42 + anchor.z * 0.5 + uTime * 0.74) * 0.025;
        worldPosition.x += wave;
        gl_Position = projectionMatrix * modelViewMatrix * worldPosition;
      }
    `,
    fragmentShader: `
      precision highp float;
      uniform vec3 uColor;
      void main() {
        gl_FragColor = vec4(uColor, 1.0);
      }
    `,
  });
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  const dummy = new THREE.Object3D();
  const matrix = new THREE.Matrix4();

  for (let i = 0; i < count; i += 1) {
    // x は広めに spread 12、y は草の中ほど、z は近景中心 [3.0, -2.0]
    const x = (random() - 0.5) * 12;
    const y = 0.18 + random() * 0.32;
    const z = 0.5 - random() * random() * 5.5;
    dummy.position.set(x, y, z);
    dummy.rotation.set(0, random() * Math.PI * 2, 0);
    // size に少しだけ揺らぎを持たせて単調さを避ける
    dummy.scale.setScalar(0.7 + random() * 0.6);
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
  readonly uniforms: {
    readonly uTime: { value: number };
    readonly uColor: { value: THREE.Color };
  };
} {
  const random = mulberry32(0x51a7e);
  // 数を半分強に絞り、cream dust の控えめな漂いに寄せる
  const count = 280;
  const positions = new Float32Array(count * 3);
  const phases = new Float32Array(count);
  const sizes = new Float32Array(count);

  for (let i = 0; i < count; i += 1) {
    const depth = random();
    positions[i * 3] = (random() - 0.5) * (5 + depth * 13);
    positions[i * 3 + 1] = 0.35 + random() * 3.5;
    positions[i * 3 + 2] = -1.4 - depth * 19;
    phases[i] = random() * Math.PI * 2;
    // pointSize を従来の約半分に。glittering ではなく dust らしい大きさへ
    sizes[i] = 6 + random() * 14;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
  geometry.setAttribute("moteSize", new THREE.BufferAttribute(sizes, 1));
  // PALETTE.particle を uniform 経由で渡す（inline literal を避け palette と同期させる）
  const uniforms = {
    uTime: { value: 0 },
    uColor: { value: PALETTE.particle.clone() },
  };
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
        // alpha amplitude を半減させ、静けさを保つ
        vAlpha = (0.16 + sin(uTime * 0.72 + phase) * 0.08) * depthFade;
        gl_PointSize = moteSize * (1.0 / max(1.0, -mvPosition.z));
      }
    `,
    fragmentShader: `
      precision highp float;
      varying float vAlpha;
      uniform vec3 uColor;
      void main() {
        vec2 uv = gl_PointCoord - vec2(0.5);
        float glow = smoothstep(0.5, 0.0, length(uv));
        gl_FragColor = vec4(uColor, glow * vAlpha);
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
