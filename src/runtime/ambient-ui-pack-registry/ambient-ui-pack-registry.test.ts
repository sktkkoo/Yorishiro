import type { AmbientUiPackDefinition } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import { createAmbientUiPackRegistry } from "./ambient-ui-pack-registry";
import type { AmbientUiPackEntry } from "./types";

function entry(
  partial: Partial<AmbientUiPackEntry> & Pick<AmbientUiPackEntry, "id">,
): AmbientUiPackEntry {
  const noopMount: AmbientUiPackDefinition["mount"] = () => ({ dispose: () => {} });
  return {
    origin: "bundled",
    manifest: {
      id: partial.id,
      type: "ambient-ui",
      version: "0.0.0",
      charminalVersion: "*",
      entry: "ui.tsx",
    },
    pack: { mount: noopMount },
    ...partial,
  };
}

describe("AmbientUiPackRegistry", () => {
  it("registers entries and lists them in registration order", () => {
    const registry = createAmbientUiPackRegistry();
    registry.register(entry({ id: "attention-aura" }));
    registry.register(entry({ id: "recording-indicator" }));

    expect(registry.listEntries().map((e) => e.id)).toEqual([
      "attention-aura",
      "recording-indicator",
    ]);
  });

  it("user-over-bundled override replaces existing entry of same id", () => {
    const registry = createAmbientUiPackRegistry();
    registry.register(entry({ id: "attention-aura", origin: "bundled" }));
    registry.register(entry({ id: "attention-aura", origin: "user" }));

    const entries = registry.listEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe("user");
  });

  it("enable / disable manages active set", () => {
    const registry = createAmbientUiPackRegistry();
    registry.register(entry({ id: "attention-aura" }));
    registry.register(entry({ id: "recording-indicator" }));

    registry.enable("attention-aura");
    expect(registry.getActiveSet()).toEqual(["attention-aura"]);

    registry.enable("recording-indicator");
    expect(registry.getActiveSet()).toEqual(["attention-aura", "recording-indicator"]);

    registry.disable("attention-aura");
    expect(registry.getActiveSet()).toEqual(["recording-indicator"]);
  });

  it("enable on unknown id is a no-op (warn only)", () => {
    const registry = createAmbientUiPackRegistry();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    registry.enable("nonexistent");
    expect(registry.getActiveSet()).toEqual([]);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it("subscribeActiveSet fires immediately and on change", () => {
    const registry = createAmbientUiPackRegistry();
    registry.register(entry({ id: "attention-aura" }));

    const seen: ReadonlyArray<string>[] = [];
    const sub = registry.subscribeActiveSet((ids) => {
      seen.push(ids);
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual([]);

    registry.enable("attention-aura");
    expect(seen).toHaveLength(2);
    expect(seen[1]).toEqual(["attention-aura"]);

    sub.dispose();
    registry.disable("attention-aura");
    expect(seen).toHaveLength(2);
  });

  it("disposing a register handle removes the entry and active membership", () => {
    const registry = createAmbientUiPackRegistry();
    const handle = registry.register(entry({ id: "attention-aura" }));
    registry.enable("attention-aura");

    handle.dispose();
    expect(registry.listEntries()).toEqual([]);
    expect(registry.getActiveSet()).toEqual([]);
  });
});
