// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { createSurfaceRegistry } from "./surface-registry";

describe("SurfaceRegistry", () => {
  let reg: ReturnType<typeof createSurfaceRegistry>;
  let a: HTMLElement;
  let b: HTMLElement;

  beforeEach(() => {
    reg = createSurfaceRegistry();
    a = document.createElement("div");
    b = document.createElement("div");
  });

  it("未登録は get→null / has→false", () => {
    expect(reg.get("character")).toBeNull();
    expect(reg.has("character")).toBe(false);
  });

  it("register 後は get で同一 node を返し has→true", () => {
    reg.register("character", a);
    expect(reg.get("character")).toBe(a);
    expect(reg.has("character")).toBe(true);
  });

  it("同名 register は置換する", () => {
    reg.register("shell", a);
    reg.register("shell", b);
    expect(reg.get("shell")).toBe(b);
  });

  it("unregister は引数 el が現登録と一致時のみ外す", () => {
    reg.register("character", a);
    reg.unregister("character", b);
    expect(reg.get("character")).toBe(a);
    reg.unregister("character", a);
    expect(reg.get("character")).toBeNull();
  });

  it("surface 名は独立（shell と character は干渉しない）", () => {
    reg.register("shell", a);
    reg.register("character", b);
    expect(reg.get("shell")).toBe(a);
    expect(reg.get("character")).toBe(b);
  });
});
