/**
 * AmbientAudioRuntime — Scene Pack の declarative `ambient` 宣言を受けて、
 * Howler.js の Howl instance を動的に生成 / fade / unload する engine。
 *
 * `setMix` で旧 mix と新 mix の diff を取り、追加 / 削除 / volume 変更を
 * 500ms crossfade で適用。共通する sound は再生位置を保持。
 *
 * Lifecycle: `wire.ts` の `initAmbientAudio` が ScenePackRegistry の
 * subscribeActive に bind し、scene 切替 / hot reload で `setMix` を呼ぶ。
 *
 * Internal design-record: specs/2026-04-25-scene-ambient-audio-design.md §4.5
 */

import { Howl } from "howler";

export interface ResolvedSound {
  readonly url: string;
  readonly volume: number;
}

const CROSSFADE_MS = 500;

interface ActiveEntry {
  readonly howl: Howl;
  readonly volume: number;
}

export class AmbientAudioRuntime {
  private readonly active = new Map<string, ActiveEntry>();

  /**
   * Diff-based mix update。
   * - 旧 active のうち新 mix に無い → fade out → unload (scheduled)
   * - 旧 active のうち新 mix に有り volume 変更 → fade
   * - 旧 active のうち新 mix に有り volume 同じ → 何もしない (再生位置保持)
   * - 新 mix のうち旧 active に無い → 新 Howl を作って play + fade in from 0
   */
  setMix(sounds: ReadonlyArray<ResolvedSound>): void {
    const incoming = new Map<string, number>();
    for (const s of sounds) incoming.set(s.url, s.volume);

    // 削除
    for (const [url, entry] of this.active) {
      if (!incoming.has(url)) {
        entry.howl.fade(entry.volume, 0, CROSSFADE_MS);
        const howl = entry.howl;
        setTimeout(() => howl.unload(), CROSSFADE_MS);
        this.active.delete(url);
      }
    }

    // 追加 / 更新
    for (const [url, volume] of incoming) {
      const existing = this.active.get(url);
      if (existing === undefined) {
        const howl = new Howl({ src: [url], volume: 0, loop: true });
        howl.play();
        howl.fade(0, volume, CROSSFADE_MS);
        this.active.set(url, { howl, volume });
      } else if (existing.volume !== volume) {
        existing.howl.fade(existing.volume, volume, CROSSFADE_MS);
        this.active.set(url, { howl: existing.howl, volume });
      }
      // volume 同じ → 何もしない
    }
  }

  /** 旧 mix を全て fade out → unload。Scene null / app 終了時に呼ぶ。 */
  stopAll(): void {
    for (const [url, entry] of this.active) {
      entry.howl.fade(entry.volume, 0, CROSSFADE_MS);
      // fade 完了後に unload するのが理想だが、Howl の fade end callback は型が薄い。
      // setTimeout で代替 (CROSSFADE_MS 後に unload)。
      const howl = entry.howl;
      setTimeout(() => howl.unload(), CROSSFADE_MS);
      this.active.delete(url);
    }
  }
}
