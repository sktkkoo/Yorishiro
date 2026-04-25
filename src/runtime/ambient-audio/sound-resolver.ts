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
