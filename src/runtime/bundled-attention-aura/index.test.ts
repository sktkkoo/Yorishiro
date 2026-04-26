import { describe, expect, it } from "vitest";
import { createAmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import { registerBundledAttentionAura } from "./index";

describe("registerBundledAttentionAura", () => {
  it("registers attention-aura with origin=bundled", () => {
    const registry = createAmbientUiPackRegistry();
    registerBundledAttentionAura({ registry });

    const entries = registry.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe("attention-aura");
    expect(entries[0].origin).toBe("bundled");
    expect(entries[0].manifest.type).toBe("ambient-ui");
  });

  it("registered entry has working mount function", () => {
    const registry = createAmbientUiPackRegistry();
    registerBundledAttentionAura({ registry });
    const entry = registry.listEntries()[0];

    expect(typeof entry.pack.mount).toBe("function");
  });

  it("returns Disposable that removes the entry", () => {
    const registry = createAmbientUiPackRegistry();
    const handle = registerBundledAttentionAura({ registry });

    expect(registry.listEntries()).toHaveLength(1);
    handle.dispose();
    expect(registry.listEntries()).toHaveLength(0);
  });
});
