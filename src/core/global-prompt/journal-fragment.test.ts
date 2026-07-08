import { describe, expect, it } from "vitest";
import { selectMemoryLines } from "./journal-fragment";

describe("selectMemoryLines", () => {
  const lines = (n: number) =>
    Array.from({ length: n }, (_, i) => `2026-01-${String(i + 1).padStart(2, "0")}: 記憶${i + 1}`);

  it("少件数なら全件をそのまま返す", () => {
    expect(selectMemoryLines(lines(7))).toEqual(lines(7));
    expect(selectMemoryLines([])).toEqual([]);
  });

  it("空行・空白行は除外する", () => {
    expect(selectMemoryLines(["", "  ", "a", "\t"])).toEqual(["a"]);
  });

  it("多件数なら直近5件+古い2件に選抜し、古い→新しいの順を保つ", () => {
    const all = lines(20);
    const selected = selectMemoryLines(all, () => 0);
    expect(selected).toHaveLength(7);
    // random=0 固定なら古い側は先頭 2 件が選ばれる
    expect(selected.slice(0, 2)).toEqual(all.slice(0, 2));
    expect(selected.slice(-5)).toEqual(all.slice(-5));
    for (const line of selected) {
      expect(all).toContain(line);
    }
    // 出力順が入力順（古い→新しい）を保つ
    const indices = selected.map((line) => all.indexOf(line));
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("random が 1 に近くても範囲外 index を拾わない", () => {
    const selected = selectMemoryLines(lines(20), () => 0.999999);
    expect(selected).toHaveLength(7);
    expect(selected.every((line) => line !== undefined)).toBe(true);
  });
});
