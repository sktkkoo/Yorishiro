/**
 * SingleActiveRegistry — 「複数 register できるが同時に外に出すのは 1 つ」の
 * single-active pack 用 generic primitive。
 *
 * persona / scene のような single-active 系 Registry が共有する semantic を
 * ここに集約。両 Registry は本 class を extend し、domain 固有の getter/setter
 * alias（`getActivePersona` / `setActiveScene` 等）を追加するだけ。
 *
 * 共通する semantic：
 *   - same id collision 解決：user > bundled、bundled-over-user は warn して ignore、
 *     bundled-over-bundled は後勝ち + warn（dev mistake 相当）
 *   - active 選択：明示 id (config picks) > bundled の alphabetical 先頭 > null
 *   - user が同 id で bundled を override すると active を user に promote
 *     （Design B: user pack は「自薦」しないが、override の意図がある時だけ昇格）
 *   - promotion 由来の active は、その entry が dispose されたら null に戻す
 *     （別の user pack が同 id で来ても auto-select されないように）
 *   - listener fire は **reference 比較**（同 id でも value object が変われば fire）
 *
 * Internal design-record:
 *   - specs/2026-04-18-scene-pack-registry.md §3（scene で確立）
 *   - 2026-04-19-persona-single-active.md（persona に retrofit）
 *
 * 関連 decisions: docs/decisions/single-active-config-picks.md, pack-override-pattern.md
 */

import type { Disposable, SingleActiveEntry, SingleActiveRegistryOptions } from "./types";

export class SingleActiveRegistry<TEntry extends SingleActiveEntry, TValue> {
  private readonly entries = new Map<string, TEntry>();
  private readonly listeners = new Set<(value: TValue | null) => void>();
  private activeId: string | null = null;
  /**
   * activeId が register 内の override 促進（"bundled を user が同 id で上書き
   * した時に active を user 側に引き継ぐ"）経由で set されたか。`setActive`
   * 経由で set された場合は false。これにより user entry が後で dispose された時、
   * promotion 由来の id を掃除して「別の user pack が同 id で来たら Design B に
   * 反して auto-select される」を防ぐ。
   */
  private activeIdIsPromoted = false;
  /**
   * 最後に fire した value の reference。id ではなく reference 比較する。
   * 同 id で user が bundled を override した場合、id は同じでも value object
   * が変わる — この時 listener は fire すべき（React state 更新が必要）。
   * id 比較だと miss する（scene-pack-registry Phase 1 review で修正された gotcha）。
   */
  private lastActive: TValue | null = null;
  private readonly extractValue: (entry: TEntry) => TValue;
  private readonly warn: (msg: string) => void;
  private readonly warnOnMultipleBundled: boolean;

  constructor(opts: SingleActiveRegistryOptions<TEntry, TValue>) {
    this.extractValue = opts.extractValue;
    this.warn = opts.warn ?? ((msg) => console.warn(`[${opts.label}] ${msg}`));
    this.warnOnMultipleBundled = opts.warnOnMultipleBundled ?? false;
  }

  register(entry: TEntry): Disposable {
    const existing = this.entries.get(entry.id);
    if (existing === undefined) {
      this.entries.set(entry.id, entry);
    } else {
      if (entry.origin === "user") {
        // user が来たら existing を dispose + 置換。
        // bundled を override した場合は activeId をこの id に promote する：
        // computeActive は bundled 以外を auto-select しないため、置換後に
        // activeId が null だと user entry が選ばれなくなる。
        this.entries.set(entry.id, entry);
        if (existing.origin === "bundled" && this.activeId === null) {
          this.activeId = entry.id;
          this.activeIdIsPromoted = true;
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

    if (this.warnOnMultipleBundled) {
      this.checkBundledCollision();
    }
    this.reselect();

    return {
      dispose: () => {
        if (this.entries.get(entry.id) === entry) {
          this.entries.delete(entry.id);
          // promotion 由来で active に昇格した id が、その同じ entry の dispose で消えるなら
          // activeId を null に戻す（Design B の "user は auto-select されない" を守る）
          if (this.activeIdIsPromoted && this.activeId === entry.id) {
            this.activeId = null;
            this.activeIdIsPromoted = false;
          }
          this.reselect();
        }
      },
    };
  }

  /** 現在の active value（または null）。 */
  getActive(): TValue | null {
    const entry = this.computeActive();
    return entry !== null ? this.extractValue(entry) : null;
  }

  /**
   * active 変更を subscribe。登録時に現 active で同期 1 回 fire。
   * 返す Disposable は unsubscribe。
   */
  subscribeActive(listener: (value: TValue | null) => void): Disposable {
    this.listeners.add(listener);
    listener(this.getActive());
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  /**
   * Active を user 選択として設定（`config.json` の対応 field 由来）。
   * id が null なら selection クリア（fallback で bundled alphabetical 先頭に戻る）。
   * 指定 id が存在しなくても error にせず、fall-through で bundled default を選ぶ。
   */
  setActive(id: string | null): void {
    this.activeId = id;
    this.activeIdIsPromoted = false;
    this.reselect();
  }

  /** debug / 設定 UI 用：登録済み全 entry を列挙。 */
  listEntries(): ReadonlyArray<TEntry> {
    return Array.from(this.entries.values());
  }

  private reselect(): void {
    const entry = this.computeActive();
    const value = entry !== null ? this.extractValue(entry) : null;
    if (value === this.lastActive) return;
    this.lastActive = value;
    // snapshot：listener が dispatch 中に dispose しても今回の loop は完走させる
    for (const listener of Array.from(this.listeners)) {
      listener(value);
    }
  }

  /**
   * Active entry を選ぶ pure logic（internal）。
   *
   * Priority:
   *   1. activeId が entries に hit → それ
   *   2. 無ければ bundled tier の alphabetical 先頭（fresh install fallback）
   *   3. bundled なし → null
   *
   * user tier を自動選択しない。pack 自己申告の `defaultActive` も使わない
   * （Design B: docs/decisions/single-active-config-picks.md）。
   */
  private computeActive(): TEntry | null {
    if (this.activeId !== null) {
      const hit = this.entries.get(this.activeId);
      if (hit !== undefined) return hit;
    }
    const bundled = Array.from(this.entries.values())
      .filter((e) => e.origin === "bundled")
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return bundled[0] ?? null;
  }

  private checkBundledCollision(): void {
    const bundled = Array.from(this.entries.values()).filter((e) => e.origin === "bundled");
    if (bundled.length > 1) {
      const sorted = [...bundled].sort((a, b) => a.id.localeCompare(b.id));
      this.warn(
        `multiple bundled packs registered — fallback will pick "${sorted[0].id}" alphabetically. Others: ${JSON.stringify(sorted.slice(1).map((e) => e.id))}. This is a dev-time mistake.`,
      );
    }
  }
}
