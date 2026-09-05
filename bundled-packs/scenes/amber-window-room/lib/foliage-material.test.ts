import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { adaptCeramicMaterial, adaptFoliageMaterial } from "./foliage-material";

function shaderParameters(kind: "standard" | "physical") {
  const shader = THREE.ShaderLib[kind];
  // WebGL コンテキストを作らず、実際の Three.js シェーダーをフックへ渡す。
  return {
    uniforms: THREE.UniformsUtils.clone(shader.uniforms),
    vertexShader: shader.vertexShader,
    fragmentShader: shader.fragmentShader,
  } as THREE.WebGLProgramParametersWithUniforms;
}

const renderer = {} as THREE.WebGLRenderer;

function requireStandard(material: THREE.Material | null): THREE.MeshStandardMaterial {
  expect(material).toBeInstanceOf(THREE.MeshStandardMaterial);
  if (!(material instanceof THREE.MeshStandardMaterial)) throw new Error("Expected PBR material");
  return material;
}

describe("Twilight Café material ownership", () => {
  it.each([
    { name: "Leaf | green", adapt: adaptFoliageMaterial },
    { name: "Ceramic | ivory stoneware", adapt: adaptCeramicMaterial },
  ])("keeps cached textures alive when the $name adapter is disposed", ({ name, adapt }) => {
    const textures = Array.from({ length: 4 }, () => new THREE.Texture());
    const textureDisposals = textures.map((texture) => {
      const listener = vi.fn();
      texture.addEventListener("dispose", listener);
      return listener;
    });
    const source = new THREE.MeshStandardMaterial({
      name,
      map: textures[0],
      normalMap: textures[1],
      roughnessMap: textures[2],
      aoMap: textures[3],
      roughness: 0.92,
      normalScale: new THREE.Vector2(0.8, 0.6),
      side: THREE.DoubleSide,
    });
    const sourceDisposed = vi.fn();
    source.addEventListener("dispose", sourceDisposed);

    const adapted = requireStandard(adapt(source));
    expect(adapted).not.toBe(source);
    expect(adapted.map).toBe(source.map);
    expect(adapted.normalMap).toBe(source.normalMap);
    expect(adapted.roughnessMap).toBe(source.roughnessMap);
    expect(adapted.aoMap).toBe(source.aoMap);
    expect(adapted.normalScale).not.toBe(source.normalScale);
    expect(adapted.side).toBe(THREE.DoubleSide);
    expect(source.roughness).toBe(0.92);
    expect(source.normalScale.toArray()).toEqual([0.8, 0.6]);

    adapted.dispose();
    expect(sourceDisposed).not.toHaveBeenCalled();
    for (const disposed of textureDisposals) expect(disposed).not.toHaveBeenCalled();

    source.dispose();
    for (const texture of textures) texture.dispose();
  });
});

describe("Twilight Café foliage shader", () => {
  it.each([
    { kind: "standard" as const, name: "Leaf | green" },
    { kind: "physical" as const, name: "Petal | yellow" },
  ])("patches installed $kind lighting after directional shadow attenuation", ({ kind, name }) => {
    const source =
      kind === "physical"
        ? new THREE.MeshPhysicalMaterial({ name })
        : new THREE.MeshStandardMaterial({ name });
    const priorCompile = vi.fn((parameters: THREE.WebGLProgramParametersWithUniforms) => {
      parameters.uniforms.authoredUniform = { value: 7 };
    });
    source.onBeforeCompile = priorCompile;
    source.customProgramCacheKey = () => "authored-source";
    const adapted = requireStandard(adaptFoliageMaterial(source));
    const parameters = shaderParameters(kind);
    const [prefix, suffix] = parameters.fragmentShader.split("#include <lights_fragment_begin>");
    expect(suffix).toBeDefined();

    adapted.onBeforeCompile(parameters, renderer);

    expect(priorCompile).toHaveBeenCalledExactlyOnceWith(parameters, renderer);
    expect(priorCompile.mock.contexts[0]).toBe(adapted);
    expect(parameters.uniforms.authoredUniform.value).toBe(7);
    expect(parameters.fragmentShader).not.toContain("#include <lights_fragment_begin>");
    expect(adapted.customProgramCacheKey()).toContain(source.customProgramCacheKey());
    expect(adapted.customProgramCacheKey()).not.toBe(source.customProgramCacheKey());
    expect(adapted.userData.yorishiroThinFoliage).not.toBe("pbr-only");
    expect(source.userData.yorishiroThinFoliage).toBeUndefined();

    const patched = parameters.fragmentShader.slice(prefix.length, -suffix.length);
    const original = THREE.ShaderChunk.lights_fragment_begin;
    const directionalStart = original.indexOf("#if ( NUM_DIR_LIGHTS");
    const areaStart = original.indexOf("#if ( NUM_RECT_AREA_LIGHTS");
    expect(directionalStart).toBeGreaterThanOrEqual(0);
    expect(areaStart).toBeGreaterThan(directionalStart);
    // 点光源・スポット・面光源の計算は Three.js の元のまま保つ。
    expect(patched.startsWith(original.slice(0, directionalStart))).toBe(true);
    expect(patched.endsWith(original.slice(areaStart))).toBe(true);
    const directional = patched.slice(
      directionalStart,
      patched.indexOf("#if ( NUM_RECT_AREA_LIGHTS"),
    );
    const shadowLine = original
      .slice(directionalStart, areaStart)
      .split("\n")
      .find((line) => line.includes("directLight.color *=") && line.includes("getShadow("));
    expect(shadowLine).toBeDefined();
    if (!shadowLine) throw new Error("Installed directional shadow attenuation is missing");
    const shadowIndex = directional.indexOf(shadowLine);
    const directIndex = directional.indexOf("RE_Direct(");
    const backlightIndex = directional.indexOf("reflectedLight.directDiffuse +=");
    expect(shadowIndex).toBeGreaterThanOrEqual(0);
    expect(directIndex).toBeGreaterThan(shadowIndex);
    expect(backlightIndex).toBeGreaterThan(directIndex);
    expect(backlightIndex).toBeLessThan(directional.indexOf("#pragma unroll_loop_end"));
    expect(directional.match(/reflectedLight\.directDiffuse\s*\+=/g)).toHaveLength(1);
    expect(directional.slice(backlightIndex)).toMatch(/directLight\.color/);
    expect(directional.slice(backlightIndex)).toMatch(
      /-dot\(\s*geometryNormal,\s*directLight\.direction/,
    );
    expect(THREE.ShaderLib[kind].fragmentShader).toContain("#include <lights_fragment_begin>");

    adapted.dispose();
    source.dispose();
  });

  it.each([
    "lights_fragment_begin",
    "lights_physical_fragment",
  ] as const)("preserves standard PBR when %s changes incompatibly", (chunkName) => {
    const originalChunk = THREE.ShaderChunk[chunkName];
    const source = new THREE.MeshStandardMaterial({ name: "Leaf | green", roughness: 0.95 });
    const priorCompile = vi.fn();
    source.onBeforeCompile = priorCompile;
    let adapted: THREE.MeshStandardMaterial | undefined;
    try {
      // 依存ライブラリが必須シグネチャを改名した場合を模擬する。
      THREE.ShaderChunk[chunkName] = originalChunk
        .split("RE_Direct(")
        .join("RE_DirectNext(")
        .split("material.diffuseContribution")
        .join("material.diffuseNext");
      adapted = requireStandard(adaptFoliageMaterial(source));
      const parameters = shaderParameters("standard");
      const originalFragment = parameters.fragmentShader;

      expect(() => adapted?.onBeforeCompile(parameters, renderer)).not.toThrow();
      expect(priorCompile).toHaveBeenCalledExactlyOnceWith(parameters, renderer);
      expect(parameters.fragmentShader).toBe(originalFragment);
      expect(adapted.userData.yorishiroThinFoliage).toBe("pbr-only");
      expect(adapted.roughness).toBeLessThan(source.roughness);
      expect(source.roughness).toBe(0.95);
    } finally {
      THREE.ShaderChunk[chunkName] = originalChunk;
      adapted?.dispose();
      source.dispose();
    }
  });
});

describe("Twilight Café authored ceramics", () => {
  it("keeps polished GLB glaze and normal strengths without a second adaptation", () => {
    const texture = new THREE.Texture();
    const source = new THREE.MeshPhysicalMaterial({
      name: "Ceramic | celadon glaze",
      roughnessMap: texture,
      roughness: 0.82,
      clearcoat: 0.55,
      clearcoatRoughness: 0.2,
      normalScale: new THREE.Vector2(0.7, 0.65),
    });
    expect(adaptCeramicMaterial(source)).toBeNull();
    expect(source.roughnessMap).toBe(texture);
    expect(source.roughness).toBe(0.82);
    expect(source.clearcoat).toBe(0.55);
    expect(source.clearcoatRoughness).toBe(0.2);
    expect(source.normalScale.toArray()).toEqual([0.7, 0.65]);
    source.dispose();
    texture.dispose();
  });
});
