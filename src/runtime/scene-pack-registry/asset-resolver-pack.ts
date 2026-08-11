/**
 * Pack-relative asset path を絶対 URL に解決するヘルパー factory.
 *
 * Pack の component が `resolveAsset("./assets/foo.glb")` を呼ぶと、この factory
 * が返す関数が pack 出自と pack id に基づいて絶対 URL を返す.
 *
 * Bundled origin: Vite の import.meta.glob で build 時に取得した URL 表から
 *                 lookup する. 漏れた asset は relative path をそのまま返す
 *                 （graceful degradation, log は呼び元の責務）.
 * User origin: loader が ScenePackEntry に注入する `makeUserResolveAsset` を使う。
 *              本 factory の user branch は古い entry 向けの互換 fallback。
 *
 * 既存 `asset-resolver.ts` の SceneSpec 用 logic と分離している. あちらは
 * SceneSpec の layer.src / ambient.src を一括変換する宣言的 path, こちらは
 * pack の component から呼ばれる関数 form.
 *
 * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §3.1
 */

import {
  isAbsoluteUrl,
  isSafeUserPackRelativePath,
  normalizeRelativePath,
  stripLeadingDotSlash,
} from "./asset-resolver";
import type { PackOrigin } from "./types";

export interface MakeResolveAssetOptions {
  readonly packId: string;
  readonly origin: PackOrigin;
  /**
   * Bundled asset の URL 表. 通常は `BUNDLED_ASSETS` （`asset-resolver.ts` で
   * 定義された Vite glob 結果）を渡す. test では mock 表を渡せるよう注入可能.
   */
  readonly bundledAssets: Record<string, string>;
}

/**
 * local user component scene 向けの pack-scoped asset resolver。
 *
 * source import と同じく pack directory を境界にし、absolute URL / absolute
 * filesystem path / parent traversal は host 側で拒否する。Pack code へ raw
 * Tauri API は渡さず、検証済み path だけを asset URL に変換する。
 */
export function makeUserResolveAsset(
  packDir: string,
  convertFileSrc: (filePath: string) => string,
): (relativePath: string) => string {
  return (relativePath: string): string => {
    const clean = normalizeRelativePath(relativePath);
    if (!isSafeUserPackRelativePath(clean)) {
      throw new Error(`unsafe user pack asset path: ${relativePath}`);
    }
    return convertFileSrc(`${packDir}/${clean}`);
  };
}

export function makeResolveAsset(opts: MakeResolveAssetOptions): (relativePath: string) => string {
  return (relativePath: string): string => {
    if (isAbsoluteUrl(relativePath)) return relativePath;
    if (opts.origin === "user") {
      // User pack の component 拡張は別 plan. 現状は relative をそのまま返す.
      return relativePath;
    }
    const stripped = stripLeadingDotSlash(relativePath);
    const key = `/bundled-packs/scenes/${opts.packId}/${stripped}`;
    return opts.bundledAssets[key] ?? relativePath;
  };
}
