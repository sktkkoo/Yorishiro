import type { Disposable, UiContext } from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import type { UiPackEntry } from "./types";
import { createUiPackRegistry } from "./ui-pack-registry";

const entry = (id: string, origin: "bundled" | "user" = "bundled"): UiPackEntry => ({
  id,
  origin,
  manifest: {
    id,
    type: "ui",
    version: "0.1.0",
    charminalVersion: "^0.1.0",
    entry: "ui.tsx",
  },
  pack: {
    layout: {},
    mount: (_ctx: UiContext, _container: HTMLDivElement): Disposable => ({
      dispose: () => {},
    }),
  },
});

describe("UiPackRegistry", () => {
  it("register した bundled は null 選択時には active にならない", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("my-ui"));
    expect(reg.getActiveUi()).toBeNull();
  });

  it("setActiveUi で active を切り替えられる", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("ui-a"));
    reg.register(entry("ui-b"));
    reg.setActiveUi("ui-b");
    expect(reg.getActiveUi()?.id).toBe("ui-b");
  });

  it("setActiveUi(null) で UI pack なしに戻る", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("ui-a"));
    reg.register(entry("ui-b"));
    reg.setActiveUi("ui-b");
    reg.setActiveUi(null);
    expect(reg.getActiveUi()).toBeNull();
  });

  it("subscribeActive が active 変更を通知する", () => {
    const reg = createUiPackRegistry();
    const listener = vi.fn();
    reg.subscribeActive(listener);
    // 初期 null で同期 fire
    expect(listener).toHaveBeenCalledWith(null);
    reg.register(entry("my-ui"));
    expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ id: "my-ui" }));
    reg.setActiveUi("my-ui");
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: "my-ui" }));
  });

  it("user pack が bundled を override して promote される", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("same-id", "bundled"));
    reg.register(entry("same-id", "user"));
    expect(reg.getActiveUi()).toBeNull();
    reg.setActiveUi("same-id");
    expect(reg.getActiveUi()?.origin).toBe("user");
  });

  it("dispose で entry が削除される", () => {
    const reg = createUiPackRegistry();
    const handle = reg.register(entry("my-ui"));
    handle.dispose();
    expect(reg.getActiveUi()).toBeNull();
  });

  it("listEntries が全 entry を返す", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("a"));
    reg.register(entry("b"));
    expect(reg.listEntries()).toHaveLength(2);
  });

  it("getActiveUiId returns active entry's id (alias of base getActiveId)", () => {
    const registry = createUiPackRegistry();
    expect(registry.getActiveUiId()).toBeNull();
    registry.register(entry("u1"));
    registry.setActiveUi("u1");
    expect(registry.getActiveUiId()).toBe("u1");
  });
});
