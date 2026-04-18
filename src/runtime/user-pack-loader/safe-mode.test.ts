/**
 * safe-mode の判定 logic — pure fn として envelope を閉じる。
 *
 * runtime-wire で実際の env 取得（Tauri command 経由）と合流させるが、
 * 判定の境界条件はここで固定する。
 */

import { describe, expect, it } from "vitest";
import { isSafeMode } from "./safe-mode";

describe("isSafeMode", () => {
  it("returns true when CHARMINAL_SAFE_MODE is exactly '1'", () => {
    expect(isSafeMode("1")).toBe(true);
  });

  it("returns false when CHARMINAL_SAFE_MODE is unset (null / undefined / empty)", () => {
    expect(isSafeMode(null)).toBe(false);
    expect(isSafeMode(undefined)).toBe(false);
    expect(isSafeMode("")).toBe(false);
  });

  it("returns false for other truthy-looking values (strict '1' check)", () => {
    expect(isSafeMode("0")).toBe(false);
    expect(isSafeMode("true")).toBe(false);
    expect(isSafeMode("yes")).toBe(false);
    expect(isSafeMode("on")).toBe(false);
  });
});
