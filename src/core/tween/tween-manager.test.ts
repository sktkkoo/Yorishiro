import { describe, expect, it } from "vitest";
import { TweenManager } from "./tween-manager";

describe("TweenManager", () => {
  it("tick で補間値が apply に渡される", () => {
    const manager = new TweenManager();
    const values: number[] = [];
    manager.start("x", 10, 100, (v) => values.push(v), { from: 0 });

    manager.tick(0); // t=0 → 0
    manager.tick(50); // t=0.5 → 5
    manager.tick(100); // t=1.0 → 10 + 完了

    expect(values[0]).toBe(0);
    expect(values[1]).toBe(5);
    expect(values[2]).toBe(10);
    expect(manager.isActive("x")).toBe(false);
  });

  it("完了時に completion Promise が resolve する", async () => {
    const manager = new TweenManager();
    const handle = manager.start("x", 1, 100, () => {}, { from: 0 });
    manager.tick(0);
    manager.tick(100);
    await expect(handle.completion).resolves.toBeUndefined();
  });

  it("cancel で停止し、completion は resolve する（reject ではない）", async () => {
    const manager = new TweenManager();
    const handle = manager.start("x", 1, 1000, () => {});
    handle.cancel();
    await expect(handle.completion).resolves.toBeUndefined();
    expect(manager.isActive("x")).toBe(false);
  });

  it("last-write-wins: 同 key 置換で古い apply は呼ばれず、古い completion が resolve する", async () => {
    const manager = new TweenManager();
    const oldValues: number[] = [];
    const oldHandle = manager.start("x", 10, 100, (v) => oldValues.push(v), { from: 0 });

    // 同一 key で上書き
    const newValues: number[] = [];
    manager.start("x", 20, 100, (v) => newValues.push(v), { from: 0 });

    // 古い completion は resolve 済みであること
    await expect(oldHandle.completion).resolves.toBeUndefined();

    manager.tick(0);
    manager.tick(100);

    // 新しい apply のみ呼ばれる
    expect(newValues.length).toBeGreaterThan(0);
    // 古い apply は上書き後には呼ばれない
    expect(oldValues.length).toBe(0);
  });

  it("cancel(key) で指定 key のみ cancel する", () => {
    const manager = new TweenManager();
    manager.start("a", 1, 1000, () => {});
    manager.start("b", 1, 1000, () => {});
    manager.cancel("a");
    expect(manager.isActive("a")).toBe(false);
    expect(manager.isActive("b")).toBe(true);
  });

  it("cancelByPrefix で prefix match する全 key を cancel する", () => {
    const manager = new TweenManager();
    manager.start("motion:arm", 1, 1000, () => {});
    manager.start("motion:leg", 1, 1000, () => {});
    manager.start("blend:mix", 1, 1000, () => {});
    manager.cancelByPrefix("motion:");
    expect(manager.isActive("motion:arm")).toBe(false);
    expect(manager.isActive("motion:leg")).toBe(false);
    expect(manager.isActive("blend:mix")).toBe(true);
  });

  it("isActive が正しく報告する", () => {
    const manager = new TweenManager();
    expect(manager.isActive("x")).toBe(false);
    manager.start("x", 1, 1000, () => {});
    expect(manager.isActive("x")).toBe(true);
    manager.cancel("x");
    expect(manager.isActive("x")).toBe(false);
  });

  it("startVec3 + vec3Lerp で 3 成分同時補間する", () => {
    const manager = new TweenManager();
    const results: [number, number, number][] = [];
    manager.startVec3("pos", [10, 20, 30], 100, (v) => results.push(v), { from: [0, 0, 0] });
    manager.tick(0);
    manager.tick(50);
    manager.tick(100);
    expect(results[0]).toEqual([0, 0, 0]);
    expect(results[1]).toEqual([5, 10, 15]);
    expect(results[2]).toEqual([10, 20, 30]);
  });

  it("getActive が snapshot を返す", () => {
    const manager = new TweenManager();
    manager.start("a", 1, 1000, () => {});
    manager.start("b", 1, 500, () => {});
    const snapshot = manager.getActive();
    expect(snapshot.length).toBe(2);
    const keys = snapshot.map((e) => e.key).sort();
    expect(keys).toEqual(["a", "b"]);
  });

  it("TweenHandle.cancel で自分だけ cancel する", async () => {
    const manager = new TweenManager();
    const h1 = manager.start("a", 1, 1000, () => {});
    manager.start("b", 1, 1000, () => {});

    h1.cancel();
    await expect(h1.completion).resolves.toBeUndefined();
    expect(manager.isActive("a")).toBe(false);
    expect(manager.isActive("b")).toBe(true);
  });
});
