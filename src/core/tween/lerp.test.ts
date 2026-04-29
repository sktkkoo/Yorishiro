import { describe, expect, it } from "vitest";
import { colorLerp, numberLerp, vec3Lerp } from "./lerp";

describe("numberLerp", () => {
  it("t=0 で from を返す", () => {
    expect(numberLerp(0, 10, 0)).toBe(0);
  });
  it("t=1 で to を返す", () => {
    expect(numberLerp(0, 10, 1)).toBe(10);
  });
  it("t=0.5 で中間値を返す", () => {
    expect(numberLerp(0, 10, 0.5)).toBe(5);
  });
});

describe("vec3Lerp", () => {
  it("t=0 で from を返す", () => {
    expect(vec3Lerp([0, 0, 0], [10, 20, 30], 0)).toEqual([0, 0, 0]);
  });
  it("t=1 で to を返す", () => {
    expect(vec3Lerp([0, 0, 0], [10, 20, 30], 1)).toEqual([10, 20, 30]);
  });
  it("t=0.5 で 3 成分の中間値を返す", () => {
    expect(vec3Lerp([0, 0, 0], [10, 20, 30], 0.5)).toEqual([5, 10, 15]);
  });
});

describe("colorLerp", () => {
  it("#000000 と #ffffff の t=0.5 は #808080", () => {
    expect(colorLerp("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
  it("#ff0000 と #0000ff の t=0.5 は #800080", () => {
    expect(colorLerp("#ff0000", "#0000ff", 0.5)).toBe("#800080");
  });
});
