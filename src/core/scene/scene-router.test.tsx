// @vitest-environment jsdom

/**
 * SceneRouter の test.
 *
 * - entry が null → children をそのまま返す
 * - entry.component が定義 + layers 空 → R3F-only path
 * - entry.component が定義 + layers 非空 → hybrid path（SceneCompositor で
 *   DOM layers 描画 + R3fRuntimeRoot が component を R3F canvas 内に mount）
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
    yorishiroVersion: "^0.1.0",
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
    expect(container.querySelector(".scene-compositor")).toBeNull();
    expect(container.querySelector(".scene-r3f-host")).toBeNull();
  });

  it("renders R3F host wrapper when entry has component and empty layers", () => {
    const FakeComponent = () => null;
    const entry = baseEntry({
      component: FakeComponent,
      scene: { id: "test", layers: [] },
    });
    const { container } = render(
      <SceneRouter entry={entry}>
        <div data-testid="child">vrm</div>
      </SceneRouter>,
    );
    expect(container.querySelector(".scene-r3f-host")).not.toBeNull();
    expect(container.querySelector(".scene-compositor")).toBeNull();
    expect(container.querySelector("[data-testid='child']")).not.toBeNull();
  });

  it("renders SceneCompositor when entry has component and non-empty layers (hybrid)", () => {
    const FakeComponent = () => null;
    const entry = baseEntry({ component: FakeComponent });
    const { container } = render(
      <SceneRouter entry={entry}>
        <div data-testid="child">vrm</div>
      </SceneRouter>,
    );
    expect(container.querySelector(".scene-compositor")).not.toBeNull();
    expect(container.querySelector(".scene-r3f-host")).toBeNull();
    expect(container.querySelector("[data-testid='child']")).not.toBeNull();
  });

  it("falls through to SceneCompositor when entry has scene but no component", () => {
    const entry = baseEntry();
    const { container } = render(
      <SceneRouter entry={entry}>
        <div data-testid="child">vrm</div>
      </SceneRouter>,
    );
    expect(container.querySelector(".scene-compositor")).not.toBeNull();
    expect(container.querySelector("[data-testid='child']")).not.toBeNull();
    expect(container.querySelector(".scene-r3f-host")).toBeNull();
  });
});
