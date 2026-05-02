// @vitest-environment jsdom

/**
 * SceneRouter の test.
 *
 * - entry が null → children をそのまま返す
 * - entry.component が定義されている → R3F path（DOM 側は最小 wrapper のみ,
 *   実際の R3F render は R3fRuntimeRoot 側）
 * - entry.component が未定義かつ scene を持つ → 既存 SceneCompositor path
 */

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScenePackEntry } from "../../runtime/scene-pack-registry/types";
import { SceneRouter } from "./scene-router";

const baseEntry = (overrides: Partial<ScenePackEntry> = {}): ScenePackEntry => ({
  id: "test",
  origin: "bundled",
  manifest: {
    id: "test",
    type: "scene",
    version: "0.1.0",
    charminalVersion: "^0.1.0",
    entry: "scene.ts",
  },
  scene: {
    id: "test",
    layers: [
      { id: "bg", role: "background" },
      { id: "character", role: "character" },
    ],
  },
  ...overrides,
});

describe("SceneRouter", () => {
  it("returns children directly when entry is null", () => {
    const { container } = render(
      <SceneRouter entry={null}>
        <div data-testid="child">vrm</div>
      </SceneRouter>,
    );
    expect(container.querySelector("[data-testid='child']")).not.toBeNull();
    // 親 wrapper（SceneCompositor 由来の class や R3F host wrapper）は無し
    expect(container.querySelector(".scene-compositor")).toBeNull();
    expect(container.querySelector(".scene-r3f-host")).toBeNull();
  });

  it("renders R3F host wrapper when entry has component", () => {
    const FakeComponent = () => null;
    const entry = baseEntry({ component: FakeComponent });
    const { container } = render(
      <SceneRouter entry={entry}>
        <div data-testid="child">vrm</div>
      </SceneRouter>,
    );
    // R3F path は DOM 側に最小 wrapper のみ。R3F の component は別経路で mount。
    expect(container.querySelector(".scene-r3f-host")).not.toBeNull();
    expect(container.querySelector(".scene-compositor")).toBeNull();
    expect(container.querySelector("[data-testid='child']")).not.toBeNull();
  });

  it("falls through to SceneCompositor when entry has scene but no component", () => {
    const entry = baseEntry();
    const { container } = render(
      <SceneRouter entry={entry}>
        <div data-testid="child">vrm</div>
      </SceneRouter>,
    );
    // SceneCompositor は scene-compositor 由来の container を持つ。
    expect(container.querySelector(".scene-compositor")).not.toBeNull();
    expect(container.querySelector("[data-testid='child']")).not.toBeNull();
    // R3F host wrapper は出ない。
    expect(container.querySelector(".scene-r3f-host")).toBeNull();
  });
});
