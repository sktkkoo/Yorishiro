/**
 * screen-flash — 画面全体を白く一瞬フラッシュさせる built-in Effect Pack。
 *
 * 主用途: スクリーンショット撮影時の視覚フィードバック（撮ったことが
 * user に伝わるよう）。カメラの shutter flash 風に短い fade-in と
 * やや長い fade-out で、邪魔にならない肌触りを狙う。
 *
 * 実装は ctx.renderer.addDomLayer で全画面 div を貼り、opacity を CSS
 * transition で animate する。Three.js scene 内ではなく DOM overlay
 * なので、撮影直後の screenshot 自体には flash 像は写らない（撮影 →
 * 結果返却 → micro-task で flash dispatch の順序になっている）。
 */

import type { EffectContext, EffectDefinition } from "@yorishiro/sdk";

interface ScreenFlashOptions {
  /** flash の色。default: #ffffff */
  readonly color: string;
  /** fade-in にかける時間（ms）。default: 25 */
  readonly fadeInMs: number;
  /** peak → afterglow への drop 時間（ms）。default: 110 */
  readonly fadeOutMs: number;
  /** peak opacity (0-1)。default: 0.85 */
  readonly peakOpacity: number;
  /** afterglow（残像）の opacity (0-1)。0 で残像なし。default: 0.12 */
  readonly afterglowOpacity: number;
  /** afterglow が 0 まで完全に消えるまでの時間（ms）。default: 850 */
  readonly afterglowFadeMs: number;
}

export default {
  id: "screen-flash",
  type: "effect",
  run: async (
    ctx: EffectContext<Partial<ScreenFlashOptions>>,
    options: Partial<ScreenFlashOptions>,
  ): Promise<void> => {
    const color = options.color ?? "#ffffff";
    const fadeInMs = Math.max(1, options.fadeInMs ?? 25);
    const fadeOutMs = Math.max(1, options.fadeOutMs ?? 110);
    const peakOpacity = Math.max(0, Math.min(1, options.peakOpacity ?? 0.85));
    const afterglowOpacity = Math.max(0, Math.min(1, options.afterglowOpacity ?? 0.12));
    const afterglowFadeMs = Math.max(0, options.afterglowFadeMs ?? 850);

    let overlay: HTMLDivElement | null = null;
    const layer = ctx.renderer.addDomLayer((container) => {
      const div = document.createElement("div");
      div.style.position = "absolute";
      div.style.inset = "0";
      div.style.backgroundColor = color;
      div.style.opacity = "0";
      div.style.pointerEvents = "none";
      div.style.zIndex = "9999";
      div.style.transition = `opacity ${fadeInMs}ms linear`;
      container.appendChild(div);
      overlay = div;
    });

    try {
      // 次フレームで opacity を peak に上げる（transition が確実に走る）。
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (overlay) {
        (overlay as HTMLDivElement).style.opacity = String(peakOpacity);
      }
      await ctx.time.after(fadeInMs);

      // peak → afterglow への急速 drop。afterglow=0 なら通常の fade-out と同じ。
      if (overlay) {
        const el = overlay as HTMLDivElement;
        el.style.transition = `opacity ${fadeOutMs}ms ease-out`;
        el.style.opacity = String(afterglowOpacity);
      }
      await ctx.time.after(fadeOutMs);

      // afterglow → 0 への緩やかな fade-out。残像のだんだん消える質感を作る。
      if (afterglowOpacity > 0 && afterglowFadeMs > 0) {
        if (overlay) {
          const el = overlay as HTMLDivElement;
          el.style.transition = `opacity ${afterglowFadeMs}ms ease-out`;
          el.style.opacity = "0";
        }
        await ctx.time.after(afterglowFadeMs);
      }
    } finally {
      layer.dispose();
    }
  },
} satisfies EffectDefinition<ScreenFlashOptions>;
