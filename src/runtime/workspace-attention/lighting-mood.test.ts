import { describe, expect, it } from "vitest";
import { lightingMoodFromAggregate, NEUTRAL_LIGHTING_MOOD } from "./lighting-mood";
import type { WorkspaceAttentionAggregate } from "./types";

/**
 * aggregate → lighting mood の純関数を固定する test。
 *
 * 照明は「天気」: aggregate（mood/severity の集約）だけを読み、item 列は読まない。
 * subtle・slow・aggregate-only の方針に従い、出力は scene が baseline に対して
 * どう傾けるかを表す相対 modifier（0..1 の正規化値）に留める。実際の色・強度の
 * 数値は scene が所有する（scene ownership を壊さない）。
 */

function makeAggregate(
  patch: Partial<WorkspaceAttentionAggregate> = {},
): WorkspaceAttentionAggregate {
  return {
    kind: "workspace-attention-aggregate",
    mood: "calm",
    severity: "none",
    activeCount: 0,
    updatedAt: 0,
    producer: { kind: "host", id: "test" },
    ...patch,
  };
}

describe("lightingMoodFromAggregate", () => {
  it("calm（item なし）は neutral baseline をそのまま返す", () => {
    const mood = lightingMoodFromAggregate(makeAggregate({ mood: "calm", severity: "none" }));
    // calm は default 不変の baseline。scene の見た目を一切歪めない契約。
    expect(mood).toEqual(NEUTRAL_LIGHTING_MOOD);
    expect(mood.tone).toBe("calm");
  });

  it("working（実行中あり）は安定した稼働で、baseline からほぼ動かない", () => {
    const mood = lightingMoodFromAggregate(
      makeAggregate({ mood: "working", severity: "low", activeCount: 1 }),
    );
    expect(mood.tone).toBe("working");
    // 「安定稼働」: 周辺視で気づくほどは動かさない。warmth/brightness は baseline 近傍。
    expect(mood.warmth).toBeCloseTo(NEUTRAL_LIGHTING_MOOD.warmth, 1);
    expect(mood.brightness).toBeCloseTo(NEUTRAL_LIGHTING_MOOD.brightness, 1);
  });

  it("waiting（承認/人間待ち）はわずかに明るく", () => {
    const mood = lightingMoodFromAggregate(
      makeAggregate({ mood: "waiting", severity: "medium", activeCount: 1 }),
    );
    expect(mood.tone).toBe("waiting");
    expect(mood.brightness).toBeGreaterThan(NEUTRAL_LIGHTING_MOOD.brightness);
  });

  it("failed（失敗あり）は少し暗く・冷たく", () => {
    const mood = lightingMoodFromAggregate(
      makeAggregate({ mood: "failed", severity: "high", activeCount: 2 }),
    );
    expect(mood.tone).toBe("failed");
    expect(mood.brightness).toBeLessThan(NEUTRAL_LIGHTING_MOOD.brightness);
    expect(mood.warmth).toBeLessThan(NEUTRAL_LIGHTING_MOOD.warmth);
  });

  it("waiting は failed より暖かく明るい（状態間の順序を固定）", () => {
    const waiting = lightingMoodFromAggregate(makeAggregate({ mood: "waiting" }));
    const failed = lightingMoodFromAggregate(makeAggregate({ mood: "failed" }));
    expect(waiting.warmth).toBeGreaterThan(failed.warmth);
    expect(waiting.brightness).toBeGreaterThan(failed.brightness);
  });

  it("全 modifier は正規化レンジ [0,1] に収まる", () => {
    for (const m of ["calm", "working", "waiting", "failed"] as const) {
      const mood = lightingMoodFromAggregate(makeAggregate({ mood: m }));
      expect(mood.warmth).toBeGreaterThanOrEqual(0);
      expect(mood.warmth).toBeLessThanOrEqual(1);
      expect(mood.brightness).toBeGreaterThanOrEqual(0);
      expect(mood.brightness).toBeLessThanOrEqual(1);
    }
  });

  it("同じ aggregate mood なら severity が変わっても tone は同一（aggregate-only / 列依存なし）", () => {
    const low = lightingMoodFromAggregate(makeAggregate({ mood: "failed", severity: "low" }));
    const high = lightingMoodFromAggregate(makeAggregate({ mood: "failed", severity: "high" }));
    expect(low.tone).toBe(high.tone);
  });
});
