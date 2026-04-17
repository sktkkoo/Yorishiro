import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _clearForTest as _clearHotData } from "../hot-data/hot-data";
import { getVrmCache } from "./vrm-cache";

const buf = (label: string): ArrayBuffer => new TextEncoder().encode(label).buffer as ArrayBuffer;

describe("VrmCache", () => {
  beforeEach(() => {
    _clearHotData();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        arrayBuffer: async () => buf(url),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cache miss 時に fetch を呼んで bytes を返す", async () => {
    const cache = getVrmCache();
    const bytes = await cache.getBytes("https://example.test/a.vrm");
    expect(new TextDecoder().decode(bytes)).toBe("https://example.test/a.vrm");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cache hit 時に fetch は再呼び出しされない", async () => {
    const cache = getVrmCache();
    await cache.getBytes("https://example.test/a.vrm");
    await cache.getBytes("https://example.test/a.vrm");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("並行 getBytes は fetch を 1 回に dedup する", async () => {
    const cache = getVrmCache();
    const [a, b] = await Promise.all([
      cache.getBytes("https://example.test/a.vrm"),
      cache.getBytes("https://example.test/a.vrm"),
    ]);
    expect(a).toBe(b);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("LRU 上限超過で最古が evict される（default 3）", async () => {
    const cache = getVrmCache();
    await cache.getBytes("https://example.test/a.vrm");
    await cache.getBytes("https://example.test/b.vrm");
    await cache.getBytes("https://example.test/c.vrm");
    await cache.getBytes("https://example.test/d.vrm"); // state: [b, c, d]、a が evict

    (fetch as ReturnType<typeof vi.fn>).mockClear();
    await cache.getBytes("https://example.test/b.vrm"); // hit（まだ残ってる）
    expect(fetch).toHaveBeenCalledTimes(0);
    await cache.getBytes("https://example.test/a.vrm"); // miss → fetch（evict されていた）
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("setMaxEntries(1) で既存 entry が即 evict される", async () => {
    const cache = getVrmCache();
    await cache.getBytes("https://example.test/a.vrm");
    await cache.getBytes("https://example.test/b.vrm");
    cache.setMaxEntries(1);

    (fetch as ReturnType<typeof vi.fn>).mockClear();
    await cache.getBytes("https://example.test/a.vrm"); // evict 済 → miss
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetch が 404 なら throw", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404 })),
    );
    const cache = getVrmCache();
    await expect(cache.getBytes("https://example.test/missing.vrm")).rejects.toThrow(/404/);
  });

  it("touch で LRU 順が更新される（最近使った entry は evict されない）", async () => {
    const cache = getVrmCache();
    await cache.getBytes("https://example.test/a.vrm");
    await cache.getBytes("https://example.test/b.vrm");
    await cache.getBytes("https://example.test/c.vrm");
    await cache.getBytes("https://example.test/a.vrm"); // a を touch
    await cache.getBytes("https://example.test/d.vrm"); // b が evict されるはず（a ではなく）

    (fetch as ReturnType<typeof vi.fn>).mockClear();
    await cache.getBytes("https://example.test/a.vrm"); // hit
    await cache.getBytes("https://example.test/b.vrm"); // miss
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("getVrmCache は singleton を返す", () => {
    const a = getVrmCache();
    const b = getVrmCache();
    expect(a).toBe(b);
  });
});
