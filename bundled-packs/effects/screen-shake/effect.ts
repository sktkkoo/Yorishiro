/**
 * screen-shake — 画面全体（terminal + character canvas）を短く揺らす
 * built-in Effect Pack。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「Charm ということ」— 「物理の
 * 約束事を一瞬だけ破る」の最小例として、body の transform で universe を
 * 揺さぶる。
 *
 * 実装は ctx.renderer.addShakeFilter のみ使う薄い wrapper。decay profile
 * は Renderer 実装が持ち、pack は lifetime を time.after で管理する。
 */

import type { EffectContext, EffectDefinition } from "@charminal/sdk";

interface ScreenShakeOptions {
  readonly intensity: number;
  readonly durationMs: number;
}

export default {
  id: "screen-shake",
  type: "effect",
  run: async (
    ctx: EffectContext<ScreenShakeOptions>,
    options: ScreenShakeOptions,
  ): Promise<void> => {
    const filter = ctx.renderer.addShakeFilter(options.intensity);
    try {
      await ctx.time.after(options.durationMs);
    } finally {
      filter.dispose();
    }
  },
} satisfies EffectDefinition<ScreenShakeOptions>;
