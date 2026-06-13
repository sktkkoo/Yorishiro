import { describe, expect, it } from "vitest";
import { parsePackSandboxSpec } from "./pack-sandbox-spec";

describe("parsePackSandboxSpec", () => {
  it("backend wasm の最小形を受理する", () => {
    const result = parsePackSandboxSpec({ backend: "wasm" });
    expect(result.error).toBeUndefined();
    expect(result.spec).toEqual({ backend: "wasm" });
  });

  it("fs / net / runtime の宣言を受理する", () => {
    const result = parsePackSandboxSpec({
      backend: "native",
      fs: { read: ["~/Documents/foo"], write: [] },
      net: ["api.example.com"],
      runtime: "python3.13-wasi",
    });
    expect(result.error).toBeUndefined();
    expect(result.spec?.backend).toBe("native");
    expect(result.spec?.net).toEqual(["api.example.com"]);
  });

  it("未知の backend を reject する（fail-closed）", () => {
    const result = parsePackSandboxSpec({ backend: "container" });
    expect(result.spec).toBeUndefined();
    expect(result.error).toContain('unknown sandbox backend "container"');
  });

  it("未知の field を reject する（fail-closed）", () => {
    const result = parsePackSandboxSpec({ backend: "wasm", gpu: true });
    expect(result.spec).toBeUndefined();
    expect(result.error).toContain('unknown sandbox field "gpu"');
  });

  it("object 以外を reject する", () => {
    expect(parsePackSandboxSpec("wasm").error).toContain("sandbox must be an object");
    expect(parsePackSandboxSpec(null).error).toContain("sandbox must be an object");
    expect(parsePackSandboxSpec([]).error).toContain("sandbox must be an object");
  });

  it("fs.read に string 以外が混ざったら reject する", () => {
    const result = parsePackSandboxSpec({ backend: "wasm", fs: { read: [1] } });
    expect(result.error).toContain("sandbox.fs.read must be string[]");
  });
});
