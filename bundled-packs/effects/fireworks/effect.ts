/**
 * fireworks — 1 発の花火 bundled Effect Pack（rise → burst の 2 段階）。
 *
 * `ctx.renderer.drawOnCanvas` で overlay canvas を acquire し、以下 2 phase を
 * `requestAnimationFrame` loop で animate、`durationMs` 後に canvas を dispose する：
 *
 * 1. **rise**: 画面下から origin へ rocket が上昇（ease-out で減速しながら apex へ）。
 *    trail（過去 N 位置）を薄く引いて動きを見せる
 * 2. **burst**: apex に到達した時点で particles を全方向に emit、gravity / drag /
 *    lifetime で落下しながら fade
 *
 * 連発は呼び出し側（persona / init.js）が `injectEffect` を複数回刻む責務。
 * この pack は 1 origin からの 1 発に集中する。
 *
 * ## 肌触り parameter（帰納的に調整する領域）
 *
 * RISE_MS / START_Y_OFFSET / TRAIL_LEN / gravity / drag / speed / maxLife / radius
 * は spec に固定せず、観察→微調整の loop で固める（CLAUDE.md「感触 parameter は
 * 帰納的に」）。
 *
 * ## 色は coherent family
 *
 * 1 発ごとに base hue を random で決め、rocket と burst 粒はその ±15° の幅で
 * 揺らぐ。真っ赤な花火 / 真っ青な花火のような「1 色家族」感が出る。options に
 * 色 field は持たないが、将来 `hue?` / `hueRange?` を非破壊追加する余地は残す。
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

interface TrailPoint {
  x: number;
  y: number;
}

/** 肌触り parameter の既定値。実装中の観察で微調整可能。 */
const GRAVITY = 0.06;
const DRAG = 0.99;
const PARTICLE_RADIUS = 2;
/** rise phase の所要時間（ms）。画面下から apex まで。 */
const RISE_MS = 550;
/** rocket の start 位置を origin y から画面下へどれだけ外すか（px）。 */
const START_Y_OFFSET = 30;
/** rocket trail の保持フレーム数。古いほど薄くなる。 */
const TRAIL_LEN = 10;
/** rocket head の半径（px）。particle より少し太め。 */
const ROCKET_RADIUS = 2.5;
/** burst 粒 hue の family 幅（±この値を base hue にオフセット）。 */
const HUE_JITTER = 15;

/** ease-out cubic: t=0→0, t=1→1、終端で滑らかに減速する。 */
const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

export default {
  id: "fireworks",
  type: "effect",
  run: async (ctx: EffectContext<FireworksOptions>, options: FireworksOptions): Promise<void> => {
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
      const targetX = options.origin.x * W;
      const targetY = options.origin.y * H;
      const startY = H + START_Y_OFFSET;

      // 1 発ごとに base hue を決める（rocket と burst 粒で共有）。
      const baseHue = Math.random() * 360;

      const trail: TrailPoint[] = [];
      const particles: Particle[] = [];
      let burstStarted = false;
      const startTime = performance.now();

      const spawnBurst = (): void => {
        for (let i = 0; i < options.count; i++) {
          const angle = (i / options.count) * Math.PI * 2 + Math.random() * 0.08;
          const speed = 2.2 + Math.random() * 2.8;
          particles.push({
            x: targetX,
            y: targetY,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 0,
            maxLife: 70 + Math.random() * 40,
            hue: baseHue + (Math.random() * 2 - 1) * HUE_JITTER,
          });
        }
      };

      const drawRise = (elapsed: number): void => {
        const t = Math.min(1, elapsed / RISE_MS);
        const ry = startY + (targetY - startY) * easeOutCubic(t);

        // trail を最新位置で更新。古いほど薄く描く。
        trail.push({ x: targetX, y: ry });
        if (trail.length > TRAIL_LEN) trail.shift();
        for (let i = 0; i < trail.length; i++) {
          const alpha = ((i + 1) / trail.length) * 0.6;
          const tp = trail[i];
          if (tp === undefined) continue;
          g.beginPath();
          g.arc(tp.x, tp.y, PARTICLE_RADIUS, 0, Math.PI * 2);
          g.fillStyle = `hsla(${baseHue}, 90%, 70%, ${alpha})`;
          g.fill();
        }

        // rocket head（trail の先端、最も明るく）。
        g.beginPath();
        g.arc(targetX, ry, ROCKET_RADIUS, 0, Math.PI * 2);
        g.fillStyle = `hsla(${baseHue}, 100%, 82%, 1)`;
        g.fill();
      };

      const drawBurst = (): void => {
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
      };

      const tick = (): void => {
        if (ctx.signal.aborted) {
          rafId = null;
          return;
        }
        g.clearRect(0, 0, W, H);

        const elapsed = performance.now() - startTime;
        if (elapsed < RISE_MS) {
          drawRise(elapsed);
        } else {
          if (!burstStarted) {
            spawnBurst();
            burstStarted = true;
          }
          drawBurst();
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
