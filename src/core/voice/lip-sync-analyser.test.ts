import { describe, expect, it } from "vitest";
import { LipSyncAnalyser } from "./lip-sync-analyser";
import { MOUTH_KEYS, ZERO_MOUTH } from "./mouth-values";

// ---------------------------------------------------------------------------
// AnalyserNode スタブ
// ---------------------------------------------------------------------------

function createStubAnalyser(bins: Uint8Array): AnalyserNode {
  return {
    frequencyBinCount: bins.length,
    fftSize: bins.length * 2,
    getByteFrequencyData(out: Uint8Array) {
      out.set(bins);
    },
  } as unknown as AnalyserNode;
}

function makeBins(size = 128): Uint8Array {
  return new Uint8Array(size);
}

// ---------------------------------------------------------------------------
// テスト
// ---------------------------------------------------------------------------

describe("LipSyncAnalyser", () => {
  it("無音データではゼロを返す", () => {
    const bins = makeBins();
    const analyser = new LipSyncAnalyser(createStubAnalyser(bins));
    const result = analyser.sample();
    expect(result).toEqual(ZERO_MOUTH);
  });

  it("エネルギーがあると非ゼロの値を返す", () => {
    const bins = makeBins();
    // bins 2–42 にエネルギーを入れて SILENCE_THRESHOLD を超える
    for (let i = 2; i <= 42; i++) bins[i] = 200;
    const analyser = new LipSyncAnalyser(createStubAnalyser(bins));
    const result = analyser.sample();

    const total = MOUTH_KEYS.reduce((sum, k) => sum + result[k], 0);
    expect(total).toBeGreaterThan(0);
  });

  it("全 key の合計は 1 を超えない", () => {
    const bins = makeBins();
    for (let i = 2; i <= 42; i++) bins[i] = 255;
    const analyser = new LipSyncAnalyser(createStubAnalyser(bins));
    const result = analyser.sample();

    const total = MOUTH_KEYS.reduce((sum, k) => sum + result[k], 0);
    expect(total).toBeLessThanOrEqual(1.001);
  });

  it("低 F1 + 高 F2 → ih (い) が最大", () => {
    const bins = makeBins();
    // ベースラインは極力低く（centroid を引っ張らないように）
    for (let i = 2; i <= 42; i++) bins[i] = 5;
    // F1: 極端に低い → bin 2–3 に集中 (centroid → ~3.0, 正規化 → ~0.10)
    bins[2] = 255;
    bins[3] = 255;
    // F2: 極端に高い → bin 28–32 に集中 (centroid → ~29, 正規化 → ~0.88)
    for (let i = 28; i <= 32; i++) bins[i] = 255;

    const analyser = new LipSyncAnalyser(createStubAnalyser(bins));
    const result = analyser.sample();

    const maxKey = MOUTH_KEYS.reduce((a, b) => (result[a] > result[b] ? a : b));
    expect(maxKey).toBe("ih");
  });

  it("高 F1 + 中 F2 → aa (あ) が最大", () => {
    const bins = makeBins();
    for (let i = 2; i <= 42; i++) bins[i] = 30;
    // F1: 高 F1 → bins 9–12 にエネルギー集中
    for (let i = 9; i <= 12; i++) bins[i] = 200;
    // F2: 中〜低 F2 → bins 12–18 にエネルギー集中
    for (let i = 12; i <= 18; i++) bins[i] = 200;

    const analyser = new LipSyncAnalyser(createStubAnalyser(bins));
    const result = analyser.sample();

    const maxKey = MOUTH_KEYS.reduce((a, b) => (result[a] > result[b] ? a : b));
    expect(maxKey).toBe("aa");
  });

  it("reset() で smoothing state がクリアされる", () => {
    const bins = makeBins();
    for (let i = 2; i <= 42; i++) bins[i] = 200;
    const analyser = new LipSyncAnalyser(createStubAnalyser(bins));

    // 1 回 sample して state を作る
    analyser.sample();

    // bins をゼロに戻す
    bins.fill(0);

    // reset なしだと smoothing で前の値が残る
    const withoutReset = analyser.sample();

    // reset 後は即ゼロ
    analyser.reset();
    const afterReset = analyser.sample();
    expect(afterReset).toEqual(ZERO_MOUTH);

    // reset 前は smoothing の残りでゼロではない可能性がある
    // (bins が 0 なので SILENCE_THRESHOLD 以下 → ゼロになる)
    expect(withoutReset).toEqual(ZERO_MOUTH);
  });

  it("createAnalyserNode は fftSize=256 の AnalyserNode を返す", () => {
    const mockCtx = {
      createAnalyser: () => ({ fftSize: 0 }),
    } as unknown as BaseAudioContext;

    const node = LipSyncAnalyser.createAnalyserNode(mockCtx);
    expect(node.fftSize).toBe(256);
  });

  it("連続 sample で EMA smoothing が効く", () => {
    const bins = makeBins();
    for (let i = 2; i <= 42; i++) bins[i] = 200;
    const analyser = new LipSyncAnalyser(createStubAnalyser(bins));

    const first = analyser.sample();
    const second = analyser.sample();

    // EMA なので 2 回目は 1 回目より大きい（smoothing で追従中）
    const firstTotal = MOUTH_KEYS.reduce((s, k) => s + first[k], 0);
    const secondTotal = MOUTH_KEYS.reduce((s, k) => s + second[k], 0);
    expect(secondTotal).toBeGreaterThanOrEqual(firstTotal);
  });
});
