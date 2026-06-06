import { describe, expect, it } from "vitest";
import {
  buildRestoreRows,
  type ChangeStrings,
  describeChange,
  formatSnapshotTime,
  parseRestoreLabel,
  recommendedRestoreSeq,
} from "./describe-snapshot";

const changeText: ChangeStrings = {
  changedOnePack: (id: string) => `「${id}」を変更`,
  changedManyPacks: (n: number) => `${n}個の変更`,
  changedManyPacksNamed: (names: readonly string[]) => {
    if (names.length <= 2) return names.map((n) => `「${n}」を変更`).join("、");
    return `「${names[0]}」ほか${names.length - 1}件を変更`;
  },
  changedConfig: "設定を変更",
  changedInit: "起動時の動作を変更",
  changedMixed: (n: number) => `${n}件の変更`,
  changeStartup: "起動時チェックポイント",
  changeStartupError: "起動時チェックポイント（エラー）",
  changeManual: "AIが記録",
  changePreRestore: (time: string) => `${time} の状態に復元`,
  changeSdkSnapshot: "packが記録",
  changeUnknown: "変更",
};

const NOW = new Date(2026, 5, 6, 12, 0, 0).getTime();

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

describe("parseRestoreLabel", () => {
  it("parses valid restore label", () => {
    expect(parseRestoreLabel("restore-to:5:1717628460000")).toBe(1717628460000);
  });

  it("returns null for undefined", () => {
    expect(parseRestoreLabel(undefined)).toBeNull();
  });

  it("returns null for invalid format", () => {
    expect(parseRestoreLabel("random label")).toBeNull();
    expect(parseRestoreLabel("restore-to:abc:def")).toBeNull();
    expect(parseRestoreLabel("restore-to:5")).toBeNull();
  });
});

describe("describeChange", () => {
  it("one pack", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["my-theme"] },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("「my-theme」を変更");
  });

  it("config only", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["config.json"] },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("設定を変更");
  });

  it("init only", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["init.js"] },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("起動時の動作を変更");
  });

  it("two packs shows both names", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["theme-a", "theme-b"] },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("「theme-a」を変更、「theme-b」を変更");
  });

  it("four packs shows first + count", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["a", "b", "c", "d"] },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("「a」ほか3件を変更");
  });

  it("mixed pack + config", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "watcher-settled", changed: ["a", "config.json"] },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("2件の変更");
  });

  it("baseline fallback when changed absent", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "startup-baseline" }, changeText, "ja-JP", NOW),
    ).toBe("起動時チェックポイント");
  });

  it("startup error folds health into the text", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "startup-baseline", startup_clean: false },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("起動時チェックポイント（エラー）");
  });

  it("startup clean is just the plain startup text", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "startup-baseline", startup_clean: true },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("起動時チェックポイント");
  });

  it("mcp label takes precedence", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "mcp:snapshot", label: "夜にする前" },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("夜にする前");
  });

  it("mcp without label falls back to manual", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "mcp:snapshot" }, changeText, "ja-JP", NOW),
    ).toBe("AIが記録");
  });

  it("sdk:snapshot without label", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "sdk:snapshot" }, changeText, "ja-JP", NOW),
    ).toBe("packが記録");
  });

  it("sdk:snapshot with label uses label", () => {
    expect(
      describeChange(
        { seq: 1, ts_ms: 0, trigger: "sdk:snapshot", label: "before experiment" },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("before experiment");
  });

  it("pre-restore with structured label shows restore target time", () => {
    const targetTs = new Date(2026, 5, 6, 0, 31, 0).getTime();
    expect(
      describeChange(
        { seq: 3, ts_ms: NOW, trigger: "pre-restore", label: `restore-to:1:${targetTs}` },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toMatch(/の状態に復元$/);
  });

  it("pre-restore without label falls back to unknown", () => {
    expect(
      describeChange({ seq: 1, ts_ms: 0, trigger: "pre-restore" }, changeText, "ja-JP", NOW),
    ).toBe("変更");
  });

  it("uses label as the primary heading when present with changed", () => {
    expect(
      describeChange(
        {
          seq: 1,
          ts_ms: 0,
          trigger: "watcher-settled",
          changed: ["my-theme"],
          label: "暗い見た目にする前",
        },
        changeText,
        "ja-JP",
        NOW,
      ),
    ).toBe("「my-theme」を変更");
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
    expect(rows[0].changedItems).toEqual(["my-theme"]);
    expect(rows[0].startupStatus).toBeNull();
    expect(rows[0].isLatest).toBe(true);
    expect(rows[0].isRecommended).toBe(false);
    expect(rows[1].changeText).toBe("設定を変更");
    expect(rows[1].timeText).toBe("1分前");
    expect(rows[2].startupStatus).toBeNull();
    expect(rows[1].isLatest).toBe(false);
    expect(rows[1].isRecommended).toBe(true);
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
      trigger: "watcher-settled" as const,
      changed: ["pack"],
    }));
    expect(buildRestoreRows(many, 0, changeText, "ja-JP")).toHaveLength(5);
    expect(buildRestoreRows(many, 0, changeText, "ja-JP", 3)).toHaveLength(3);
  });

  it("empty → []", () => {
    expect(buildRestoreRows([], 0, changeText, "ja-JP")).toEqual([]);
  });
});
