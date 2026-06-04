import { describe, expect, it } from "vitest";
import {
  buildRestoreRows,
  describeChange,
  formatSnapshotTime,
  recommendedRestoreSeq,
} from "./describe-snapshot";

const changeText = {
  changedOnePack: (id: string) => `「${id}」を変更`,
  changedManyPacks: (n: number) => `${n}個のpackを変更`,
  changedConfig: "設定を変更",
  changedInit: "init.js を変更",
  changedMixed: (n: number) => `${n}件の変更`,
  changeStartup: "起動した時",
  changeStartupError: "起動エラーが出た時",
  changeManual: "AIが記録",
  changeUnknown: "変更",
};

describe("formatSnapshotTime", () => {
  const now = new Date(2026, 5, 3, 12, 0, 0).getTime();

  it("formats just now", () => {
    expect(formatSnapshotTime(now, now, "ja-JP")).toBe("たった今");
    expect(formatSnapshotTime(now, now, "en-US")).toBe("just now");
  });

  it("formats minutes below one hour", () => {
    expect(formatSnapshotTime(now - 59 * 60_000, now, "ja-JP")).toBe("59分前");
    expect(formatSnapshotTime(now - 59 * 60_000, now, "en-US")).toBe("59 minutes ago");
  });

  it("formats hours below one day", () => {
    expect(formatSnapshotTime(now - 60 * 60_000, now, "ja-JP")).toBe("1時間前");
    expect(formatSnapshotTime(now - 60 * 60_000, now, "en-US")).toBe("1 hour ago");
  });

  it("formats yesterday once the age reaches 24 hours", () => {
    const yesterday = new Date(2026, 5, 2, 11, 30, 0).getTime();
    expect(formatSnapshotTime(yesterday, now, "ja-JP")).toBe("昨日 11:30");
  });

  it("formats older days as month/day and time", () => {
    const older = new Date(2026, 5, 1, 9, 5, 0).getTime();
    expect(formatSnapshotTime(older, now, "ja-JP")).toBe("6/1 09:05");
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
  it("one pack", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["my-theme"] },
        changeText,
      ),
    ).toBe("「my-theme」を変更");
  });

  it("config only", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["config.json"] },
        changeText,
      ),
    ).toBe("設定を変更");
  });

  it("init only", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["init.js"] },
        changeText,
      ),
    ).toBe("init.js を変更");
  });

  it("many packs", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["a", "b"] },
        changeText,
      ),
    ).toBe("2個のpackを変更");
  });

  it("mixed pack + config", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["a", "config.json"] },
        changeText,
      ),
    ).toBe("2件の変更");
  });

  it("baseline fallback when changed absent", () => {
    expect(describeChange({ seq: 1, ts_ms: 0, trigger: "startup-baseline" }, changeText)).toBe(
      "起動した時",
    );
  });

  it("startup error folds health into the text", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "startup-baseline", startup_clean: false },
        changeText,
      ),
    ).toBe("起動エラーが出た時");
  });

  it("startup clean is just the plain startup text", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "startup-baseline", startup_clean: true },
        changeText,
      ),
    ).toBe("起動した時");
  });

  it("startup unknown is just the plain startup text", () => {
    expect(describeChange({ seq: 1, ts_ms: 0, trigger: "startup-baseline" }, changeText)).toBe(
      "起動した時",
    );
  });

  it("mcp label fallback when changed absent", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "mcp:snapshot", label: "夜にする前" },
        changeText,
      ),
    ).toBe("夜にする前");
  });

  it("mcp manual fallback when label absent", () => {
    expect(describeChange({ seq: 1, ts_ms: 0, trigger: "mcp:snapshot" }, changeText)).toBe(
      "AIが記録",
    );
  });

  it("unknown fallback when changed and label absent", () => {
    expect(describeChange({ seq: 1, ts_ms: 0, trigger: "pre-restore" }, changeText)).toBe("変更");
  });
});

describe("buildRestoreRows", () => {
  const snaps = [
    { seq: 9, ts_ms: 120_000, trigger: "watcher-settled", changed: ["my-theme"] },
    { seq: 8, ts_ms: 60_000, trigger: "watcher-settled", changed: ["config.json"] },
    { seq: 7, ts_ms: 0, trigger: "startup-baseline", startup_clean: true },
  ];

  it("marks latest([0]) and recommends the one before it", () => {
    const rows = buildRestoreRows(snaps, 120_000, changeText, "ja-JP");
    expect(rows.map((r) => r.seq)).toEqual([9, 8, 7]);
    expect(rows[0].changeText).toBe("「my-theme」を変更");
    expect(rows[0].timeText).toBe("たった今");
    expect(rows[0].startupStatus).toBeNull();
    expect(rows[0].isLatest).toBe(true);
    expect(rows[0].isRecommended).toBe(false); // 最新（壊れている可能性）は既定にしない
    expect(rows[1].changeText).toBe("設定を変更");
    expect(rows[1].timeText).toBe("1分前");
    expect(rows[2].startupStatus).toBeNull();
    expect(rows[1].isLatest).toBe(false);
    expect(rows[1].isRecommended).toBe(true); // 1 つ前が推奨
  });

  it("maps startup_clean false to error status", () => {
    const rows = buildRestoreRows(
      [{ seq: 2, ts_ms: 0, trigger: "startup-baseline", startup_clean: false }],
      0,
      changeText,
      "ja-JP",
    );
    expect(rows[0].startupStatus).toBe("error");
  });

  it("limits to `limit` rows (default 5)", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      seq: 10 - i,
      ts_ms: 0,
      trigger: "x",
    }));
    expect(buildRestoreRows(many, 0, changeText, "ja-JP")).toHaveLength(5);
    expect(buildRestoreRows(many, 0, changeText, "ja-JP", 3)).toHaveLength(3);
  });

  it("empty → []", () => {
    expect(buildRestoreRows([], 0, changeText, "ja-JP")).toEqual([]);
  });
});
