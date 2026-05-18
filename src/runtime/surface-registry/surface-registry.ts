/**
 * SurfaceRegistryImpl — named surface → DOM mount node の host 所有マップ。
 * single-active ではなく単純な name→node。HMR をまたいで 1 instance。
 *
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §1
 */

import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { SurfaceName, SurfaceRegistry } from "./types";

export class SurfaceRegistryImpl implements SurfaceRegistry {
  private readonly map = new Map<SurfaceName, HTMLElement>();

  register(name: SurfaceName, el: HTMLElement): void {
    this.map.set(name, el);
  }

  unregister(name: SurfaceName, el: HTMLElement): void {
    if (this.map.get(name) === el) this.map.delete(name);
  }

  get(name: SurfaceName): HTMLElement | null {
    return this.map.get(name) ?? null;
  }

  has(name: SurfaceName): boolean {
    return this.map.has(name);
  }
}

/** factory（test 用の new instance 生成） */
export function createSurfaceRegistry(): SurfaceRegistry {
  return new SurfaceRegistryImpl();
}

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getSurfaceRegistry(): SurfaceRegistry {
  return getOrInit(KEYS.SURFACE_REGISTRY, () => new SurfaceRegistryImpl());
}
