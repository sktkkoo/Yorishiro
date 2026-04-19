import { describe, expect, it, vi } from "vitest";
import { SingleActiveRegistry } from "./single-active-registry";
import type { PackOrigin } from "./types";

interface TestEntry {
  readonly id: string;
  readonly origin: PackOrigin;
  readonly value: string;
}

const makeEntry = (id: string, origin: PackOrigin, value?: string): TestEntry => ({
  id,
  origin,
  value: value ?? `${origin}:${id}`,
});

const makeRegistry = (
  opts: { warn?: (msg: string) => void; warnOnMultipleBundled?: boolean } = {},
): SingleActiveRegistry<TestEntry, string> =>
  new SingleActiveRegistry({
    extractValue: (e) => e.value,
    label: "TestRegistry",
    warn: opts.warn,
    warnOnMultipleBundled: opts.warnOnMultipleBundled,
  });

describe("SingleActiveRegistry", () => {
  describe("基本動作", () => {
    it("starts with no active value", () => {
      const registry = makeRegistry();
      expect(registry.getActive()).toBeNull();
      expect(registry.listEntries()).toHaveLength(0);
    });

    it("picks up a single bundled as active via fallback", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      expect(registry.getActive()).toBe("bundled:a");
    });

    it("listEntries returns registered entries", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      registry.register(makeEntry("b", "user"));
      expect(registry.listEntries()).toHaveLength(2);
    });
  });

  describe("override pattern", () => {
    it("user origin overrides bundled at same id (dispose existing)", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("same", "bundled"));
      registry.register(makeEntry("same", "user"));
      const entries = registry.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].origin).toBe("user");
    });

    it("does NOT auto-select user over bundled at different ids", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      registry.register(makeEntry("b", "user"));
      expect(registry.getActive()).toBe("bundled:a");
    });

    it("bundled registration over existing user is ignored with warning", () => {
      const warnings: string[] = [];
      const registry = makeRegistry({ warn: (msg) => warnings.push(msg) });
      registry.register(makeEntry("same", "user"));
      registry.register(makeEntry("same", "bundled"));
      const entries = registry.listEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0].origin).toBe("user");
      expect(warnings.some((w) => w.includes("same"))).toBe(true);
    });

    it("bundled id collision overwrites with warning", () => {
      const warnings: string[] = [];
      const registry = makeRegistry({ warn: (msg) => warnings.push(msg) });
      registry.register(makeEntry("dup", "bundled", "first"));
      registry.register(makeEntry("dup", "bundled", "second"));
      expect(registry.listEntries()).toHaveLength(1);
      expect(registry.getActive()).toBe("second");
      expect(warnings.some((w) => w.includes("dup"))).toBe(true);
    });
  });

  describe("subscribeActive", () => {
    it("fires on subscription with current active", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      const listener = vi.fn();
      registry.subscribeActive(listener);
      expect(listener).toHaveBeenCalledWith("bundled:a");
    });

    it("fires when active changes after register", () => {
      const registry = makeRegistry();
      const listener = vi.fn();
      registry.subscribeActive(listener);
      expect(listener).toHaveBeenCalledWith(null);
      registry.register(makeEntry("a", "bundled"));
      expect(listener).toHaveBeenLastCalledWith("bundled:a");
    });

    it("does not fire when active does not change", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      const listener = vi.fn();
      registry.subscribeActive(listener);
      const initialCalls = listener.mock.calls.length;
      // 別 id の bundled を register — "a" < "b" なので active は "a" のまま
      registry.register(makeEntry("b", "bundled"));
      expect(listener.mock.calls.length).toBe(initialCalls);
    });

    it("unsubscribes via returned Disposable", () => {
      const registry = makeRegistry();
      const listener = vi.fn();
      const sub = registry.subscribeActive(listener);
      const initialCalls = listener.mock.calls.length;
      sub.dispose();
      registry.register(makeEntry("a", "bundled"));
      expect(listener.mock.calls.length).toBe(initialCalls);
    });

    it("fires listener when same id is overridden with different value", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("same-id", "bundled", "first"));
      const listener = vi.fn();
      registry.subscribeActive(listener);
      listener.mockClear();
      registry.register(makeEntry("same-id", "user", "second"));
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith("second");
    });

    it("listener dispatch 中の reentrant dispose が同一 dispatch の後続 listener をスキップしない", () => {
      const registry = makeRegistry();
      const sub1Called: boolean[] = [];
      const sub2Called: boolean[] = [];
      let sub2: { dispose: () => void } = { dispose: () => {} };
      const sub1 = registry.subscribeActive(() => {
        sub1Called.push(true);
        sub2.dispose();
      });
      sub2 = registry.subscribeActive(() => {
        sub2Called.push(true);
      });
      registry.register(makeEntry("a", "bundled"));
      expect(sub1Called.length).toBeGreaterThanOrEqual(2);
      expect(sub2Called.length).toBeGreaterThanOrEqual(2);
      void sub1;
    });
  });

  describe("setActive", () => {
    it("picks the named pack", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      registry.register(makeEntry("b", "user"));
      registry.setActive("b");
      expect(registry.getActive()).toBe("user:b");
    });

    it("with non-existent id falls through to bundled default", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      registry.setActive("missing");
      expect(registry.getActive()).toBe("bundled:a");
    });

    it("setActive(null) restores bundled fallback", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      registry.register(makeEntry("b", "user"));
      registry.setActive("b");
      registry.setActive(null);
      expect(registry.getActive()).toBe("bundled:a");
    });

    it("setActive 経由の activeId は dispose で消えない（explicit は promotion 扱いしない）", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      registry.register(makeEntry("b", "user"));
      registry.setActive("b");
      registry.setActive("a");
      expect(registry.getActive()).toBe("bundled:a");
    });
  });

  describe("promotion semantics", () => {
    it("promotion 由来の activeId は promoted entry が dispose されたら null に戻る", () => {
      const registry = makeRegistry();
      registry.register(makeEntry("a", "bundled"));
      const userHandle = registry.register(makeEntry("a", "user", "user-first"));
      // user で bundled を override した時点で activeId が "a" に promote される
      expect(registry.getActive()).toBe("user-first");
      userHandle.dispose();
      // 同 id で新しい user pack が来ても auto-select されないこと（Design B 不変条件）
      registry.register(makeEntry("a", "user", "user-second"));
      expect(registry.getActive()).toBeNull();
    });
  });

  describe("register Disposable", () => {
    it("removes entry on dispose", () => {
      const registry = makeRegistry();
      const handle = registry.register(makeEntry("a", "bundled"));
      expect(registry.getActive()).toBe("bundled:a");
      handle.dispose();
      expect(registry.listEntries()).toHaveLength(0);
      expect(registry.getActive()).toBeNull();
    });
  });

  describe("warnOnMultipleBundled option", () => {
    it("default is off — multiple bundled with different ids do not warn", () => {
      const warnings: string[] = [];
      const registry = makeRegistry({ warn: (msg) => warnings.push(msg) });
      registry.register(makeEntry("a", "bundled"));
      registry.register(makeEntry("b", "bundled"));
      expect(warnings).toHaveLength(0);
    });

    it("when on, multiple bundled ids trigger a warning", () => {
      const warnings: string[] = [];
      const registry = makeRegistry({
        warn: (msg) => warnings.push(msg),
        warnOnMultipleBundled: true,
      });
      registry.register(makeEntry("a", "bundled"));
      registry.register(makeEntry("b", "bundled"));
      expect(warnings.some((w) => w.includes("multiple bundled"))).toBe(true);
    });
  });
});
