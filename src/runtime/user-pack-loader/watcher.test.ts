import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  channelHandler: null as ((event: unknown) => void) | null,
  importTsx: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class {
    set onmessage(handler: (event: unknown) => void) {
      mocks.channelHandler = handler;
    }
  },
  convertFileSrc: (path: string) => `https://asset.local${path}`,
  invoke: mocks.invoke,
}));

vi.mock("./tsx-transpiler", () => ({
  importUiTsxEntry: mocks.importTsx,
}));

import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import { createAmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import {
  type AmbientUiRegistrationEvent,
  reconcileAmbientUiRegistration,
} from "./ambient-ui-activation";
import { UserPackRegistry } from "./user-pack-registry";
import { type StartPackWatcherDeps, startPackWatcher } from "./watcher";

const HOME = "/Users/sample/.yorishiro";

function makeDeps(packReloadEnabled = true) {
  const ambientRegister = vi.fn(() => ({ dispose: vi.fn() }));
  const userPackLog = { write: vi.fn() };
  const deps = {
    effectPackRunner: { register: vi.fn() },
    personaRegistry: { register: vi.fn() },
    scenePackRegistry: {},
    uiPackRegistry: {},
    ambientUiPackRegistry: { register: ambientRegister },
    amenityPackRegistry: {},
    packRegistry: new UserPackRegistry(),
    userPackLog,
    initScriptLog: { write: vi.fn() },
    packReloadEnabled,
  } as unknown as StartPackWatcherDeps;
  return { ambientRegister, deps, userPackLog };
}

function makeAmbientLifecycleDeps(
  selectedIds: ReadonlySet<string>,
  options: {
    readonly disabledIds?: ReadonlySet<string>;
    readonly readConfigText?: () => Promise<string>;
    readonly isRuntimeSuppressed?: (id: string) => boolean;
  } = {},
) {
  const ambientUiPackRegistry = createAmbientUiPackRegistry();
  const packRegistry = new UserPackRegistry();
  const onAmbientUiRegistered = vi.fn((event: AmbientUiRegistrationEvent) =>
    reconcileAmbientUiRegistration(event, {
      registry: ambientUiPackRegistry,
      readConfigText:
        options.readConfigText ??
        (async () =>
          JSON.stringify({
            activeAmbientUi: [...selectedIds],
            disabledPacks: [...(options.disabledIds ?? [])],
          })),
      isRuntimeSuppressed: options.isRuntimeSuppressed,
    }),
  );
  const userPackLog = { write: vi.fn() };
  const deps = {
    effectPackRunner: { register: vi.fn() },
    personaRegistry: { register: vi.fn() },
    scenePackRegistry: {},
    uiPackRegistry: {},
    ambientUiPackRegistry,
    amenityPackRegistry: {},
    packRegistry,
    userPackLog,
    initScriptLog: { write: vi.fn() },
    onAmbientUiRegistered,
  } as unknown as StartPackWatcherDeps;
  return { ambientUiPackRegistry, deps, onAmbientUiRegistered, packRegistry };
}

function registerExistingAmbientUi(
  registry: AmbientUiPackRegistry,
  packRegistry: UserPackRegistry,
  id: string,
): void {
  const handle = registry.register({
    id,
    origin: "user",
    manifest: {
      id,
      type: "ambient-ui",
      version: "0.0.0",
      yorishiroVersion: "*",
      entry: "ambient-ui.tsx",
    },
    pack: { mount: () => ({ dispose: () => {} }) },
  });
  packRegistry.register(id, "ambient-ui", handle);
}

async function startAndEmit(deps: StartPackWatcherDeps, event: unknown): Promise<void> {
  await startPackWatcher(deps);
  expect(mocks.channelHandler).not.toBeNull();
  mocks.channelHandler?.(event);
}

const waitMs = async (ms: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, ms));

describe("startPackWatcher ambient-ui TSX reload", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mocks.channelHandler = null;
    mocks.importTsx.mockReset();
    mocks.invoke.mockReset();
    mocks.invoke.mockImplementation(async (command: string) => {
      if (command === "yorishiro_home_dir") return HOME;
      if (command === "watch_yorishiro_layer") return undefined;
      if (command === "list_user_packs") {
        return [
          {
            id: "my-overlay",
            kind: "ambient-ui",
            entryPath: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
            source: "local",
          },
        ];
      }
      throw new Error(`unexpected invoke: ${command}`);
    });
    globalThis.fetch = vi.fn(async () => new Response("not found", { status: 404 }));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("reloads the discovered ambient-ui.tsx owner after a nested source edit", async () => {
    const pack = {
      id: "my-overlay",
      type: "ambient-ui",
      mount: () => ({ dispose: () => {} }),
    };
    mocks.importTsx.mockResolvedValue({ default: pack });
    const { ambientRegister, deps } = makeDeps();

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/lib/overlay.tsx`,
      kind: "modified",
      mtimeMs: 1700000000100,
    });

    await vi.waitFor(() => expect(ambientRegister).toHaveBeenCalledTimes(1));
    expect(mocks.importTsx).toHaveBeenCalledWith(
      `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      expect.any(Object),
      { cacheKey: 1700000000100 },
    );
    expect(ambientRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "my-overlay",
        origin: "user",
        manifest: expect.objectContaining({ entry: "ambient-ui.tsx" }),
      }),
    );
  });

  it("keeps pack imports and registration disabled in safe mode", async () => {
    const { ambientRegister, deps } = makeDeps(false);

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "modified",
      mtimeMs: 1700000000200,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.importTsx).not.toHaveBeenCalled();
    expect(ambientRegister).not.toHaveBeenCalled();
  });

  it("reports TSX hot-reload import failures without replacing the active pack", async () => {
    mocks.importTsx.mockRejectedValue(new Error("synthetic compile failure"));
    const { ambientRegister, deps, userPackLog } = makeDeps();

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "modified",
      mtimeMs: 1700000000300,
    });

    await vi.waitFor(() =>
      expect(userPackLog.write).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: "reload",
          note: expect.stringContaining("dynamic import failed"),
          data: expect.objectContaining({ error: "synthetic compile failure" }),
        }),
      ),
    );
    expect(ambientRegister).not.toHaveBeenCalled();
  });

  it("activates a newly registered ambient-ui when config selects it", async () => {
    const selectedIds = new Set(["my-overlay"]);
    const { ambientUiPackRegistry, deps, onAmbientUiRegistered } =
      makeAmbientLifecycleDeps(selectedIds);
    mocks.importTsx.mockResolvedValue({
      default: {
        id: "my-overlay",
        type: "ambient-ui",
        mount: () => ({ dispose: () => {} }),
      },
    });

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "created",
      mtimeMs: 1700000000400,
    });

    await vi.waitFor(() => expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]));
    expect(onAmbientUiRegistered).toHaveBeenCalledWith({ id: "my-overlay", replaced: false });
  });

  it("preserves an active ambient-ui while atomically replacing its code", async () => {
    const selectedIds = new Set(["my-overlay"]);
    const { ambientUiPackRegistry, deps, onAmbientUiRegistered, packRegistry } =
      makeAmbientLifecycleDeps(selectedIds);
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "my-overlay");
    ambientUiPackRegistry.enable("my-overlay");
    mocks.importTsx.mockResolvedValue({
      default: {
        id: "my-overlay",
        type: "ambient-ui",
        mount: () => ({ dispose: () => {} }),
      },
    });

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "modified",
      mtimeMs: 1700000000500,
    });

    await vi.waitFor(() =>
      expect(onAmbientUiRegistered).toHaveBeenCalledWith({ id: "my-overlay", replaced: true }),
    );
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    expect(ambientUiPackRegistry.listEntries()).toHaveLength(1);
  });

  it("keeps a config-selected but runtime-suppressed ambient-ui inactive after reload", async () => {
    const selectedIds = new Set(["my-overlay"]);
    const { ambientUiPackRegistry, deps, onAmbientUiRegistered, packRegistry } =
      makeAmbientLifecycleDeps(selectedIds, { isRuntimeSuppressed: () => true });
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "my-overlay");
    mocks.importTsx.mockResolvedValue({
      default: {
        id: "my-overlay",
        type: "ambient-ui",
        mount: () => ({ dispose: () => {} }),
      },
    });

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "modified",
      mtimeMs: 1700000000600,
    });

    await vi.waitFor(() =>
      expect(onAmbientUiRegistered).toHaveBeenCalledWith({ id: "my-overlay", replaced: true }),
    );
    expect(ambientUiPackRegistry.getActiveSet()).toEqual([]);
    expect(ambientUiPackRegistry.listEntries()).toHaveLength(1);
  });

  it("keeps a disabled ambient-ui inactive without changing another overlay", async () => {
    const { ambientUiPackRegistry, deps, packRegistry } = makeAmbientLifecycleDeps(
      new Set(["my-overlay", "other-overlay"]),
      { disabledIds: new Set(["my-overlay"]) },
    );
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "my-overlay");
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "other-overlay");
    ambientUiPackRegistry.enable("my-overlay");
    ambientUiPackRegistry.enable("other-overlay");
    mocks.importTsx.mockResolvedValue({
      default: {
        id: "my-overlay",
        type: "ambient-ui",
        mount: () => ({ dispose: () => {} }),
      },
    });

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "modified",
      mtimeMs: 1700000000650,
    });

    await vi.waitFor(() => expect(ambientUiPackRegistry.getActiveSet()).toEqual(["other-overlay"]));
    expect(
      ambientUiPackRegistry
        .listEntries()
        .map((entry) => entry.id)
        .sort(),
    ).toEqual(["my-overlay", "other-overlay"]);
  });

  it("does not mutate active overlays when the activation config read fails", async () => {
    const { ambientUiPackRegistry, deps, packRegistry, onAmbientUiRegistered } =
      makeAmbientLifecycleDeps(new Set(["my-overlay"]), {
        readConfigText: async () => {
          throw new Error("synthetic config read failure");
        },
      });
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "my-overlay");
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "other-overlay");
    ambientUiPackRegistry.enable("my-overlay");
    ambientUiPackRegistry.enable("other-overlay");
    mocks.importTsx.mockResolvedValue({
      default: {
        id: "my-overlay",
        type: "ambient-ui",
        mount: () => ({ dispose: () => {} }),
      },
    });

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "modified",
      mtimeMs: 1700000000660,
    });

    await vi.waitFor(() => expect(onAmbientUiRegistered).toHaveBeenCalledTimes(1));
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay", "other-overlay"]);
  });

  it("preserves the old registration on validation failure", async () => {
    const { ambientUiPackRegistry, deps, packRegistry, onAmbientUiRegistered } =
      makeAmbientLifecycleDeps(new Set(["my-overlay"]));
    const oldMount = vi.fn(() => ({ dispose: () => {} }));
    const oldHandle = ambientUiPackRegistry.register({
      id: "my-overlay",
      origin: "user",
      manifest: {
        id: "my-overlay",
        type: "ambient-ui",
        version: "0.0.0",
        yorishiroVersion: "*",
        entry: "ambient-ui.tsx",
      },
      pack: { mount: oldMount },
    });
    packRegistry.register("my-overlay", "ambient-ui", oldHandle);
    ambientUiPackRegistry.enable("my-overlay");
    mocks.importTsx.mockResolvedValue({
      default: { id: "my-overlay", type: "ambient-ui" },
    });

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "modified",
      mtimeMs: 1700000000670,
    });

    await vi.waitFor(() =>
      expect(deps.userPackLog.write).toHaveBeenCalledWith(
        expect.objectContaining({ note: expect.stringContaining("reload failed") }),
      ),
    );
    expect(ambientUiPackRegistry.listEntries()[0]?.pack.mount).toBe(oldMount);
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    expect(onAmbientUiRegistered).not.toHaveBeenCalled();
  });

  it("rejects a module id mismatch and preserves the old registration", async () => {
    const { ambientUiPackRegistry, deps, packRegistry, onAmbientUiRegistered } =
      makeAmbientLifecycleDeps(new Set(["my-overlay"]));
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "my-overlay");
    ambientUiPackRegistry.enable("my-overlay");
    mocks.importTsx.mockResolvedValue({
      default: {
        id: "renamed-overlay",
        type: "ambient-ui",
        mount: () => ({ dispose: () => {} }),
      },
    });

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "modified",
      mtimeMs: 1700000000680,
    });

    await vi.waitFor(() =>
      expect(deps.userPackLog.write).toHaveBeenCalledWith(
        expect.objectContaining({
          note: expect.stringContaining("reload failed"),
          data: expect.objectContaining({ error: expect.stringContaining("does not match") }),
        }),
      ),
    );
    expect(ambientUiPackRegistry.listEntries().map((entry) => entry.id)).toEqual(["my-overlay"]);
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    expect(onAmbientUiRegistered).not.toHaveBeenCalled();
  });

  it("coalesces an atomic remove then successful create delayed beyond one Rust drain", async () => {
    const { ambientUiPackRegistry, deps, packRegistry, onAmbientUiRegistered } =
      makeAmbientLifecycleDeps(new Set(["my-overlay"]));
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "my-overlay");
    ambientUiPackRegistry.enable("my-overlay");
    mocks.importTsx.mockResolvedValue({
      default: {
        id: "my-overlay",
        type: "ambient-ui",
        mount: () => ({ dispose: () => {} }),
      },
    });
    await startPackWatcher(deps);

    mocks.channelHandler?.({
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "removed",
      mtimeMs: 1700000000690,
    });
    await waitMs(200);
    expect(ambientUiPackRegistry.listEntries()).toHaveLength(1);
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    mocks.channelHandler?.({
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "created",
      mtimeMs: 1700000000691,
    });

    await vi.waitFor(() => expect(onAmbientUiRegistered).toHaveBeenCalledTimes(1));
    expect(onAmbientUiRegistered).toHaveBeenCalledWith({ id: "my-overlay", replaced: true });
    expect(ambientUiPackRegistry.listEntries()).toHaveLength(1);
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
  });

  it("preserves the old registration when delayed atomic-save recreation fails to import", async () => {
    const { ambientUiPackRegistry, deps, packRegistry, onAmbientUiRegistered } =
      makeAmbientLifecycleDeps(new Set(["my-overlay"]));
    const oldMount = vi.fn(() => ({ dispose: () => {} }));
    const oldHandle = ambientUiPackRegistry.register({
      id: "my-overlay",
      origin: "user",
      manifest: {
        id: "my-overlay",
        type: "ambient-ui",
        version: "0.0.0",
        yorishiroVersion: "*",
        entry: "ambient-ui.tsx",
      },
      pack: { mount: oldMount },
    });
    packRegistry.register("my-overlay", "ambient-ui", oldHandle);
    ambientUiPackRegistry.enable("my-overlay");
    mocks.importTsx.mockRejectedValue(new Error("atomic-save compile failure"));
    await startPackWatcher(deps);

    mocks.channelHandler?.({
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "removed",
      mtimeMs: 1700000000692,
    });
    await waitMs(200);
    expect(ambientUiPackRegistry.listEntries()[0]?.pack.mount).toBe(oldMount);
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    mocks.channelHandler?.({
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "created",
      mtimeMs: 1700000000693,
    });

    await vi.waitFor(() =>
      expect(deps.userPackLog.write).toHaveBeenCalledWith(
        expect.objectContaining({
          note: expect.stringContaining("dynamic import failed"),
          data: expect.objectContaining({ error: "atomic-save compile failure" }),
        }),
      ),
    );
    expect(ambientUiPackRegistry.listEntries()[0]?.pack.mount).toBe(oldMount);
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    expect(packRegistry.has("my-overlay", "ambient-ui")).toBe(true);
    expect(onAmbientUiRegistered).not.toHaveBeenCalled();
  });

  it("preserves the old registration when delayed atomic-save recreation fails validation", async () => {
    const { ambientUiPackRegistry, deps, packRegistry, onAmbientUiRegistered } =
      makeAmbientLifecycleDeps(new Set(["my-overlay"]));
    const oldMount = vi.fn(() => ({ dispose: () => {} }));
    const oldHandle = ambientUiPackRegistry.register({
      id: "my-overlay",
      origin: "user",
      manifest: {
        id: "my-overlay",
        type: "ambient-ui",
        version: "0.0.0",
        yorishiroVersion: "*",
        entry: "ambient-ui.tsx",
      },
      pack: { mount: oldMount },
    });
    packRegistry.register("my-overlay", "ambient-ui", oldHandle);
    ambientUiPackRegistry.enable("my-overlay");
    mocks.importTsx.mockResolvedValue({
      default: { id: "my-overlay", type: "ambient-ui" },
    });
    await startPackWatcher(deps);

    mocks.channelHandler?.({
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "removed",
      mtimeMs: 1700000000694,
    });
    await waitMs(200);
    expect(ambientUiPackRegistry.listEntries()[0]?.pack.mount).toBe(oldMount);
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    mocks.channelHandler?.({
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "created",
      mtimeMs: 1700000000695,
    });

    await vi.waitFor(() =>
      expect(deps.userPackLog.write).toHaveBeenCalledWith(
        expect.objectContaining({ note: expect.stringContaining("reload failed") }),
      ),
    );
    expect(ambientUiPackRegistry.listEntries()[0]?.pack.mount).toBe(oldMount);
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    expect(packRegistry.has("my-overlay", "ambient-ui")).toBe(true);
    expect(onAmbientUiRegistered).not.toHaveBeenCalled();
  });

  it("removes an ambient-ui without restoring active state", async () => {
    const selectedIds = new Set(["my-overlay"]);
    const { ambientUiPackRegistry, deps, onAmbientUiRegistered, packRegistry } =
      makeAmbientLifecycleDeps(selectedIds);
    registerExistingAmbientUi(ambientUiPackRegistry, packRegistry, "my-overlay");
    ambientUiPackRegistry.enable("my-overlay");

    await startAndEmit(deps, {
      path: `${HOME}/packs/my-overlay/ambient-ui.tsx`,
      kind: "removed",
      mtimeMs: 1700000000700,
    });

    await vi.waitFor(() => expect(ambientUiPackRegistry.listEntries()).toEqual([]));
    expect(ambientUiPackRegistry.getActiveSet()).toEqual([]);
    expect(onAmbientUiRegistered).not.toHaveBeenCalled();
  });
});
