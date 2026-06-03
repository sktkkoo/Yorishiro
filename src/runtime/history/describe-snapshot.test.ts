import { describe, expect, it } from "vitest";
import { describeSnapshot, recommendedRestoreSeq } from "./describe-snapshot";

describe("describeSnapshot", () => {
  const now = 600_000; // 10 分（ms）

  it("formats seq, trigger, and age", () => {
    expect(describeSnapshot({ seq: 5, ts_ms: 600_000, trigger: "watcher-settled" }, now)).toBe(
      "#5 watcher-settled · たった今",
    );
  });

  it("shows minutes and label", () => {
    expect(
      describeSnapshot({ seq: 3, ts_ms: 0, trigger: "startup-baseline", label: "good" }, now),
    ).toBe('#3 startup-baseline "good" · 10分前');
  });

  it("shows startup_clean badge", () => {
    expect(
      describeSnapshot(
        { seq: 2, ts_ms: 600_000, trigger: "startup-baseline", startup_clean: true },
        now,
      ),
    ).toContain("✓起動clean");
    expect(
      describeSnapshot(
        { seq: 1, ts_ms: 600_000, trigger: "startup-baseline", startup_clean: false },
        now,
      ),
    ).toContain("⚠起動エラーあり");
  });
});

describe("recommendedRestoreSeq", () => {
  it("returns null for empty", () => {
    expect(recommendedRestoreSeq([])).toBeNull();
  });

  it("returns the only snapshot when length 1", () => {
    expect(recommendedRestoreSeq([{ seq: 7, ts_ms: 0, trigger: "startup-baseline" }])).toBe(7);
  });

  it("skips the possibly-broken latest and returns the second-newest", () => {
    expect(
      recommendedRestoreSeq([
        { seq: 9, ts_ms: 0, trigger: "watcher-settled" },
        { seq: 8, ts_ms: 0, trigger: "watcher-settled" },
        { seq: 7, ts_ms: 0, trigger: "startup-baseline" },
      ]),
    ).toBe(8);
  });
});
