/**
 * fireworks-volley — 複数発の花火を時差で打ち上げる bundled Effect Pack。
 *
 * `fireworks` pack が「1 burst 専任」の境界を持っているので、連発 / 位置
 * 散らし / 発射間隔 jitter は別 pack として切り出してある（philosophy:
 * feedback_separate_conceptually_distinct_systems — 動き方が違うものは統合
 * しない）。内部では `fireworks` pack.run を複数回呼び、signal / renderer /
 * time / audio は volley pack の ctx を share する。
 *
 * ## 使い所
 *
 * init.js の keyboard shortcut や persona の「祝う」reflex で「華やかに数発
 * 連続で上げたい」場合に使う。1 発だけで良いなら `fireworks` を直接叩く。
 *
 * ## 肌触り parameter（すべて optional、default は init.js template と同じ）
 *
 * - `count`             : 打ち上げ本数（default 3）
 * - `originRange`       : 発射位置の random 範囲、正規化座標（default 画面内 sane）
 * - `delayStepMs`       : 発射間隔の base（default 280）
 * - `delayJitterMs`     : 発射間隔の jitter ±（default 120）
 * - `burstCount`        : 各発の粒数（fireworks pack の count、default 50）
 * - `burstDurationMs`   : 各発の durationMs（default 2400）
 */

import type { EffectContext, EffectDefinition, Vec2 } from "@charminal/sdk";
import fireworks from "../fireworks/effect";

interface FireworksVolleyOptions {
  readonly count?: number;
  readonly originRange?: { x: [number, number]; y: [number, number] };
  readonly delayStepMs?: number;
  readonly delayJitterMs?: number;
  readonly burstCount?: number;
  readonly burstDurationMs?: number;
}

interface FireworksOptions {
  readonly origin: Vec2;
  readonly count: number;
  readonly durationMs: number;
}

/** default 値。連発 demo として心地よい値（init.js template の初期値と揃える）。 */
const DEFAULTS = {
  count: 3,
  originRange: {
    x: [0.15, 0.85] as [number, number],
    y: [0.2, 0.45] as [number, number],
  },
  delayStepMs: 280,
  delayJitterMs: 120,
  burstCount: 50,
  burstDurationMs: 2400,
} as const;

const randomInRange = (min: number, max: number): number => min + Math.random() * (max - min);

export default {
  id: "fireworks-volley",
  type: "effect",
  run: async (
    ctx: EffectContext<FireworksVolleyOptions>,
    options: FireworksVolleyOptions,
  ): Promise<void> => {
    const count = options.count ?? DEFAULTS.count;
    const originRange = options.originRange ?? DEFAULTS.originRange;
    const delayStepMs = options.delayStepMs ?? DEFAULTS.delayStepMs;
    const delayJitterMs = options.delayJitterMs ?? DEFAULTS.delayJitterMs;
    const burstCount = options.burstCount ?? DEFAULTS.burstCount;
    const burstDurationMs = options.burstDurationMs ?? DEFAULTS.burstDurationMs;

    const bursts: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      const origin: Vec2 = {
        x: randomInRange(originRange.x[0], originRange.x[1]),
        y: randomInRange(originRange.y[0], originRange.y[1]),
      };
      const delay = Math.max(0, i * delayStepMs + (Math.random() * 2 - 1) * delayJitterMs);

      const burstPromise = ctx.time.after(delay).then(() => {
        if (ctx.signal.aborted) return;
        const fireworksOptions: FireworksOptions = {
          origin,
          count: burstCount,
          durationMs: burstDurationMs,
        };
        const subCtx: EffectContext<FireworksOptions> = {
          options: fireworksOptions,
          time: ctx.time,
          signal: ctx.signal,
          renderer: ctx.renderer,
          audio: ctx.audio,
        };
        return fireworks.run(subCtx, fireworksOptions);
      });
      bursts.push(burstPromise);
    }

    // 全 burst の自然終了を待つ。途中 abort されれば各 burst 側の signal 確認
    // で早期 return する（fireworks pack が signal を見て止まる）。
    await Promise.all(bursts);
  },
} satisfies EffectDefinition<FireworksVolleyOptions>;
