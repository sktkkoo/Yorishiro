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

function makeAmbientLifecycleDeps(selectedIds: ReadonlySet<string>) {
  const ambientUiPackRegistry = createAmbientUiPackRegistry();
  const packRegistry = new UserPackRegistry();
  const onAmbientUiRegistered = vi.fn((id: string) => {
    if (selectedIds.has(id)) ambientUiPackRegistry.enable(id);
  });
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
    expect(onAmbientUiRegistered).toHaveBeenCalledWith("my-overlay");
  });

  it("restores an active ambient-ui after its code is re-registered", async () => {
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

    await vi.waitFor(() => expect(onAmbientUiRegistered).toHaveBeenCalledWith("my-overlay"));
    expect(ambientUiPackRegistry.getActiveSet()).toEqual(["my-overlay"]);
    expect(ambientUiPackRegistry.listEntries()).toHaveLength(1);
  });

  it("keeps an inactive ambient-ui inactive after its code is re-registered", async () => {
    const selectedIds = new Set<string>();
    const { ambientUiPackRegistry, deps, onAmbientUiRegistered, packRegistry } =
      makeAmbientLifecycleDeps(selectedIds);
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

    await vi.waitFor(() => expect(onAmbientUiRegistered).toHaveBeenCalledWith("my-overlay"));
    expect(ambientUiPackRegistry.getActiveSet()).toEqual([]);
    expect(ambientUiPackRegistry.listEntries()).toHaveLength(1);
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
