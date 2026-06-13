/**
 * screen-shake — 画面全体（terminal + character canvas）を短く揺らす
 * built-in Effect Pack。
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
    ctx: EffectContext<Partial<ScreenShakeOptions>>,
    options: Partial<ScreenShakeOptions>,
  ): Promise<void> => {
    const intensity = options.intensity ?? 1;
    const durationMs = options.durationMs ?? 300;
    const filter = ctx.renderer.addShakeFilter(intensity);
    try {
      await ctx.time.after(durationMs);
    } finally {
      filter.dispose();
    }
  },
} satisfies EffectDefinition<ScreenShakeOptions>;
