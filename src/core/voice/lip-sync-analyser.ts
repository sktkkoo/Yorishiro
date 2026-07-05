import { clearMouthValues, copyMouthValues, MOUTH_KEYS, type MouthValues } from "./mouth-values";

// ---------------------------------------------------------------------------
// 定数
// ---------------------------------------------------------------------------

/** EMA 係数 (0 = 変化なし, 1 = 即追従) */
const SMOOTHING_ALPHA = 0.35;

/** volume がこれ以下なら無音扱い */
const SILENCE_THRESHOLD = 0.05;

/** 帯域バイト値合計がこれ以下ならフォルマント推定せず waveform 音量だけを使う */
const SPECTRUM_FORMANT_THRESHOLD = 240;

/** RMS → 0–1 正規化用 */
const SPECTRUM_VOLUME_SCALE = 120;

/** time-domain RMS → 0–1 正規化用 */
const TIME_DOMAIN_VOLUME_SCALE = 0.25;

/**
 * 各母音の理想 F1/F2 位置 (正規化 0–1)。
 *
 * 24 kHz / fftSize=256 → 128 bins, ~93.75 Hz/bin
 *
 * F1 推定域 (bins 2–12): ~190–1125 Hz
 *   あ = 高 F1 (~800 Hz), い/う = 低 F1 (~300 Hz), え/お = 中 F1 (~500 Hz)
 * F2 推定域 (bins 8–32): ~750–3000 Hz
 *   い = 高 F2 (~2300 Hz), え = 中高 F2 (~2000 Hz), あ/う = 中 F2, お = 低 F2 (~800 Hz)
 */
const VOWELS: ReadonlyArray<readonly [keyof MouthValues, number, number]> = [
  ["aa", 0.8, 0.3],
  ["ih", 0.1, 0.85],
  ["ou", 0.1, 0.25],
  ["ee", 0.4, 0.65],
  ["oh", 0.4, 0.15],
];

/** softmax 温度。大きいほど最近傍母音に集中する */
const SOFTMAX_TEMP = 8.0;

/** voice-relevant bins の上限 index */
const VOICE_BIN_START = 2;
const VOICE_BIN_END = 42;

/** F1 centroid bins */
const F1_START = 2;
const F1_END = 12;

/** F2 centroid bins */
const F2_START = 8;
const F2_END = 32;

// ---------------------------------------------------------------------------
// LipSyncAnalyser
// ---------------------------------------------------------------------------

/**
 * AnalyserNode の周波数データから F1/F2 フォルマントを推定し、
 * 5 母音の MouthValues を算出する。
 *
 * rAF ループは持たない。呼び出し側が任意のタイミングで sample() する。
 * Body / ExpressionManager への接続は caller の責務。
 */
export class LipSyncAnalyser {
  private readonly analyser: AnalyserNode;
  private readonly frequencyBins: Uint8Array;
  private readonly timeDomainBins: Uint8Array;
  private readonly smoothed: MouthValues = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  private readonly raw: MouthValues = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };

  constructor(analyser: AnalyserNode) {
    this.analyser = analyser;
    this.frequencyBins = new Uint8Array(analyser.frequencyBinCount);
    this.timeDomainBins = new Uint8Array(analyser.fftSize);
  }

  /**
   * AnalyserNode を既定値で作成して返すファクトリ。
   * source.connect(analyser) → analyser.connect(destination) は caller が行う。
   */
  static createAnalyserNode(ctx: BaseAudioContext): AnalyserNode {
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    return analyser;
  }

  /**
   * 現在の周波数データから MouthValues を算出する。
   * 毎フレーム呼ぶ想定。EMA smoothing 込み。
   */
  sample(out?: MouthValues): MouthValues {
    this.analyser.getByteFrequencyData(this.frequencyBins);
    this.analyser.getByteTimeDomainData(this.timeDomainBins);
    return this.computeFromBins(this.frequencyBins, this.timeDomainBins, out);
  }

  /** smoothing state をリセットする（音源切り替え時などに） */
  reset(): void {
    clearMouthValues(this.smoothed);
  }

  // ---------------------------------------------------------------------------
  // 内部
  // ---------------------------------------------------------------------------

  private computeFromBins(
    bins: Uint8Array,
    timeDomainBins: Uint8Array,
    out?: MouthValues,
  ): MouthValues {
    let bandTotal = 0;
    for (let i = VOICE_BIN_START; i <= VOICE_BIN_END; i++) bandTotal += bins[i];

    let timeSqSum = 0;
    for (const value of timeDomainBins) {
      const normalized = (value - 128) / 128;
      timeSqSum += normalized * normalized;
    }
    const timeRms = timeDomainBins.length > 0 ? Math.sqrt(timeSqSum / timeDomainBins.length) : 0;

    // Spectrum RMS + waveform RMS → volume
    let sqSum = 0;
    for (let i = VOICE_BIN_START; i <= VOICE_BIN_END; i++) sqSum += bins[i] * bins[i];
    const rms = Math.sqrt(sqSum / (VOICE_BIN_END - VOICE_BIN_START + 1));
    const spectrumVolume = Math.min(rms / SPECTRUM_VOLUME_SCALE, 1.0);
    const waveformVolume = Math.min(timeRms / TIME_DOMAIN_VOLUME_SCALE, 1.0);
    const volume = Math.max(spectrumVolume, waveformVolume);
    if (volume < SILENCE_THRESHOLD) {
      clearMouthValues(this.smoothed);
      return out ? clearMouthValues(out) : { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
    }

    // spectrum が弱い場合はフォルマント推定せず volume のみ
    if (bandTotal < SPECTRUM_FORMANT_THRESHOLD) {
      const raw = this.raw;
      raw.aa = volume;
      raw.ih = 0;
      raw.ou = 0;
      raw.ee = 0;
      raw.oh = 0;
      return this.smooth(raw, out);
    }

    // F1 energy centroid (190–1125 Hz)
    let f1w = 0;
    let f1e = 0;
    for (let i = F1_START; i <= F1_END; i++) {
      f1e += bins[i];
      f1w += bins[i] * i;
    }
    const f1 = f1e > 0 ? (f1w / f1e - F1_START) / (F1_END - F1_START) : 0.5;

    // F2 energy centroid (750–3000 Hz)
    let f2w = 0;
    let f2e = 0;
    for (let i = F2_START; i <= F2_END; i++) {
      f2e += bins[i];
      f2w += bins[i] * i;
    }
    const f2 = f2e > 0 ? (f2w / f2e - F2_START) / (F2_END - F2_START) : 0.5;

    // 距離ベース softmax で母音重み算出
    const raw = this.raw;
    clearMouthValues(raw);
    let wTotal = 0;
    for (const [key, tf1, tf2] of VOWELS) {
      const dist = Math.sqrt((f1 - tf1) ** 2 + (f2 - tf2) ** 2);
      const w = Math.exp(-dist * SOFTMAX_TEMP);
      raw[key] = w;
      wTotal += w;
    }

    // 正規化 → volume でスケール
    for (const k of MOUTH_KEYS) {
      raw[k] = (raw[k] / wTotal) * volume;
    }

    return this.smooth(raw, out);
  }

  private smooth(raw: MouthValues, out?: MouthValues): MouthValues {
    const s = this.smoothed;
    for (const k of MOUTH_KEYS) {
      s[k] = s[k] * (1 - SMOOTHING_ALPHA) + raw[k] * SMOOTHING_ALPHA;
    }
    return out ? copyMouthValues(s, out) : { ...s };
  }
}
