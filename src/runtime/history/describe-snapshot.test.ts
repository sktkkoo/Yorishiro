import { describe, expect, it } from "vitest";
import {
  buildRestoreRows,
  describeChange,
  describeSnapshot,
  recommendedRestoreSeq,
} from "./describe-snapshot";

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

  it("returns null when there is no earlier snapshot (length <= 1)", () => {
    expect(recommendedRestoreSeq([{ seq: 7, ts_ms: 0, trigger: "startup-baseline" }])).toBeNull();
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

  it("init only", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["init.js"] }, s),
    ).toBe("init.js を変更");
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

  it("mcp manual fallback when label absent", () => {
    expect(describeChange({ seq: 1, ts_ms: 0, trigger: "mcp:snapshot" }, s)).toBe("AIが記録");
  });

  it("unknown fallback when changed and label absent", () => {
    expect(describeChange({ seq: 1, ts_ms: 0, trigger: "pre-restore" }, s)).toBe("変更");
  });
});

describe("buildRestoreRows", () => {
  const snaps = [
    { seq: 9, ts_ms: 0, trigger: "watcher-settled" },
    { seq: 8, ts_ms: 0, trigger: "watcher-settled" },
    { seq: 7, ts_ms: 0, trigger: "startup-baseline", startup_clean: true },
  ];

  it("marks latest([0]) and recommends the one before it", () => {
    const rows = buildRestoreRows(snaps, 0);
    expect(rows.map((r) => r.seq)).toEqual([9, 8, 7]);
    expect(rows[0].isLatest).toBe(true);
    expect(rows[0].isRecommended).toBe(false); // 最新（壊れている可能性）は既定にしない
    expect(rows[1].isLatest).toBe(false);
    expect(rows[1].isRecommended).toBe(true); // 1 つ前が推奨
    expect(rows[0].text).toContain("#9"); // describeSnapshot の整形 text
  });

  it("limits to `limit` rows (default 5)", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      seq: 10 - i,
      ts_ms: 0,
      trigger: "x",
    }));
    expect(buildRestoreRows(many, 0)).toHaveLength(5);
    expect(buildRestoreRows(many, 0, 3)).toHaveLength(3);
  });

  it("empty → []", () => {
    expect(buildRestoreRows([], 0)).toEqual([]);
  });
});
