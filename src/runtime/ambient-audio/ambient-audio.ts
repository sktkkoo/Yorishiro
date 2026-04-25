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

import type { Howl } from "howler";

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
