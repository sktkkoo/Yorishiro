import { describe, expect, it, vi } from "vitest";
import { createClaimState } from "./ui-claim-state";

describe("ClaimState", () => {
  it("初期状態は全 kind で未 claim", () => {
    const s = createClaimState();
    expect(s.isClaimed("camera")).toBe(false);
    expect(s.isClaimed("expression")).toBe(false);
    expect(s.isClaimed("animation")).toBe(false);
  });

  it("claim すると isClaimed が true、dispose で false に戻る", () => {
    const s = createClaimState();
    const h = s.claim("camera");
    expect(s.isClaimed("camera")).toBe(true);
    h.dispose();
    expect(s.isClaimed("camera")).toBe(false);
  });

  it("異なる kind は独立に claim できる", () => {
    const s = createClaimState();
    s.claim("camera");
    s.claim("expression");
    expect(s.isClaimed("camera")).toBe(true);
    expect(s.isClaimed("expression")).toBe(true);
    expect(s.isClaimed("animation")).toBe(false);
  });

  it("同 kind の 2 回目 claim は warn + 後勝ち、前 dispose は no-op 化", () => {
    const warn = vi.fn();
    const s = createClaimState({ warn });
    const a = s.claim("camera");
    const b = s.claim("camera");
    expect(warn).toHaveBeenCalledOnce();
    expect(s.isClaimed("camera")).toBe(true);
    a.dispose();
    expect(s.isClaimed("camera")).toBe(true);
    b.dispose();
    expect(s.isClaimed("camera")).toBe(false);
  });

  it("dispose は冪等", () => {
    const s = createClaimState();
    const h = s.claim("camera");
    h.dispose();
    h.dispose();
    expect(s.isClaimed("camera")).toBe(false);
  });

  it("releaseAll で全 kind が false になる", () => {
    const s = createClaimState();
    s.claim("camera");
    s.claim("expression");
    s.claim("animation");
    s.releaseAll();
    expect(s.isClaimed("camera")).toBe(false);
    expect(s.isClaimed("expression")).toBe(false);
    expect(s.isClaimed("animation")).toBe(false);
  });
});
