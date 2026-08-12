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
});
