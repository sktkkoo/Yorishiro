import type { AmenityHandle, AmenityPackDefinition, HistoryAPI } from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import type { TweenManager } from "../../core/tween/tween-manager";
import { AmenityPackRegistryImpl } from "../amenity-pack-registry";
import { activateAndRegisterAmenity, createUserAmenityContextFactory } from "./amenity-activation";

const fakeHistory: HistoryAPI = {
  list: async () => [],
  snapshot: async () => 1,
  restore: async () => true,
};

const fakeTween = () =>
  ({
    start: vi.fn(),
    startVec3: vi.fn(),
    cancel: vi.fn(),
  }) as unknown as TweenManager;

describe("createUserAmenityContextFactory", () => {
  it("history / signal を通し、emitEvent に packId を stamp し、tween key を namespace する", () => {
    const tweenManager = fakeTween();
    const emitEvent = vi.fn();
    const factory = createUserAmenityContextFactory({
      tweenManager,
      emitEvent,
      loop: () => {},
      history: fakeHistory,
    });
    const controller = new AbortController();
    const ctx = factory({
      packId: "my-amenity",
      packDir: "/tmp/packs/my-amenity",
      source: "local",
      signal: controller.signal,
    });

    expect(ctx.history).toBe(fakeHistory);
    expect(ctx.signal).toBe(controller.signal);
    ctx.emitEvent("ping", { a: 1 });
    expect(emitEvent).toHaveBeenCalledWith("my-amenity", "ping", { a: 1 });

    const apply = (_v: number) => {};
    ctx.tween.start("opacity", 0.2, 100, apply);
    expect(tweenManager.start).toHaveBeenCalledWith(
      "my-amenity:opacity",
      0.2,
      100,
      apply,
      undefined,
    );
  });

  it("ctx.loop.announce が loop dep に phase / detail を渡す", () => {
    const loop = vi.fn();
    const factory = createUserAmenityContextFactory({
      tweenManager: fakeTween(),
      emitEvent: vi.fn(),
      loop,
      history: fakeHistory,
    });
    const ctx = factory({
      packId: "loop-watcher",
      packDir: "/tmp/packs/loop-watcher",
      source: "local",
      signal: new AbortController().signal,
    });

    ctx.loop.announce("progress-milestone", { iteration: 3 });

    expect(loop).toHaveBeenCalledWith("progress-milestone", { iteration: 3 });
  });
});

describe("activateAndRegisterAmenity", () => {
  const makeDef = (dispose: () => void = () => {}): AmenityPackDefinition => ({
    id: "noted",
    name: "Noted",
    toolMeta: [{ name: "noted_add", description: "add a note" }],
    activate: async (): Promise<AmenityHandle> => ({
      tools: { noted_add: async (p) => ({ saved: p }) },
      dispose,
    }),
  });

  it("registry / packRegistry を registryId で key し、tool を routing できる", async () => {
    const amenityPackRegistry = new AmenityPackRegistryImpl();
    const packReg = { register: vi.fn(), dispose: vi.fn() };
    await activateAndRegisterAmenity({
      registryId: "dir-noted",
      def: makeDef(),
      entryPath: "/x/.charminal/packs/dir-noted/amenity.js",
      amenityPackRegistry,
      packRegistry: packReg,
      createAmenityContext: createUserAmenityContextFactory({
        tweenManager: fakeTween(),
        emitEvent: vi.fn(),
        loop: () => {},
        history: fakeHistory,
      }),
    });

    const handle = amenityPackRegistry.getActiveHandle("dir-noted");
    expect(handle).not.toBeNull();
    expect(amenityPackRegistry.getActiveHandle("noted")).toBeNull();
    expect(await handle?.tools.noted_add({ text: "hi" })).toEqual({ saved: { text: "hi" } });
    expect(packReg.register).toHaveBeenCalledWith(
      "dir-noted",
      "amenity",
      expect.objectContaining({ dispose: expect.any(Function) }),
    );
  });

  it("保存された disposable 経由で handle を 1 回だけ dispose する", async () => {
    const amenityPackRegistry = new AmenityPackRegistryImpl();
    const disposeSpy = vi.fn();
    let stored: { dispose: () => void } | undefined;
    const packReg = {
      register: (_id: string, _kind: string, d: { dispose: () => void }) => {
        stored = d;
      },
      dispose: vi.fn(),
    };
    await activateAndRegisterAmenity({
      registryId: "noted",
      def: makeDef(disposeSpy),
      entryPath: "noted/amenity.js",
      amenityPackRegistry,
      packRegistry: packReg,
      createAmenityContext: createUserAmenityContextFactory({
        tweenManager: fakeTween(),
        emitEvent: vi.fn(),
        loop: () => {},
        history: fakeHistory,
      }),
    });
    expect(amenityPackRegistry.getActiveHandle("noted")).not.toBeNull();

    stored?.dispose();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(amenityPackRegistry.getActiveHandle("noted")).toBeNull();
  });
});
