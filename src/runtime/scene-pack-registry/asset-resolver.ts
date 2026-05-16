/**
 * Scene pack の asset path を絶対 URL に解決する Loader 層の helper。
 *
 * pack 作者は bundled / user どちらでも同じ書き方：
 *   - `src: "./assets/foo.mp4"` (pack-relative)
 *   - bundled pack のみ `src: "https://cdn.example.com/foo.mp4"` (絶対 URL)
 *
 * Loader がここで pack 出自に応じて変換：
 *   - bundled: Vite の import.meta.glob で build 時に asset URL を取得
 *   - user: Tauri の convertFileSrc で asset:// URL に。公開配布前提では
 *           remote URL / data URL / file URL / absolute path / traversal を拒否する。
 *
 * Internal design-record: specs/2026-04-18-scene-pack-registry.md §5
 */

import type { AmbientSound, Layer, SceneSpec } from "../../sdk/scene";
import { resolveSharedSound, SHARED_SOUNDS } from "../ambient-audio/sound-resolver";

/**
 * Vite の import.meta.glob で bundled-packs/scenes/ 配下の asset を build 時に取得。
 * eager: true で初期 chunk に URL を含める（asset 自体は lazy 配信される）。
 *
 * Glob pattern に漏れた拡張子の asset は undefined が返り、当該 layer は
 * src を外して register される（§5.5 graceful degradation）。
 */
export const BUNDLED_ASSETS = import.meta.glob(
  "/bundled-packs/scenes/**/*.{mp4,webm,mov,m4v,ogv,jpg,jpeg,png,webp,avif,gif,svg,mp3,wav,ogg,m4a,glb,gltf}",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

/**
 * 絶対 URL（protocol 含み）かどうか判定。
 * 対応 protocol: http / https / asset / data / blob / file
 */
export function isAbsoluteUrl(src: string): boolean {
  return /^(https?|asset|data|blob|file):/i.test(src);
}

/**
 * 相対 path の leading `./` を剥がして返す。
 */
export function normalizeRelativePath(src: string): string {
  return src.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * normalizeRelativePath の互換 alias。
 * plan 上の名前に合わせて、既存利用を残したまま公開する。
 */
export const stripLeadingDotSlash = normalizeRelativePath;

/**
 * bundled pack の pack-relative path を絶対 URL に解決。見つからなければ null。
 *
 * Defense-in-depth: packId / relativePath に path escape を含んでいたら null を即返す。
 * bundled-packs/scenes/<packId>/<clean> の外に抜ける key を作らせない。
 */
export function resolveBundledAsset(packId: string, relativePath: string): string | null {
  // packId に path separator / traversal を含む場合は拒否
  if (packId.includes("/") || packId.includes("..")) return null;
  const clean = normalizeRelativePath(relativePath);
  // 正規化後も traversal が残る場合は拒否
  if (clean.startsWith("../") || clean.includes("/../")) return null;
  const key = `/bundled-packs/scenes/${packId}/${clean}`;
  return BUNDLED_ASSETS[key] ?? null;
}

/**
 * user pack の pack-relative path を絶対 URL (asset://) に解決。
 * 実装は Tauri の convertFileSrc を dynamic import して使う。
 */
export async function resolveUserAsset(packDir: string, relativePath: string): Promise<string> {
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const clean = normalizeRelativePath(relativePath);
  if (!isSafeUserPackRelativePath(clean)) {
    throw new Error(`unsafe user pack asset path: ${relativePath}`);
  }
  const absolutePath = `${packDir}/${clean}`;
  return convertFileSrc(absolutePath);
}

export interface ResolveOptions {
  readonly origin: "bundled" | "user";
  readonly packId: string;
  readonly packDir?: string;
  /**
   * Resolution failure callback。`assetKey` は layer の場合は layer.id、
   * ambient の場合は文字列 `"ambient"` (集約識別子)。
   */
  readonly onMissing?: (assetKey: string, src: string) => void;
}

/**
 * layer asset 解決に使う resolver 関数の注入インターフェース。
 * テストで fake resolver を差し込むために使う。
 */
export interface LayerResolvers {
  readonly resolveBundled: (packId: string, relativePath: string) => string | null;
  readonly resolveUser: (packDir: string, relativePath: string) => Promise<string>;
}

export function isSafeUserPackRelativePath(src: string): boolean {
  if (src === "") return false;
  if (src.startsWith("/") || src.startsWith("~")) return false;
  if (isAbsoluteUrl(src)) return false;
  const clean = normalizeRelativePath(src);
  if (clean === "" || clean === "." || clean === "..") return false;
  return !clean.startsWith("../") && !clean.includes("/../");
}

function stripUnsafeUserLayerFields(layer: Layer, options: ResolveOptions): Layer {
  if (options.origin !== "user") return layer;
  if (layer.backgroundImage === undefined || !/url\s*\(/i.test(layer.backgroundImage)) {
    return layer;
  }
  options.onMissing?.(layer.id, layer.backgroundImage);
  return { ...layer, backgroundImage: undefined };
}

/**
 * 1 つの layer の src を絶対 URL に解決する純粋 walker。
 * resolver は外から注入するためテスト可能。
 * 解決失敗時は src を undefined に置き換える（graceful degradation）。
 */
export async function resolveLayerAssetWith(
  layer: Layer,
  options: ResolveOptions,
  resolvers: LayerResolvers,
): Promise<Layer> {
  const sanitized = stripUnsafeUserLayerFields(layer, options);
  if (sanitized.src === undefined) return sanitized;
  if (options.origin === "user" && !isSafeUserPackRelativePath(sanitized.src)) {
    options.onMissing?.(sanitized.id, sanitized.src);
    return { ...sanitized, src: undefined };
  }
  if (isAbsoluteUrl(sanitized.src)) return sanitized;

  if (sanitized.src.startsWith("/")) {
    // Vite public/ 扱い。user origin は上の guard で拒否済み。
    return sanitized;
  }

  try {
    let resolved: string | null = null;
    if (options.origin === "bundled") {
      resolved = resolvers.resolveBundled(options.packId, sanitized.src);
    } else {
      if (options.packDir === undefined) {
        options.onMissing?.(sanitized.id, sanitized.src);
        return { ...sanitized, src: undefined };
      }
      resolved = await resolvers.resolveUser(options.packDir, sanitized.src);
    }

    if (resolved === null) {
      options.onMissing?.(sanitized.id, sanitized.src);
      return { ...sanitized, src: undefined };
    }
    return { ...sanitized, src: resolved };
  } catch {
    // convertFileSrc 等が unexpected throw したらここで吸収
    options.onMissing?.(sanitized.id, sanitized.src);
    return { ...sanitized, src: undefined };
  }
}

/** production で使うデフォルト resolver */
const DEFAULT_RESOLVERS: LayerResolvers = {
  resolveBundled: resolveBundledAsset,
  resolveUser: resolveUserAsset,
};

/**
 * SceneSpec の全 layer を walk し、src を絶対 URL に解決する。
 * ambient が宣言されている場合は ambient[] も walk して src を解決する。
 * 解決失敗時は当該 layer の src を undefined に、ambient entry を配列から除去（graceful degradation）。
 *
 * onMissing: 解決失敗時に呼ばれる callback（dev-log 等に warning を出す用途）。
 */
export async function resolveSceneAssets(
  scene: SceneSpec,
  options: ResolveOptions,
): Promise<SceneSpec> {
  const resolvedLayers = await Promise.all(
    scene.layers.map((layer) => resolveLayerAssetWith(layer, options, DEFAULT_RESOLVERS)),
  );

  if (scene.ambient === undefined) {
    return { ...scene, layers: resolvedLayers };
  }

  const resolvedAmbient = (
    await Promise.all(scene.ambient.map((a) => resolveAmbientSound(a, options)))
  ).filter((a): a is NonNullable<typeof a> => a !== null);

  return { ...scene, layers: resolvedLayers, ambient: resolvedAmbient };
}

const SOUND_SCHEME_PREFIX = "sound:";

/**
 * 1 つの ambient sound の src を絶対 URL に解決する。
 * - `'sound:<stem>'` → SHARED_SOUNDS を引く
 * - 絶対 URL → そのまま
 * - `'./...'` → bundled / user の既存 resolver
 * 解決失敗時は null を返し、呼び出し側で entry を落とす (graceful degradation)。
 */
async function resolveAmbientSound(
  ambient: AmbientSound,
  options: ResolveOptions,
): Promise<AmbientSound | null> {
  if (ambient.src.startsWith(SOUND_SCHEME_PREFIX)) {
    const stem = ambient.src.slice(SOUND_SCHEME_PREFIX.length);
    const resolved = resolveSharedSound(stem, SHARED_SOUNDS);
    if (resolved === null) {
      options.onMissing?.("ambient", ambient.src);
      return null;
    }
    return { ...ambient, src: resolved };
  }

  if (options.origin === "user" && !isSafeUserPackRelativePath(ambient.src)) {
    options.onMissing?.("ambient", ambient.src);
    return null;
  }

  if (isAbsoluteUrl(ambient.src)) return ambient;

  // NOTE: bundled / user の pack-relative branch は unit test の coverage 外。
  // resolveBundledAsset / resolveUserAsset の挙動は asset-resolver の layer 系
  // test (resolveLayerAssetWith) で injection 経由で検証済み。end-to-end 検証は
  // Task 15 の dev verification (実 scene + 実 sound file) に委ねる。
  try {
    let resolved: string | null = null;
    if (options.origin === "bundled") {
      resolved = resolveBundledAsset(options.packId, ambient.src);
    } else if (options.packDir !== undefined) {
      resolved = await resolveUserAsset(options.packDir, ambient.src);
    }
    if (resolved === null) {
      options.onMissing?.("ambient", ambient.src);
      return null;
    }
    return { ...ambient, src: resolved };
  } catch {
    options.onMissing?.("ambient", ambient.src);
    return null;
  }
}
