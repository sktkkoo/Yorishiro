// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { type ActiveUiPresence, HOST_DEFAULT_PRESENCE, resolvePresence } from "./presence-target";

const el = (): HTMLElement => document.createElement("div");

function fakeRegistry(map: Partial<Record<string, HTMLElement>>) {
  return { get: (name: string) => map[name] ?? null } as {
    get: (name: "shell" | "character" | "chrome") => HTMLElement | null;
  };
}

describe("resolvePresence", () => {
  it("active pack 無し（kind:none）→ host 既定 = shell を解決", () => {
    const shell = el();
    const r = resolvePresence({ kind: "none" }, fakeRegistry({ shell }));
    expect(r).toEqual({ ok: true, el: shell, target: "shell" });
  });

  it("HOST_DEFAULT_PRESENCE は { target: 'shell' }", () => {
    expect(HOST_DEFAULT_PRESENCE).toEqual({ target: "shell" });
  });

  it("active pack が presence 宣言あり → その target を解決", () => {
    const character = el();
    const active: ActiveUiPresence = {
      kind: "pack",
      id: "my-ui",
      presence: { target: "character" },
    };
    const r = resolvePresence(active, fakeRegistry({ character }));
    expect(r).toEqual({ ok: true, el: character, target: "character" });
  });

  it("active pack が presence 未宣言 → loud-unavailable（reason に pack id）", () => {
    const active: ActiveUiPresence = { kind: "pack", id: "immersive", presence: undefined };
    const r = resolvePresence(active, fakeRegistry({ shell: el() }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("immersive");
  });

  it("宣言された target surface が registry 未登録 → loud-unavailable（reason に target 名）", () => {
    const active: ActiveUiPresence = {
      kind: "pack",
      id: "my-ui",
      presence: { target: "shell" },
    };
    const r = resolvePresence(active, fakeRegistry({}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("shell");
  });

  it("host 既定でも shell surface 未登録なら loud-unavailable", () => {
    const r = resolvePresence({ kind: "none" }, fakeRegistry({}));
    expect(r.ok).toBe(false);
  });
});
