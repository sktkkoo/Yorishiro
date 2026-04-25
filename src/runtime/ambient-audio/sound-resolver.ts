/**
 * Ambient sound の asset path 解決。
 *
 * 3 経路:
 *   1. `'sound:<name>'` / `'sound:<namespace>/<name>'` — shared library
 *      (bundled-packs/shared/sounds/ 配下、Vite glob で build-time bundle)
 *   2. `'./<path>'` — pack-relative (既存の resolveBundledAsset / resolveUserAsset 経由)
 *   3. 絶対 URL — そのまま pass-through
 *
 * Internal design-record: specs/2026-04-25-scene-ambient-audio-design.md §4.4
 */

const SHARED_SOUNDS_PREFIX = "/bundled-packs/shared/sounds/";
const SUPPORTED_EXT = /\.(mp3|wav|ogg|m4a)$/i;

/**
 * Vite glob result の path から stem を抽出。
 * 例: '/bundled-packs/shared/sounds/lofi-vibes/cafe.mp3' → 'lofi-vibes/cafe'
 */
export function pathToStem(path: string): string {
  const stripped = path.startsWith(SHARED_SOUNDS_PREFIX)
    ? path.slice(SHARED_SOUNDS_PREFIX.length)
    : path;
  return stripped.replace(SUPPORTED_EXT, "");
}

/**
 * Vite glob result から stem → URL の Map を構築。
 * Stem 衝突 (例: rain.mp3 と rain.wav) は throw して fail-fast。
 *
 * Pure 関数 (glob は import.meta.glob result を inject)。
 * Module init 時に 1 回呼ばれて SHARED_SOUNDS が確定する。
 */
export function buildSharedSoundMap(glob: Record<string, string>): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const sources = new Map<string, string>(); // stem → first path (for error messages)
  for (const [path, url] of Object.entries(glob)) {
    const stem = pathToStem(path);
    const existingPath = sources.get(stem);
    if (existingPath !== undefined) {
      throw new Error(
        `Duplicate shared sound name '${stem}': '${path}' collides with '${existingPath}'. ` +
          `Shared sound names must be unique across extensions and namespaces.`,
      );
    }
    sources.set(stem, path);
    map.set(stem, url);
  }
  return map;
}

/**
 * shared library map から stem を引いて URL を返す。Map ベースの単純 lookup。
 * `'sound:'` prefix の strip / 絶対 URL pass-through / pack-relative dispatch は
 * scene-pack-registry/asset-resolver.ts 側が orchestrate する (循環 import 回避)。
 */
export function resolveSharedSound(
  stem: string,
  sharedMap: ReadonlyMap<string, string>,
): string | null {
  return sharedMap.get(stem) ?? null;
}

/**
 * Vite が build 時に bundled-packs/shared/sounds/ を walk して URL map を作る。
 * Glob pattern: flat root + 一段 namespace のみ ({*,*\/*})。深い階層は対象外。
 *
 * Module init 時に buildSharedSoundMap で Map 化、duplicate stem は throw
 * (build / dev / prod すべてで即失敗)。
 */
const SHARED_SOUNDS_GLOB = import.meta.glob(
  "/bundled-packs/shared/sounds/{*,*/*}.{mp3,wav,ogg,m4a}",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

export const SHARED_SOUNDS: ReadonlyMap<string, string> = buildSharedSoundMap(SHARED_SOUNDS_GLOB);
