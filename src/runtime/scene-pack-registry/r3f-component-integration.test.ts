/**
 * R3F-component pack の registry 統合 test.
 *
 * fixture pack を register → getActiveEntry で component が取得できることを検証.
 * R3F の実描画は別 layer (R3fRuntimeRoot test) で扱うのでここでは型と data flow のみ.
 *
 * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §7 phase 4
 */

import { describe, expect, it } from "vitest";
import { r3fValidationPack } from "./__fixtures__/r3f-validation-pack";
import { ScenePackRegistryImpl } from "./scene-pack-registry";
import type { ScenePackEntry } from "./types";

function makeEntry(): ScenePackEntry {
  return {
    id: r3fValidationPack.id,
    origin: "bundled",
    manifest: {
      id: r3fValidationPack.id,
      type: "scene",
      version: "0.1.0",
      charminalVersion: "^0.1.0",
      entry: "scene.ts",
    },
    scene: r3fValidationPack.scene,
    component: r3fValidationPack.component,
  };
}

describe("R3F-component pack integration", () => {
  it("registers a pack with component and exposes it via getActiveEntry", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry());

    const active = registry.getActiveEntry();
    expect(active?.id).toBe("r3f-validation");
    expect(active?.component).toBe(r3fValidationPack.component);
  });

  it("getActiveScene still returns the SceneSpec for declarative consumers", () => {
    const registry = new ScenePackRegistryImpl();
    registry.register(makeEntry());

    expect(registry.getActiveScene()?.id).toBe("r3f-validation");
  });
});
