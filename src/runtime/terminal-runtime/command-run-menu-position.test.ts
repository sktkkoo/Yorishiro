import { describe, expect, it } from "vitest";
import { resolveCommandRunMenuPosition } from "./command-run-menu-position";

describe("resolveCommandRunMenuPosition", () => {
  const viewport = { width: 1000, height: 800 };
  const menu = { width: 160, height: 80 };

  it("badge の下に十分な空きがあれば下に出す", () => {
    const pos = resolveCommandRunMenuPosition({ top: 100, bottom: 116, left: 200 }, menu, viewport);
    expect(pos.top).toBe(120); // bottom + gap(4)
    expect(pos.left).toBe(200);
  });

  it("badge が最下部なら menu を上に flip する", () => {
    const pos = resolveCommandRunMenuPosition({ top: 760, bottom: 776, left: 200 }, menu, viewport);
    // 下に出すと 776+4+80=860 > 800 なので上: top - gap - height = 760-4-80=676
    expect(pos.top).toBe(676);
  });

  it("上にも下にも入りきらない極端な高さは gap で clamp", () => {
    const pos = resolveCommandRunMenuPosition(
      { top: 10, bottom: 790, left: 200 },
      { width: 160, height: 700 },
      viewport,
    );
    // 下 790+4+700>800、上 10-4-700<0 → max(4, 負)=4
    expect(pos.top).toBe(4);
  });

  it("右端で menu が見切れるなら横を画面内に clamp", () => {
    const pos = resolveCommandRunMenuPosition({ top: 100, bottom: 116, left: 900 }, menu, viewport);
    // left 900 + 160 = 1060 > 1000 → 1000-160-4=836
    expect(pos.left).toBe(836);
  });
});
