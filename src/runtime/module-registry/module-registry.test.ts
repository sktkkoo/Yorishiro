import type { Trigger } from "@charminal/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { _clearForTest as _clearHotData } from "../hot-data/hot-data";
import { type Disposable, getModuleRegistry, ModuleRegistry } from "./module-registry";
import type { Provenance } from "./provenance";

const makeTrigger = (id: string): Trigger => ({ id, match: () => null });

describe("ModuleRegistry", () => {
  afterEach(() => {
    _clearHotData();
  });

  it("registers a builtin trigger-handler and lists it back", () => {
    const registry = new ModuleRegistry();
    const dispose = registry.register("trigger-handler", {
      id: "t1",
      provenance: { source: "builtin" },
      instance: makeTrigger("t1"),
    });

    const list = registry.list("trigger-handler");
    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe("t1");
    expect(list[0]?.provenance.source).toBe("builtin");
    expect(typeof dispose.dispose).toBe("function");
  });

  it("allows persona to register procedural-module", () => {
    const registry = new ModuleRegistry();
    expect(() =>
      registry.register("procedural-module", {
        id: "bones",
        provenance: { source: "persona", packId: "default" },
        instance: { id: "bones" },
      }),
    ).not.toThrow();
  });

  it("rejects harness registering procedural-module at runtime (defense in depth)", () => {
    const registry = new ModuleRegistry();
    const badRegister = () =>
      (
        registry as unknown as {
          register: (
            k: "procedural-module",
            e: { id: string; provenance: Provenance; instance: { id: string } },
          ) => Disposable;
        }
      ).register("procedural-module", {
        id: "x",
        provenance: { source: "harness", packId: "evil" },
        instance: { id: "x" },
      });
    expect(badRegister).toThrow(/cannot register/);
  });

  it("throws on duplicate id within the same kind", () => {
    const registry = new ModuleRegistry();
    registry.register("trigger-handler", {
      id: "dup",
      provenance: { source: "builtin" },
      instance: makeTrigger("dup"),
    });
    expect(() =>
      registry.register("trigger-handler", {
        id: "dup",
        provenance: { source: "builtin" },
        instance: makeTrigger("dup"),
      }),
    ).toThrow(/duplicate id/);
  });

  it("permits the same id across different kinds (kinds are independent namespaces)", () => {
    const registry = new ModuleRegistry();
    registry.register("trigger-handler", {
      id: "shared",
      provenance: { source: "builtin" },
      instance: makeTrigger("shared"),
    });
    expect(() =>
      registry.register("procedural-module", {
        id: "shared",
        provenance: { source: "builtin" },
        instance: { id: "shared" },
      }),
    ).not.toThrow();
  });

  it("dispose() removes the entry; list() reflects it", () => {
    const registry = new ModuleRegistry();
    const handle = registry.register("trigger-handler", {
      id: "t",
      provenance: { source: "builtin" },
      instance: makeTrigger("t"),
    });
    expect(registry.list("trigger-handler")).toHaveLength(1);
    handle.dispose();
    expect(registry.list("trigger-handler")).toHaveLength(0);
  });

  it("swap() replaces the instance and preserves id + provenance", () => {
    const registry = new ModuleRegistry();
    const original = makeTrigger("t");
    const replacement = makeTrigger("t");

    registry.register("trigger-handler", {
      id: "t",
      provenance: { source: "persona", packId: "default" },
      instance: original,
    });
    registry.swap("trigger-handler", "t", replacement);

    const entry = registry.list("trigger-handler")[0];
    expect(entry?.id).toBe("t");
    expect(entry?.provenance).toEqual({ source: "persona", packId: "default" });
    expect(entry?.instance).toBe(replacement);
  });

  it("swap() on an unknown id throws", () => {
    const registry = new ModuleRegistry();
    expect(() => registry.swap("trigger-handler", "missing", makeTrigger("missing"))).toThrow(
      /no entry to swap/,
    );
  });

  it("getModuleRegistry returns the same singleton across calls", () => {
    const a = getModuleRegistry();
    const b = getModuleRegistry();
    expect(a).toBe(b);
  });
});
