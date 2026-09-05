/**
 * Twilight Caféの材質調整。Three.js 0.183.2のシェーダー構造で検証。
 * 返した材質は呼び出し側が破棄し、共有テクスチャは変更・破棄しない。
 */
import * as THREE from "three";

const DIRECTIONAL_START = "#if ( NUM_DIR_LIGHTS > 0 ) && defined( RE_Direct )";
const DIRECTIONAL_END = "#if ( NUM_RECT_AREA_LIGHTS > 0 ) && defined( RE_Direct_RectArea )";
const DIRECT_CALL =
  "RE_Direct( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );";
const LIGHTS_INCLUDE = "#include <lights_fragment_begin>";

function thinBacklightChunk(amount: number): string | null {
  const chunk = THREE.ShaderChunk.lights_fragment_begin;
  if (typeof chunk !== "string") return null;
  const start = chunk.indexOf(DIRECTIONAL_START);
  const end = chunk.indexOf(DIRECTIONAL_END, start);
  if (
    start < 0 ||
    end <= start ||
    !THREE.ShaderChunk.lights_physical_fragment?.includes("material.diffuseContribution")
  )
    return null;

  const directional = chunk.slice(start, end);
  if (directional.split(DIRECT_CALL).length !== 2) return null;
  const addition = `
    // 薄い葉・花弁の裏側から届く光を控えめに加える。
    // 法線の表裏補正と影の減衰は、この位置で既に反映されている。
    // ループ展開時の変数再宣言を避けるため、余弦は式内で計算する。
    reflectedLight.directDiffuse += directLight.color
      * BRDF_Lambert( material.diffuseContribution )
      * ( ${amount.toFixed(3)} * max( -dot( geometryNormal, directLight.direction ), 0.0 ) );
  `;
  return (
    chunk.slice(0, start) +
    directional.replace(DIRECT_CALL, DIRECT_CALL + addition) +
    chunk.slice(end)
  );
}

/**
 * 色・法線・粗さ・AO・面の向きを保持し、通常のPBRに逆光成分を加える。
 * 発光や屈折パスは使わず、点光源とスポットライトの処理も変えない。
 * 将来のシェーダー構造が合わなければ、PBRの材質調整だけを適用する。
 */
export function adaptFoliageMaterial(source: THREE.Material): THREE.Material | null {
  const leaf = source.name.startsWith("Leaf |");
  const petal = source.name.startsWith("Petal |");
  if ((!leaf && !petal) || !(source instanceof THREE.MeshStandardMaterial)) return null;

  const material = source.clone();
  // 葉の表面に広く控えめな光沢を残し、乾いた粘土のような質感を避ける。
  material.roughness = leaf ? 0.54 : 0.68;
  material.metalness = 0;
  if (material instanceof THREE.MeshPhysicalMaterial) {
    material.clearcoat = 0;
    material.transmission = 0;
    material.sheen = 0;
    material.specularIntensity = leaf ? 0.7 : 0.5;
  }

  const amount = leaf ? 0.16 : 0.2;
  const patchedChunk = thinBacklightChunk(amount);
  const previousCompile = source.onBeforeCompile;
  const previousCacheKey = source.customProgramCacheKey.call(source);
  const patchKey = `yori-thin-foliage-v1:r${THREE.REVISION}:${amount.toFixed(3)}`;
  material.customProgramCacheKey = () => `${previousCacheKey}|${patchKey}`;
  material.userData.yorishiroThinFoliage = "pbr-only";
  material.onBeforeCompile = function (shader, renderer) {
    previousCompile.call(this, shader, renderer);
    if (
      patchedChunk === null ||
      !shader.fragmentShader.includes(LIGHTS_INCLUDE) ||
      !shader.fragmentShader.includes("#include <lights_physical_fragment>") ||
      !shader.fragmentShader.includes("#include <lights_physical_pars_fragment>")
    )
      return;
    shader.fragmentShader = shader.fragmentShader.replace(LIGHTS_INCLUDE, patchedChunk);
    this.userData.yorishiroThinFoliage = patchKey;
  };
  return material;
}

/**
 * 旧版の釉薬付き陶器だけを補正する。調整済みのGLB材質はnullを返し、
 * 制作時の粗さ・コート・法線を保持する。素焼きと花粉は対象にしない。
 */
export function adaptCeramicMaterial(source: THREE.Material): THREE.Material | null {
  if (
    !(source instanceof THREE.MeshStandardMaterial) ||
    !/^Ceramic \| (ivory stoneware|ochre glaze|celadon glaze)(?:\.\d+)?$/.test(source.name)
  )
    return null;

  if (
    source instanceof THREE.MeshPhysicalMaterial &&
    source.clearcoat >= 0.5 &&
    source.clearcoatRoughness <= 0.25 &&
    source.roughness <= (source.roughnessMap ? 0.9 : 0.5)
  )
    return null;

  let material: THREE.MeshPhysicalMaterial;
  if (source instanceof THREE.MeshPhysicalMaterial) {
    material = source.clone();
  } else {
    // 存在しないPhysical固有値を読まずにStandardの値だけを複製し、
    // Physical用シェーダーの定義を維持する。
    material = new THREE.MeshPhysicalMaterial();
    THREE.MeshStandardMaterial.prototype.copy.call(material, source);
    material.defines = { STANDARD: "", PHYSICAL: "" };
  }
  material.roughness = source.roughnessMap ? 0.4 : 0.22;
  material.metalness = 0;
  material.clearcoat = 0.6;
  material.clearcoatRoughness = 0.12;
  material.specularIntensity = 0.8;
  material.ior = 1.5;
  material.transmission = 0;
  material.normalScale.multiplyScalar(0.45);
  material.clearcoatNormalScale.multiplyScalar(0.35);
  material.bumpScale *= 0.45;
  material.onBeforeCompile = source.onBeforeCompile;
  material.customProgramCacheKey = source.customProgramCacheKey;
  return material;
}
