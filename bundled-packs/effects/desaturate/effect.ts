/**
 * desaturate — 画面全体を grayscale 化する bundled Effect Pack。
 *
 * `ctx.renderer.addCssFilter` で CSS grayscale filter を適用し、
 * `durationMs` 経過後に filter を dispose する。idle 時やエラー時に
 * 画面の彩度を落として「沈黙」「停滞」を視覚的に表現する用途。
 *
 * singleton: true — 2 回連続で呼ばれたら前の実行を abort して
 * 新しい dispatch だけが残る。abort 時は即座に filter を解除する。
 */

import type { EffectContext, EffectDefinition } from "@charminal/sdk";

interface DesaturateOptions {
  readonly durationMs: number;
  /** grayscale の強度。0（無効）〜 1（完全モノクロ）。省略時は 1。 */
  readonly intensity?: number;
}

export default {
  id: "desaturate",
  type: "effect",
  singleton: true,
  run: async (ctx: EffectContext<DesaturateOptions>, options: DesaturateOptions): Promise<void> => {
    const intensity = options.intensity ?? 1;
    const handle = ctx.renderer.addCssFilter(`grayscale(${intensity})`);

    // signal abort 時に即座に filter を解除する。
    // singleton: true なので、同 id の新規 dispatch で前の signal が abort される。
    // handle.dispose() は冪等なので finally と二重呼びになっても安全。
    const cleanup = () => {
      handle.dispose();
    };
    ctx.signal.addEventListener("abort", cleanup, { once: true });

    try {
      await ctx.time.after(options.durationMs);
    } finally {
      ctx.signal.removeEventListener("abort", cleanup);
      cleanup();
    }
  },
} satisfies EffectDefinition<DesaturateOptions>;
