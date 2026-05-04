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

interface FadingOutEntry {
  readonly howl: Howl;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly fromVolume: number;
}

export class AmbientAudioRuntime {
  private readonly active = new Map<string, ActiveEntry>();
  private readonly fadingOut = new Map<string, FadingOutEntry>();
  private muted = false;
  private masterVolume = 1.0;

  /**
   * Mute / unmute すべての ambient sound。Howl 単位の `mute()` を使うので
   * scene 切替や fadeout 中の Howl にも反映される。新規 Howl は `setMix`
   * 内で生成直後に muted state を適用する。
   *
   * setMix とは独立に呼べる：mix を保ったまま再生だけ止める用途。
   */
  setMuted(muted: boolean): void {
    if (this.muted === muted) return;
    this.muted = muted;
    for (const entry of this.active.values()) entry.howl.mute(muted);
    for (const entry of this.fadingOut.values()) entry.howl.mute(muted);
  }

  /** マスターボリュームを設定する（0.0-1.0）。全 Howl の volume にこの値を乗算する。 */
  setMasterVolume(volume: number): void {
    this.masterVolume = Math.max(0, Math.min(1, volume));
    for (const entry of this.active.values()) {
      entry.howl.volume(entry.volume * this.masterVolume);
    }
  }

  /**
   * Active から外れる sound を fade out して unload を schedule。
   * 再 add に備えて fadingOut Map に保留しておく。
   */
  private startFadeOut(url: string, entry: ActiveEntry): void {
    entry.howl.fade(entry.volume * this.masterVolume, 0, CROSSFADE_MS);
    const timer = setTimeout(() => {
      entry.howl.unload();
      this.fadingOut.delete(url);
    }, CROSSFADE_MS);
    this.fadingOut.set(url, {
      howl: entry.howl,
      timer,
      fromVolume: entry.volume,
    });
    this.active.delete(url);
  }

  /**
   * Diff-based mix update。
   * - 旧 active のうち新 mix に無い → fade out → unload (scheduled)
   * - 旧 active のうち新 mix に有り、fadingOut 中 → resurrect (timer cancel + fade up)
   * - 旧 active のうち新 mix に有り volume 変更 → fade
   * - 旧 active のうち新 mix に有り volume 同じ → 何もしない (再生位置保持)
   * - 新 mix のうち旧 active に無い → 新 Howl を作って play + fade in from 0
   */
  setMix(sounds: ReadonlyArray<ResolvedSound>): void {
    const incoming = new Map<string, number>();
    for (const s of sounds) incoming.set(s.url, s.volume);

    // 削除 (active から fadingOut へ移送)
    for (const [url, entry] of this.active) {
      if (!incoming.has(url)) {
        this.startFadeOut(url, entry);
      }
    }

    // 追加 / 更新
    for (const [url, volume] of incoming) {
      const reviving = this.fadingOut.get(url);
      if (reviving !== undefined) {
        // Fadeout 途中だった同 URL を resurrect — timer を cancel し
        // 既存 Howl の今の volume から target まで fade up し直す
        clearTimeout(reviving.timer);
        this.fadingOut.delete(url);
        reviving.howl.fade(
          reviving.fromVolume * this.masterVolume,
          volume * this.masterVolume,
          CROSSFADE_MS,
        );
        this.active.set(url, { howl: reviving.howl, volume });
        continue;
      }
      const existing = this.active.get(url);
      if (existing === undefined) {
        const howl = new Howl({
          src: [url],
          volume: 0,
          loop: true,
          html5: false,
          // load 失敗時は console.warn + active から外す
          onloaderror: (_id, err) => {
            console.warn(`[ambient-audio] Failed to load '${url}':`, err);
            this.active.delete(url);
          },
        });
        if (this.muted) howl.mute(true);
        howl.play();
        howl.fade(0, volume * this.masterVolume, CROSSFADE_MS);
        this.active.set(url, { howl, volume });
        continue;
      }
      if (existing.volume === volume) {
        // 同 URL + 同 volume → 再生位置を保持するため触らない
        continue;
      }
      existing.howl.fade(
        existing.volume * this.masterVolume,
        volume * this.masterVolume,
        CROSSFADE_MS,
      );
      this.active.set(url, { howl: existing.howl, volume });
    }
  }

  /** 旧 mix を全て fade out → unload。Scene null / app 終了時に呼ぶ。 */
  stopAll(): void {
    for (const [url, entry] of this.active) {
      this.startFadeOut(url, entry);
    }
  }
}
