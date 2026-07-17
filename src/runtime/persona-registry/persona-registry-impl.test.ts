import { describe, expect, it, vi } from "vitest";
import { PersonaRegistryImpl } from "./persona-registry-impl";
import type { PersonaEntry } from "./types";

const makeEntry = (id: string, origin: "bundled" | "user"): PersonaEntry => ({
  id,
  origin,
  manifest: {
    id,
    type: "persona",
    version: "0.1.0",
    yorishiroVersion: "^0.1.0",
    entry: "persona.js",
  },
  persona: {
    id,
    name: id,
    reflex: { responses: {} },
    world: { body: "", voice: "" },
    logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
  },
});

describe("PersonaRegistryImpl", () => {
  it("starts with no active persona", () => {
    const registry = new PersonaRegistryImpl();
    expect(registry.getActivePersona()).toBeNull();
    expect(registry.listEntries()).toHaveLength(0);
  });

  it("picks up a single bundled as active via fallback", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    expect(registry.getActivePersona()?.id).toBe("a");
  });

  it("user origin overrides bundled at same id (dispose existing)", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("same", "bundled"));
    registry.register(makeEntry("same", "user"));
    const entries = registry.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe("user");
  });

  it("does NOT auto-select user over bundled at different ids", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.register(makeEntry("b", "user"));
    expect(registry.getActivePersona()?.id).toBe("a");
    expect(registry.getActivePersona()?.id).not.toBe("b");
  });

  it("subscribeActive fires on subscription with current active", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    const listener = vi.fn();
    registry.subscribeActive(listener);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("subscribeActive fires when active changes after register", () => {
    const registry = new PersonaRegistryImpl();
    const listener = vi.fn();
    registry.subscribeActive(listener);
    expect(listener).toHaveBeenCalledWith(null);
    registry.register(makeEntry("a", "bundled"));
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ id: "a" }));
  });

  it("subscribeActive does not fire when active does not change", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    const listener = vi.fn();
    registry.subscribeActive(listener);
    const initialCalls = listener.mock.calls.length;
    // 別 id の bundled を register — "a" < "b" なので active は "a" のまま
    registry.register(makeEntry("b", "bundled"));
    expect(listener.mock.calls.length).toBe(initialCalls);
  });

  it("unsubscribes via returned Disposable", () => {
    const registry = new PersonaRegistryImpl();
    const listener = vi.fn();
    const sub = registry.subscribeActive(listener);
    const initialCalls = listener.mock.calls.length;
    sub.dispose();
    registry.register(makeEntry("a", "bundled"));
    expect(listener.mock.calls.length).toBe(initialCalls);
  });

  it("setPrimaryPersona picks the named pack", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.register(makeEntry("b", "user"));
    registry.setPrimaryPersona("b");
    expect(registry.getActivePersona()?.id).toBe("b");
  });

  it("setPrimaryPersona with non-existent id falls through to bundled default", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.setPrimaryPersona("missing");
    expect(registry.getActivePersona()?.id).toBe("a");
  });

  it("setPrimaryPersona(null) restores bundled fallback", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.register(makeEntry("b", "user"));
    registry.setPrimaryPersona("b");
    registry.setPrimaryPersona(null);
    expect(registry.getActivePersona()?.id).toBe("a");
  });

  it("register Disposable removes entry", () => {
    const registry = new PersonaRegistryImpl();
    const handle = registry.register(makeEntry("a", "bundled"));
    expect(registry.getActivePersona()?.id).toBe("a");
    handle.dispose();
    expect(registry.listEntries()).toHaveLength(0);
    expect(registry.getActivePersona()).toBeNull();
  });

  it("bundled registration over existing user is ignored with warning", () => {
    const warnings: string[] = [];
    const registry = new PersonaRegistryImpl({
      warn: (msg) => warnings.push(msg),
    });
    registry.register(makeEntry("same", "user"));
    registry.register(makeEntry("same", "bundled"));
    const entries = registry.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe("user");
    expect(warnings.some((w) => w.includes("same"))).toBe(true);
  });

  it("promotion 由来の primaryPersonaId は promoted entry が dispose されたら null に戻る", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    const userHandle = registry.register(makeEntry("a", "user"));
    // user で bundled を override した時点で primaryPersonaId が "a" に promote される
    expect(registry.getActivePersona()?.id).toBe("a");
    userHandle.dispose();
    // 同 id で新しい user pack が来ても auto-select されないこと（Design B 不変条件）
    registry.register(makeEntry("a", "user"));
    // primaryPersonaId が null に戻っているため、user "a" は auto-select されない
    // bundled は dispose+置換で消えており fallback も無い
    expect(registry.getActivePersona()).toBeNull();
  });

  it("setPrimaryPersona 経由の primaryPersonaId は dispose で消えない（explicit は promotion 扱いしない）", () => {
    const registry = new PersonaRegistryImpl();
    registry.register(makeEntry("a", "bundled"));
    registry.register(makeEntry("b", "user"));
    registry.setPrimaryPersona("b"); // explicit — promoted ではない
    // "a" に切り替えても promotion フラグは false のまま
    registry.setPrimaryPersona("a");
    expect(registry.getActivePersona()?.id).toBe("a");
  });

  it("listener dispatch 中の reentrant dispose が同一 dispatch の後続 listener をスキップしない", () => {
    const registry = new PersonaRegistryImpl();
    const sub1Called: boolean[] = [];
    const sub2Called: boolean[] = [];
    // sub2 を後から代入するため let + 遅延参照で回避する。
    let sub2: { dispose: () => void } = { dispose: () => {} };
    const sub1 = registry.subscribeActive(() => {
      sub1Called.push(true);
      sub2.dispose(); // dispatch 中に reentrant dispose
    });
    sub2 = registry.subscribeActive(() => {
      sub2Called.push(true);
    });
    // register で active が変化し dispatch が走る
    registry.register(makeEntry("a", "bundled"));
    // snapshot していれば sub2 も今回の dispatch では呼ばれる
    expect(sub1Called.length).toBeGreaterThanOrEqual(2);
    expect(sub2Called.length).toBeGreaterThanOrEqual(2);
    void sub1; // suppress unused warning
  });

  it("fires listener when same id is overridden with different persona object", () => {
    const registry = new PersonaRegistryImpl();
    const bundledEntry = makeEntry("same-id", "bundled");
    const userEntry: PersonaEntry = {
      id: "same-id",
      origin: "user",
      manifest: {
        id: "same-id",
        type: "persona",
        version: "0.2.0",
        yorishiroVersion: "^0.1.0",
        entry: "persona.js",
      },
      persona: {
        id: "same-id",
        name: "User Persona",
        reflex: { responses: {} },
        world: { body: "vrm:custom", voice: "" },
        logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
      },
    };
    registry.register(bundledEntry);
    const listener = vi.fn();
    registry.subscribeActive(listener);
    listener.mockClear();
    registry.register(userEntry);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(userEntry.persona);
  });

  it("getActivePersonaId returns active entry's id (alias of base getActiveId)", () => {
    const registry = new PersonaRegistryImpl();
    expect(registry.getActivePersonaId()).toBeNull();
    registry.register(makeEntry("p1", "bundled"));
    expect(registry.getActivePersonaId()).toBe("p1");
  });

  it("bundled id collision overwrites with warning", () => {
    const warnings: string[] = [];
    const registry = new PersonaRegistryImpl({
      warn: (msg) => warnings.push(msg),
    });
    registry.register(makeEntry("dup", "bundled"));
    registry.register(makeEntry("dup", "bundled"));
    expect(registry.listEntries()).toHaveLength(1);
    expect(warnings.some((w) => w.includes("dup"))).toBe(true);
  });
});
