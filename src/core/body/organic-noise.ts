/**
 * OrganicNoise — 非整数比の多重 sine 合成による有機的揺らぎ。
 *
 * 単一 sine の sway は周期がそのまま見えて機械的に映る。互いに非可約な
 * 周波数比（1 : φ : e）の sine を合成すると、波形が事実上繰り返さず
 * 「呼吸のような不規則さ」になる。乱数は位相にのみ使い、sample() は
 * 純関数（同じ t には同じ値）なので render loop から何度でも引ける。
 *
 * Pure data logic, no VRM dependency.
 */

// 黄金比 / 自然対数の底。整数比に縮約されない無理数の組で、
// 合成波の繰り返し周期を実用上無限に引き延ばす。
const FREQ_RATIOS = [1.0, 1.618033988749895, Math.E] as const;
const AMPLITUDES = [1.0, 0.55, 0.3] as const;
const AMPLITUDE_SUM = AMPLITUDES.reduce((a, b) => a + b, 0);

export class OrganicNoise {
  private readonly baseFrequency: number;
  private readonly phases: ReadonlyArray<number>;

  constructor(baseFrequency: number, random?: () => number) {
    const rng = random ?? Math.random;
    this.baseFrequency = baseFrequency;
    this.phases = FREQ_RATIOS.map(() => rng() * Math.PI * 2);
  }

  /** t（秒）における揺らぎ値 [-1, 1]。 */
  sample(t: number): number {
    let sum = 0;
    for (let i = 0; i < FREQ_RATIOS.length; i++) {
      sum += AMPLITUDES[i] * Math.sin(t * this.baseFrequency * FREQ_RATIOS[i] + this.phases[i]);
    }
    return sum / AMPLITUDE_SUM;
  }
}
