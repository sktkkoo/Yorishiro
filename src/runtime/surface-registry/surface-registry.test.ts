// @vitest-environment jsdom

import type { UiLayout } from "@charminal/sdk";
import { beforeEach, describe, expect, it } from "vitest";
import { createSurfaceRegistry } from "./surface-registry";
import type { SurfaceName } from "./types";

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

  it("未登録の surface への unregister は no-op", () => {
    reg.unregister("character", a);
    expect(reg.get("character")).toBeNull();
  });

  it("surface 名は独立（shell と character は干渉しない）", () => {
    reg.register("shell", a);
    reg.register("character", b);
    expect(reg.get("shell")).toBe(a);
    expect(reg.get("character")).toBe(b);
  });

  it("chrome surface は shell/character と独立", () => {
    const c = document.createElement("div");
    reg.register("shell", a);
    reg.register("character", b);
    reg.register("chrome", c);
    expect(reg.get("shell")).toBe(a);
    expect(reg.get("character")).toBe(b);
    expect(reg.get("chrome")).toBe(c);
  });

  // SDK UiLayout.presence.target は runtime SurfaceName と完全一致していること。
  // 片方だけ surface を増減すると presence 契約と registry が食い違うのでコンパイルで止める。
  it("UiLayout.presence.target は SurfaceName と双方向に代入可能", () => {
    type PresenceTarget = NonNullable<UiLayout["presence"]>["target"];
    const aToB: SurfaceName = null as unknown as PresenceTarget;
    const bToA: PresenceTarget = null as unknown as SurfaceName;
    void aToB;
    void bToA;
    expect(true).toBe(true);
  });
});
