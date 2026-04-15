import { afterEach, describe, expect, it, vi } from "vitest";
import { _clearForTest, getOrInit } from "./hot-data";

describe("getOrInit", () => {
  afterEach(() => {
    _clearForTest();
  });

  it("calls factory exactly once per key and returns the same instance on subsequent calls", () => {
    const factory = vi.fn(() => ({ value: 42 }));

    const first = getOrInit("answer", factory);
    const second = getOrInit("answer", factory);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(first).toEqual({ value: 42 });
  });

  it("returns independent instances for different keys", () => {
    const a = getOrInit("a", () => ({ id: "a" }));
    const b = getOrInit("b", () => ({ id: "b" }));

    expect(a).not.toBe(b);
    expect(a).toEqual({ id: "a" });
    expect(b).toEqual({ id: "b" });
  });

  it("does not invoke factory until getOrInit is called", () => {
    const factory = vi.fn(() => "lazy");

    expect(factory).not.toHaveBeenCalled();

    getOrInit("lazy-key", factory);

    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("preserves falsy values other than undefined and does not re-invoke factory", () => {
    const zeroFactory = vi.fn(() => 0);
    const first = getOrInit("zero", zeroFactory);
    const second = getOrInit("zero", zeroFactory);
    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(zeroFactory).toHaveBeenCalledTimes(1);

    const nullFactory = vi.fn(() => null);
    const nfFirst = getOrInit("nil", nullFactory);
    const nfSecond = getOrInit("nil", nullFactory);
    expect(nfFirst).toBeNull();
    expect(nfSecond).toBeNull();
    expect(nullFactory).toHaveBeenCalledTimes(1);
  });

  it("does not cache on factory throw; next call retries", () => {
    let attempt = 0;
    const factory = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) {
        throw new Error("boom");
      }
      return "ok";
    });

    // Indirect check: we prove no cache entry survives the throw by
    // showing the next call re-invokes the factory. A direct probe of
    // the store would be stronger if the implementation ever grows
    // error-caching semantics.
    expect(() => getOrInit("flaky", factory)).toThrow("boom");
    const second = getOrInit("flaky", factory);

    expect(second).toBe("ok");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("re-invokes factory when it returns undefined (documented contract)", () => {
    const factory = vi.fn(() => undefined);
    getOrInit("undef", factory);
    getOrInit("undef", factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("_clearForTest resets state so factory is re-invoked after clearing", () => {
    const factory = vi.fn(() => ({ marker: "seed" }));
    getOrInit("seed", factory);
    expect(factory).toHaveBeenCalledTimes(1);

    _clearForTest();

    getOrInit("seed", factory);
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
