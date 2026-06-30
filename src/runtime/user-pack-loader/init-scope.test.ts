import { describe, expect, it } from "vitest";
import { InitScope, matchShortcut } from "./init-scope";

describe("InitScope", () => {
  it("runs cleanups in LIFO order on dispose", () => {
    const scope = new InitScope();
    const order: number[] = [];
    scope.addCleanup(() => order.push(1));
    scope.addCleanup(() => order.push(2));
    scope.add({ dispose: () => order.push(3) });

    scope.dispose();

    expect(order).toEqual([3, 2, 1]);
  });

  it("dispose is idempotent (cleanups run once)", () => {
    const scope = new InitScope();
    let count = 0;
    scope.addCleanup(() => {
      count += 1;
    });

    scope.dispose();
    scope.dispose();

    expect(count).toBe(1);
  });

  it("a throwing cleanup does not stop the others", () => {
    const scope = new InitScope();
    const ran: string[] = [];
    scope.addCleanup(() => ran.push("a"));
    scope.addCleanup(() => {
      throw new Error("boom");
    });
    scope.addCleanup(() => ran.push("c"));

    expect(() => scope.dispose()).not.toThrow();
    // c (last in) runs first, then the throwing one, then a.
    expect(ran).toEqual(["c", "a"]);
  });

  it("cleanups added after dispose run immediately", () => {
    const scope = new InitScope();
    scope.dispose();
    let ran = false;
    scope.addCleanup(() => {
      ran = true;
    });
    expect(ran).toBe(true);
  });
});

describe("matchShortcut", () => {
  it("matches on code only, ignoring unspecified modifiers", () => {
    expect(matchShortcut({ code: "KeyF" }, { code: "KeyF", metaKey: true })).toBe(true);
    expect(matchShortcut({ code: "KeyF" }, { code: "KeyG" })).toBe(false);
  });

  it("constrains only the modifiers that are specified", () => {
    const spec = { code: "KeyF", meta: true, shift: true };
    expect(matchShortcut(spec, { code: "KeyF", metaKey: true, shiftKey: true })).toBe(true);
    // ctrl not specified → don't care
    expect(
      matchShortcut(spec, { code: "KeyF", metaKey: true, shiftKey: true, ctrlKey: true }),
    ).toBe(true);
    // shift required but missing
    expect(matchShortcut(spec, { code: "KeyF", metaKey: true })).toBe(false);
  });

  it("requires a modifier to be absent when set to false", () => {
    expect(matchShortcut({ code: "KeyF", meta: false }, { code: "KeyF" })).toBe(true);
    expect(matchShortcut({ code: "KeyF", meta: false }, { code: "KeyF", metaKey: true })).toBe(
      false,
    );
  });

  it("matches on key when specified", () => {
    expect(matchShortcut({ key: "f" }, { key: "f" })).toBe(true);
    expect(matchShortcut({ key: "f" }, { key: "g" })).toBe(false);
  });

  it("repeat:false rejects repeated events; repeat:true requires them", () => {
    expect(matchShortcut({ code: "F1", repeat: false }, { code: "F1", repeat: true })).toBe(false);
    expect(matchShortcut({ code: "F1", repeat: false }, { code: "F1", repeat: false })).toBe(true);
    expect(matchShortcut({ code: "F1", repeat: true }, { code: "F1", repeat: false })).toBe(false);
    expect(matchShortcut({ code: "F1", repeat: true }, { code: "F1", repeat: true })).toBe(true);
  });
});
