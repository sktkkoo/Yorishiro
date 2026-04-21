import type { Disposable, UiContext } from "@charminal/sdk";
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
  it("register した bundled が fallback で active になる", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("my-ui"));
    expect(reg.getActiveUi()?.id).toBe("my-ui");
  });

  it("setActiveUi で active を切り替えられる", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("ui-a"));
    reg.register(entry("ui-b"));
    reg.setActiveUi("ui-b");
    expect(reg.getActiveUi()?.id).toBe("ui-b");
  });

  it("setActiveUi(null) で fallback に戻る", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("ui-a"));
    reg.register(entry("ui-b"));
    reg.setActiveUi("ui-b");
    reg.setActiveUi(null);
    // alphabetical 先頭 = ui-a
    expect(reg.getActiveUi()?.id).toBe("ui-a");
  });

  it("subscribeActive が active 変更を通知する", () => {
    const reg = createUiPackRegistry();
    const listener = vi.fn();
    reg.subscribeActive(listener);
    // 初期 null で同期 fire
    expect(listener).toHaveBeenCalledWith(null);
    reg.register(entry("my-ui"));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: "my-ui" }));
  });

  it("user pack が bundled を override して promote される", () => {
    const reg = createUiPackRegistry();
    reg.register(entry("same-id", "bundled"));
    reg.register(entry("same-id", "user"));
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
});
