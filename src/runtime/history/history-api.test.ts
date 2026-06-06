import { describe, expect, it } from "vitest";
import { createHistoryApi } from "./history-api";

describe("createHistoryApi", () => {
  const baseDeps = {
    list: async () => [
      { seq: 2, ts_ms: 2, trigger: "watcher-settled" },
      { seq: 1, ts_ms: 1, trigger: "startup-baseline" },
    ],
    create: async (_label?: string) => 3,
    restore: async (_seq: number) => {},
    confirmRestore: async (_seq: number, runRestore: () => Promise<void>) => {
      await runRestore();
      return true;
    },
  };

  it("list passes through", async () => {
    const api = createHistoryApi(baseDeps);
    expect((await api.list()).map((e) => e.seq)).toEqual([2, 1]);
  });

  it("snapshot returns the created seq", async () => {
    const api = createHistoryApi(baseDeps);
    expect(await api.snapshot("good")).toBe(3);
  });

  it("restore runs raw restore when confirmed", async () => {
    const calls: number[] = [];
    const api = createHistoryApi({
      ...baseDeps,
      confirmRestore: async (_seq, runRestore) => {
        await runRestore();
        return true;
      },
      restore: async (seq) => {
        calls.push(seq);
      },
    });
    expect(await api.restore(5)).toBe(true);
    expect(calls).toEqual([5]);
  });

  it("restore skips raw restore when declined", async () => {
    const calls: number[] = [];
    const api = createHistoryApi({
      ...baseDeps,
      confirmRestore: async () => false,
      restore: async (seq) => {
        calls.push(seq);
      },
    });
    expect(await api.restore(5)).toBe(false);
    expect(calls).toEqual([]);
  });
});
