/**
 * fireworks — 1 burst の花火 bundled Effect Pack。
 *
 * `ctx.renderer.drawOnCanvas` で overlay canvas を acquire し、particle array を
 * `requestAnimationFrame` loop で animate、`durationMs` 後に canvas を dispose する。
 *
 * 連発は呼び出し側（persona / init.js）が `injectEffect` を複数回刻む責務。
 * この pack は 1 origin からの 1 burst に集中する。
 *
 * ## 肌触り parameter（帰納的に調整する領域）
 *
 * gravity / drag / initial speed / maxLife / particle radius は `~/.charminal/init.js`
 * の生 DOM 実装で観測した値を起点にしている。CLAUDE.md の「感触 parameter は
 * 帰納的に」方針に従い、spec に固定値を書かず、観察→微調整の loop で固める。
 *
 * ## 色は random
 *
 * options に色 field は持たず、粒ごとに生成時 `Math.random()` で hue を決める。
 * 将来、呼び出し側が色を指定したくなったら `hue?` / `hueRange?` を
 * 非破壊追加する余地を残してある。
 */

import type { EffectContext, EffectDefinition, Vec2 } from "@charminal/sdk";

interface FireworksOptions {
  readonly origin: Vec2;
  readonly count: number;
  readonly durationMs: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  hue: number;
}

/** 肌触り parameter の既定値。実装中の観察で微調整可能。 */
const GRAVITY = 0.06;
const DRAG = 0.99;
const PARTICLE_RADIUS = 2;

export default {
  id: "fireworks",
  type: "effect",
  run: async (ctx: EffectContext<FireworksOptions>, options: FireworksOptions): Promise<void> => {
    const particles: Particle[] = [];
    let rafId: number | null = null;

    const handle = ctx.renderer.drawOnCanvas((g) => {
      // HiDPI 済み canvas から CSS pixel 寸法を逆算する。
      // drawOnCanvas 側で ctx.scale(dpr, dpr) 済みなので、transform の
      // スケール値 a = dpr。canvas.width は実 pixel、/ dpr で論理 pixel。
      // decision: docs/decisions/effect-rendering-primitives.md 「生 DOM を
      // pack に渡さない」— pack から window / document への直接アクセスは
      // 避け、RendererAPI 経由で得られる情報だけで完結させる。
      const dpr = g.getTransform().a || 1;
      const W = g.canvas.width / dpr;
      const H = g.canvas.height / dpr;
      const cx = options.origin.x * W;
      const cy = options.origin.y * H;

      // 全方向に emit。初期速度と hue は粒ごとに random。
      for (let i = 0; i < options.count; i++) {
        const angle = (i / options.count) * Math.PI * 2 + Math.random() * 0.08;
        const speed = 2.2 + Math.random() * 2.8;
        particles.push({
          x: cx,
          y: cy,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          life: 0,
          maxLife: 70 + Math.random() * 40,
          hue: Math.random() * 360,
        });
      }

      const tick = (): void => {
        if (ctx.signal.aborted) {
          rafId = null;
          return;
        }
        g.clearRect(0, 0, W, H);

        for (const p of particles) {
          p.x += p.vx;
          p.y += p.vy;
          p.vy += GRAVITY;
          p.vx *= DRAG;
          p.vy *= DRAG;
          p.life += 1;

          const t = 1 - p.life / p.maxLife;
          if (t <= 0) continue;
          g.beginPath();
          g.arc(p.x, p.y, PARTICLE_RADIUS, 0, Math.PI * 2);
          g.fillStyle = `hsla(${p.hue}, 90%, 62%, ${t})`;
          g.fill();
        }

        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
    });

    try {
      await ctx.time.after(options.durationMs);
    } finally {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      handle.dispose();
    }
  },
} satisfies EffectDefinition<FireworksOptions>;
