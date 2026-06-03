import { describe, expect, it } from "vitest";
import { describeChange, describeSnapshot, recommendedRestoreSeq } from "./describe-snapshot";

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

describe("describeChange", () => {
  const s = {
    changedOnePack: (id: string) => `「${id}」を変更`,
    changedManyPacks: (n: number) => `${n}個のpackを変更`,
    changedConfig: "設定を変更",
    changedInit: "init.js を変更",
    changedMixed: (n: number) => `${n}個の変更`,
    changeStartup: "起動時",
    changeManual: "AIが記録",
    changeUnknown: "変更",
  };

  it("one pack", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["my-theme"] }, s),
    ).toBe("「my-theme」を変更");
  });

  it("config only", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["config.json"] }, s),
    ).toBe("設定を変更");
  });

  it("many packs", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["a", "b"] }, s),
    ).toBe("2個のpackを変更");
  });

  it("mixed pack + config", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["a", "config.json"] },
        s,
      ),
    ).toBe("2個の変更");
  });

  it("baseline fallback when changed absent", () => {
    expect(describeChange({ seq: 1, ts_ms: 0, trigger: "startup-baseline" }, s)).toBe("起動時");
  });

  it("mcp label fallback when changed absent", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "mcp:snapshot", label: "夜にする前" }, s),
    ).toBe("夜にする前");
  });
});
