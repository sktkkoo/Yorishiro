/**
 * Tests for UserPackRegistry — hot-reload 用 idempotency 層。
 *
 * Phase 1-a の pitfall #8 / #9 を受ける隔壁として position する：
 * EffectPackRunner の listener 累積も PersonaRegistry の duplicate throw も、
 * ここで「先に dispose してから新しいものを格納する」形に統一する。
 *
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-b」
 */

import { describe, expect, it } from "vitest";
import { UserPackRegistry } from "./user-pack-registry";

interface TrackedDisposable {
  disposed: boolean;
  readonly dispose: () => void;
}

const makeDisposable = (): TrackedDisposable => {
  const d: TrackedDisposable = {
    disposed: false,
    dispose() {
      d.disposed = true;
    },
  };
  return d;
};

describe("UserPackRegistry", () => {
  it("stores a disposable and reports has() correctly", () => {
    const reg = new UserPackRegistry();
    const d = makeDisposable();

    reg.register("my-effect", "effect", d);

    expect(reg.has("my-effect", "effect")).toBe(true);
    expect(reg.has("my-effect", "persona")).toBe(false);
    expect(reg.has("other", "effect")).toBe(false);
    expect(d.disposed).toBe(false);
  });

  it("disposes the previous handle when the same id+kind is re-registered", () => {
    const reg = new UserPackRegistry();
    const first = makeDisposable();
    const second = makeDisposable();

    reg.register("shake", "effect", first);
    reg.register("shake", "effect", second);

    expect(first.disposed).toBe(true);
    expect(second.disposed).toBe(false);
    expect(reg.has("shake", "effect")).toBe(true);
  });

  it("treats id+kind as a compound key (same id, different kind coexist)", () => {
    const reg = new UserPackRegistry();
    const effectDisposable = makeDisposable();
    const personaDisposable = makeDisposable();

    reg.register("twin", "effect", effectDisposable);
    reg.register("twin", "persona", personaDisposable);

    expect(effectDisposable.disposed).toBe(false);
    expect(personaDisposable.disposed).toBe(false);
    expect(reg.has("twin", "effect")).toBe(true);
    expect(reg.has("twin", "persona")).toBe(true);
  });

  it("dispose(id, kind) disposes and removes the entry", () => {
    const reg = new UserPackRegistry();
    const d = makeDisposable();

    reg.register("to-remove", "effect", d);
    reg.dispose("to-remove", "effect");

    expect(d.disposed).toBe(true);
    expect(reg.has("to-remove", "effect")).toBe(false);
  });

  it("dispose() on an unknown id+kind is a no-op", () => {
    const reg = new UserPackRegistry();
    // should not throw
    expect(() => reg.dispose("ghost", "effect")).not.toThrow();
  });

  it("disposeAll() disposes every stored disposable and clears the registry", () => {
    const reg = new UserPackRegistry();
    const a = makeDisposable();
    const b = makeDisposable();
    const c = makeDisposable();

    reg.register("a", "effect", a);
    reg.register("b", "effect", b);
    reg.register("c", "persona", c);

    reg.disposeAll();

    expect(a.disposed).toBe(true);
    expect(b.disposed).toBe(true);
    expect(c.disposed).toBe(true);
    expect(reg.has("a", "effect")).toBe(false);
    expect(reg.has("b", "effect")).toBe(false);
    expect(reg.has("c", "persona")).toBe(false);
  });

  it("swallows errors thrown by a disposable and continues", () => {
    const reg = new UserPackRegistry();
    const throwing = {
      dispose() {
        throw new Error("dispose boom");
      },
    };
    const clean = makeDisposable();

    reg.register("bad", "effect", throwing);
    reg.register("good", "effect", clean);

    // A follow-up registration of 'bad' must not propagate the throw.
    expect(() => reg.register("bad", "effect", makeDisposable())).not.toThrow();
    // disposeAll must still reach 'good' after 'bad' throws.
    expect(() => reg.disposeAll()).not.toThrow();
    expect(clean.disposed).toBe(true);
  });
});
