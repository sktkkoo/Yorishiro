/**
 * fireworks — 1 発の花火 bundled Effect Pack（rise → burst の 2 段階）。
 *
 * `ctx.renderer.drawOnCanvas` で overlay canvas を acquire し、以下 2 phase を
 * `requestAnimationFrame` loop で animate、`max(durationMs, MIN_EFFECT_MS)`
 * 経過後に canvas を dispose する。`durationMs` が短すぎて burst が途中で
 * 切れないよう、pack 側で natural 終了時間を保証する：
 *
 * 1. **rise**: 画面下から origin へ rocket が左右に揺れながら上昇。
 *    `sin × cos(t·π/2)` で apex では wobble 0 に収束、direction と phase は
 *    1 発ごとに random。rise 時間自体にも ±50ms の jitter が入る
 * 2. **burst**: apex に到達した時点で particles を全方向に emit、gravity / drag /
 *    lifetime で落下しながら fade
 *
 * ## 尾引き（motion trail）
 *
 * 毎フレーム canvas を `clearRect` で消すのではなく、
 * `globalCompositeOperation = "destination-out"` で微弱に fade（既存 alpha を
 * `1 - FADE_ALPHA` 倍に減衰）する。結果、rocket の軌道と burst 粒の動きが
 * 自然な motion blur として尾を引く。
 *
 * ## 色は coherent family
 *
 * 1 発ごとに base hue を random で決め、rocket と burst 粒はその ±15° の幅で
 * 揺らぐ。真っ赤な花火 / 真っ青な花火のような「1 色家族」感。
 *
 * ## 肌触り parameter（帰納的に調整する領域）
 *
 * RISE_MS / WOBBLE_* / FADE_ALPHA / GRAVITY / DRAG / speed / maxLife / radius
 * は spec に固定せず、観察→微調整の loop で固める（CLAUDE.md「感触 parameter
 * は帰納的に」）。
 *
 * 連発は呼び出し側（persona / init.js）が `injectEffect` を複数回刻む責務。
 * この pack は 1 origin からの 1 発に集中する。
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
const GRAVITY = 0.05;
const DRAG = 0.985;
const PARTICLE_RADIUS = 2;
/** rocket head の半径（px）。burst 粒より太め。 */
const ROCKET_RADIUS = 3;
/** rise phase の基準所要時間（ms）。実際は ±RISE_JITTER_MS 揺らぐ。 */
const RISE_MS = 2000;
const RISE_JITTER_MS = 100;
/** burst 後の粒が自然に fade しきるまでの buffer（ms）。maxLife 上限 ≈ 130 frame
 *  ≈ 60fps で 2167ms、余裕を見て 2500ms。呼び出し側の durationMs が短くても
 *  pack 側でこの時間まで canvas を保つ。 */
const BURST_FADE_TAIL_MS = 2500;
/** 1 発が natural に演じ終わるまでの最低所要時間。options.durationMs がこれを
 *  下回る場合、pack が延長して burst が途中で切れないようにする。 */
const MIN_EFFECT_MS = RISE_MS + RISE_JITTER_MS + BURST_FADE_TAIL_MS;
/** rocket の start 位置を origin y から画面下へどれだけ外すか（px）。 */
const START_Y_OFFSET = 30;
/** rise 中の左右揺らぎのサイクル数（片道で何回振る）。少ないほど 1 sway が大きく見える。 */
const WOBBLE_CYCLES = 5;
/** 左右揺らぎの最大振幅（px）、t=0 で最大、apex で 0 に収束。 */
const WOBBLE_AMPLITUDE = 6;
/** 毎フレーム既存描画を減衰させる割合。大きいほど trail が短い。 */
const FADE_ALPHA = 0.12;
/** burst 粒 hue の family 幅（±この値を base hue にオフセット）。 */
const HUE_JITTER = 15;

/**
 * ease-out quad: 1 - (1-t)² = 2t - t²。
 * 一定重力下の投射運動（初速で打ち上げ、重力で減速、apex で v=0）の
 * y 成分と完全一致する curve。`easeOutCubic` は v0 が 3×avg で stop が
 * 急すぎて「物理的に不自然」に見える — quad は v0=2×avg で自然な減速。
 */
const easeOutQuad = (t: number): number => 1 - (1 - t) ** 2;

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

      // 1 発ごとの色と動きの揺らぎ。
      const baseHue = Math.random() * 360;
      const wobbleDir = Math.random() < 0.5 ? 1 : -1;
      const actualRiseMs = RISE_MS + (Math.random() * 2 - 1) * RISE_JITTER_MS;

      const particles: Particle[] = [];
      let burstStarted = false;
      const startTime = performance.now();
      // 前フレームの rocket 位置。streak（線分）で尾を引くために保持する。
      // 初回 frame は prev === current なので線は描画されない。
      let prevRx = targetX;
      let prevRy = startY;

      const spawnBurst = (): void => {
        for (let i = 0; i < options.count; i++) {
          const angle = (i / options.count) * Math.PI * 2 + Math.random() * 0.08;
          const speed = 2.0 + Math.random() * 2.6;
          particles.push({
            x: targetX,
            y: targetY,
            vx: Math.cos(angle) * speed,
            vy: Math.sin(angle) * speed,
            life: 0,
            maxLife: 80 + Math.random() * 50,
            hue: baseHue + (Math.random() * 2 - 1) * HUE_JITTER,
          });
        }
      };

      /** 既存描画を一定割合だけ透明化。clearRect の代わりに使うと trail になる。 */
      const fadeCanvas = (): void => {
        g.globalCompositeOperation = "destination-out";
        g.fillStyle = `rgba(0,0,0,${FADE_ALPHA})`;
        g.fillRect(0, 0, W, H);
        g.globalCompositeOperation = "source-over";
      };

      const drawRise = (elapsed: number): void => {
        const t = Math.min(1, elapsed / actualRiseMs);
        const ry = startY + (targetY - startY) * easeOutQuad(t);
        // wobble: sin で左右に振り、apex（t=1）へ向けて cos(t·π/2) で 0 に収束。
        const wobble =
          wobbleDir *
          Math.sin(t * Math.PI * 2 * WOBBLE_CYCLES) *
          WOBBLE_AMPLITUDE *
          Math.cos((t * Math.PI) / 2);
        const rx = targetX + wobble;

        // prev → current の線分で streak を描く。fade-based 残像と
        // 組み合わさって、揺れながら登る軌跡が光の尾として残る。
        g.beginPath();
        g.moveTo(prevRx, prevRy);
        g.lineTo(rx, ry);
        g.strokeStyle = `hsla(${baseHue}, 95%, 78%, 0.92)`;
        g.lineWidth = ROCKET_RADIUS * 0.85;
        g.lineCap = "round";
        g.stroke();

        // rocket head（熱源の core）。streak より彩度 / 明度を高く。
        g.beginPath();
        g.arc(rx, ry, ROCKET_RADIUS, 0, Math.PI * 2);
        g.fillStyle = `hsla(${baseHue}, 100%, 86%, 1)`;
        g.fill();

        prevRx = rx;
        prevRy = ry;
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
        fadeCanvas();

        const elapsed = performance.now() - startTime;
        if (elapsed < actualRiseMs) {
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
      // durationMs は「呼び出し側が canvas を保持したい最低時間」の hint。
      // rise + burst fade の自然終了時間を下回る場合は pack 側で延長する
      // （burst が途中で切れないように）。
      await ctx.time.after(Math.max(options.durationMs, MIN_EFFECT_MS));
    } finally {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      handle.dispose();
    }
  },
} satisfies EffectDefinition<FireworksOptions>;
