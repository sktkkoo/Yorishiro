/**
 * ScenePackRegistry — scene pack の宣言を保管し、active scene を選択する primitive。
 *
 * Effect pack と Scene pack は概念が違う（event-driven vs declarative）。
 * EffectPackRunner とは別 concept として独立（memory:
 * feedback_separate_conceptually_distinct_systems.md）。
 *
 * override 挙動：user が bundled を dispose + 置換。
 * 将来 effect / persona にも同じ pattern を retrofit する reference（memory:
 * feedback_pack_override_pattern.md）。
 *
 * Internal design-record: specs/2026-04-18-scene-pack-registry.md §3
 */

import type { SceneSpec } from "../../sdk/scene";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { computeActive } from "./select-active";
import type {
  Disposable,
  ScenePackEntry,
  ScenePackRegistry as ScenePackRegistryInterface,
} from "./types";

export interface ScenePackRegistryOptions {
  /** 診断ログ（bundled-over-user warning、bundled collision 等） */
  readonly warn?: (msg: string) => void;
}

export class ScenePackRegistryImpl implements ScenePackRegistryInterface {
  private readonly entries = new Map<string, ScenePackEntry>();
  private readonly listeners = new Set<(scene: SceneSpec | null) => void>();
  private activeSceneId: string | null = null;
  /**
   * activeSceneId が register 内の override 促進（"bundled を user が同 id で上書きした時に
   * active を user 側に引き継ぐ"）経由で set されたか。`setActiveScene` 経由で set された
   * 場合は false。これにより user entry が後で dispose された時、promotion 由来の id を
   * 掃除して「別の user pack が同 id で来たら Design B に反して auto-select される」を防ぐ。
   */
  private activeSceneIdIsPromoted = false;
  /**
   * 最後に fire した scene の reference。id ではなく reference 比較する。
   * 同 id で user が bundled を override した場合、id は同じでも scene object
   * が変わる — この時 listener は fire すべき（React Sidebar の state 更新が
   * 必要）。id 比較だと miss する（Phase 1 review で修正された gotcha）。
   */
  private lastActiveScene: SceneSpec | null = null;
  private readonly warn: (msg: string) => void;

  constructor(opts: ScenePackRegistryOptions = {}) {
    this.warn = opts.warn ?? ((msg) => console.warn(`[ScenePackRegistry] ${msg}`));
  }

  register(entry: ScenePackEntry): Disposable {
    const existing = this.entries.get(entry.id);
    if (existing === undefined) {
      this.entries.set(entry.id, entry);
    } else {
      if (entry.origin === "user") {
        // user が来たら existing を dispose + 置換。
        // bundled を override した場合は activeSceneId をこの id に昇格する：
        // computeActive は bundled 以外を auto-select しないため、置換後に
        // activeSceneId が null だと user entry が選ばれなくなる。
        this.entries.set(entry.id, entry);
        if (existing.origin === "bundled" && this.activeSceneId === null) {
          this.activeSceneId = entry.id;
          this.activeSceneIdIsPromoted = true;
        }
      } else {
        // incoming が bundled
        if (existing.origin === "user") {
          // 起こるはず無い（load 順序は bundled → user）。起きたら warning、incoming を ignore
          this.warn(`bundled "${entry.id}" arrived after user registration — ignored (user wins)`);
        } else {
          // bundled 同士 — 開発ミス相当。後勝ち + warning
          this.warn(`bundled id collision for "${entry.id}" — overwriting`);
          this.entries.set(entry.id, entry);
        }
      }
    }

    this.checkBundledCollision();
    this.reselect();

    return {
      dispose: () => {
        if (this.entries.get(entry.id) === entry) {
          this.entries.delete(entry.id);
          // promotion 由来で active に昇格した id が、その同じ entry の dispose で消えるなら
          // activeSceneId を null に戻す（Design B の "user は auto-select されない" を守る）
          if (this.activeSceneIdIsPromoted && this.activeSceneId === entry.id) {
            this.activeSceneId = null;
            this.activeSceneIdIsPromoted = false;
          }
          this.reselect();
        }
      },
    };
  }

  getActiveScene(): SceneSpec | null {
    const entry = computeActive(Array.from(this.entries.values()), this.activeSceneId);
    return entry?.scene ?? null;
  }

  subscribeActive(listener: (scene: SceneSpec | null) => void): Disposable {
    this.listeners.add(listener);
    listener(this.getActiveScene());
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  setActiveScene(id: string | null): void {
    this.activeSceneId = id;
    this.activeSceneIdIsPromoted = false;
    this.reselect();
  }

  listEntries(): ReadonlyArray<ScenePackEntry> {
    return Array.from(this.entries.values());
  }

  private reselect(): void {
    const active = computeActive(Array.from(this.entries.values()), this.activeSceneId);
    const scene = active?.scene ?? null;
    // reference 比較：同 id でも scene object が違えば fire する
    if (scene === this.lastActiveScene) return;
    this.lastActiveScene = scene;
    for (const listener of Array.from(this.listeners)) {
      listener(scene);
    }
  }

  private checkBundledCollision(): void {
    const bundled = Array.from(this.entries.values()).filter((e) => e.origin === "bundled");
    if (bundled.length > 1) {
      const sorted = [...bundled].sort((a, b) => a.id.localeCompare(b.id));
      this.warn(
        `multiple bundled scene packs registered — fallback will pick "${sorted[0].id}" alphabetically. Others: ${JSON.stringify(sorted.slice(1).map((e) => e.id))}. This is a dev-time mistake.`,
      );
    }
  }
}

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getSceneRegistry(): ScenePackRegistryInterface {
  return getOrInit(KEYS.SCENE_PACK_REGISTRY, () => new ScenePackRegistryImpl());
}
