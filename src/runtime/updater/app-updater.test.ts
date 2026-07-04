import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate } from "./app-updater";

// tauri-plugin-updater / plugin-process は Tauri runtime が前提なので module ごと mock する。
const mockCheck = vi.fn();
const mockRelaunch = vi.fn();

vi.mock("@tauri-apps/plugin-updater", () => ({
  check: (...args: unknown[]) => mockCheck(...args),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: (...args: unknown[]) => mockRelaunch(...args),
}));

/** downloadAndInstall に渡された progress callback へ event 列を流す update stub を作る。 */
function makeUpdateStub(
  version: string,
  events: ReadonlyArray<Record<string, unknown>>,
): { version: string; downloadAndInstall: ReturnType<typeof vi.fn> } {
  return {
    version,
    downloadAndInstall: vi.fn(async (onEvent?: (e: unknown) => void) => {
      for (const e of events) onEvent?.(e);
    }),
  };
}

beforeEach(() => {
  mockCheck.mockReset();
  mockRelaunch.mockReset();
  mockRelaunch.mockResolvedValue(undefined);
});

describe("checkForUpdate", () => {
  it("更新がなければ null を返す", async () => {
    mockCheck.mockResolvedValue(null);
    expect(await checkForUpdate()).toBeNull();
  });

  it("check が失敗したら（非 Tauri 文脈 / ネットワーク不達）静かに null を返す", async () => {
    mockCheck.mockRejectedValue(new Error("no tauri"));
    expect(await checkForUpdate()).toBeNull();
  });

  it("更新があれば version を公開する", async () => {
    mockCheck.mockResolvedValue(makeUpdateStub("0.6.0", []));
    const update = await checkForUpdate();
    expect(update?.version).toBe("0.6.0");
  });
});

describe("installAndRelaunch", () => {
  it("downloadAndInstall 完了後に relaunch する", async () => {
    const stub = makeUpdateStub("0.6.0", [{ event: "Finished" }]);
    mockCheck.mockResolvedValue(stub);
    const update = await checkForUpdate();
    await update?.installAndRelaunch();
    expect(stub.downloadAndInstall).toHaveBeenCalledTimes(1);
    expect(mockRelaunch).toHaveBeenCalledTimes(1);
  });

  it("contentLength が既知なら進捗を 0-1 の比率で通知する", async () => {
    const stub = makeUpdateStub("0.6.0", [
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 25 } },
      { event: "Progress", data: { chunkLength: 50 } },
      { event: "Finished" },
    ]);
    mockCheck.mockResolvedValue(stub);
    const update = await checkForUpdate();
    const ratios: Array<number | null> = [];
    await update?.installAndRelaunch((r) => ratios.push(r));
    expect(ratios).toEqual([0, 0.25, 0.75, 1]);
  });

  it("contentLength が不明なら進捗は null（不定）として通知する", async () => {
    const stub = makeUpdateStub("0.6.0", [
      { event: "Started", data: {} },
      { event: "Progress", data: { chunkLength: 25 } },
      { event: "Finished" },
    ]);
    mockCheck.mockResolvedValue(stub);
    const update = await checkForUpdate();
    const ratios: Array<number | null> = [];
    await update?.installAndRelaunch((r) => ratios.push(r));
    expect(ratios).toEqual([null, null, 1]);
  });

  it("downloadAndInstall が失敗したら reject し、relaunch は呼ばない", async () => {
    const stub = {
      version: "0.6.0",
      downloadAndInstall: vi.fn(async () => {
        throw new Error("signature mismatch");
      }),
    };
    mockCheck.mockResolvedValue(stub);
    const update = await checkForUpdate();
    await expect(update?.installAndRelaunch()).rejects.toThrow("signature mismatch");
    expect(mockRelaunch).not.toHaveBeenCalled();
  });
});
