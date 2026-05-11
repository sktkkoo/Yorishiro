/**
 * Body primitive — unit tests for VRM-independent core logic.
 *
 * Tests ExpressionManager (weight budget), EyeSystem (idle + override),
 * BlinkSystem (blink timing), and utility functions.
 */

import { describe, expect, it } from "vitest";
import { BlinkSystem } from "./blink-system";
import { CursorAttentionSystem } from "./cursor-attention";
import {
  ExpressionManager,
  ExpressionSinkTracker,
  expressionTargetToName,
} from "./expression-manager";
import { EyeSystem, gazeTargetToAngles } from "./eye-system";
import { EyelidExpressionController } from "./eyelid-expression-controller";
import {
  IdleMicroexpressionSystem,
  MICRO_BROW_POOL,
  MICRO_EYE_POOL,
  MICRO_MORPH_POOL,
  MICRO_MOUTH_POOL,
} from "./idle-microexpression-system";
import { IdleSquintSystem } from "./idle-squint-system";

// ─── ExpressionManager ───────────────────────────────────

describe("ExpressionManager", () => {
  it("single expression: effective equals requested", () => {
    const mgr = new ExpressionManager();
    const id = mgr.addSlot("persona", "mood", "happy", 0.5);
    expect(mgr.getEffectiveWeight(id)).toBe(0.5);
  });

  it("two expressions under budget: no scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.3);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.4);
    expect(mgr.getEffectiveWeight(a)).toBe(0.3);
    expect(mgr.getEffectiveWeight(b)).toBe(0.4);
  });

  it("two expressions at exactly 1.0: no scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.6);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.4);
    expect(mgr.getEffectiveWeight(a)).toBe(0.6);
    expect(mgr.getEffectiveWeight(b)).toBe(0.4);
  });

  it("two expressions over budget: proportional scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.8);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.4);
    // total = 1.2, scale = 1/1.2
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.8 / 1.2);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(0.4 / 1.2);
    // Sum should be exactly 1
    expect(mgr.getEffectiveWeight(a) + mgr.getEffectiveWeight(b)).toBeCloseTo(1.0);
  });

  it("three expressions over budget: priority suppression + scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.5);
    const b = mgr.addSlot("mcp", "mood", "sad", 0.5);
    const c = mgr.addSlot("reflex", "eye", "surprised", 0.5);
    // mcp(3) > persona(2) in mood → persona suppressed
    // active: mcp/mood 0.5 + reflex/eye 0.5 = 1.0 → no scale-down
    expect(mgr.getEffectiveWeight(a)).toBe(0);
    expect(mgr.getEffectiveWeight(b)).toBe(0.5);
    expect(mgr.getEffectiveWeight(c)).toBe(0.5);
  });

  it("removing a slot gives remaining expressions more budget", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.8);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.4);
    // Over budget: a = 0.8/1.2, b = 0.4/1.2
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.8 / 1.2);

    mgr.removeSlot(b);
    // Now only a at 0.8, under budget
    expect(mgr.getEffectiveWeight(a)).toBe(0.8);
    expect(mgr.getEffectiveWeight(b)).toBe(0); // removed
  });

  it("setWeight updates effective weights", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.3);
    expect(mgr.getEffectiveWeight(a)).toBe(0.3);

    mgr.setWeight(a, 0.7);
    expect(mgr.getEffectiveWeight(a)).toBe(0.7);
  });

  it("setWeight triggers budget recomputation", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0.5);
    const b = mgr.addSlot("reflex", "eye", "sad", 0.3);
    // total 0.8 — under budget
    expect(mgr.getEffectiveWeight(a)).toBe(0.5);

    mgr.setWeight(a, 0.9);
    // total 1.2 — over budget now
    expect(mgr.getEffectiveWeight(a)).toBeCloseTo(0.9 / 1.2);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(0.3 / 1.2);
  });

  it("getResolved: higher priority source suppresses lower in same kind", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("persona", "mood", "happy", 0.3);
    mgr.addSlot("mcp", "mood", "happy", 0.2);
    mgr.addSlot("reflex", "eye", "sad", 0.1);

    // mcp(3) > persona(2) in mood → persona suppressed
    const resolved = mgr.getResolved();
    expect(resolved.get("happy")).toBeCloseTo(0.2);
    expect(resolved.get("sad")).toBeCloseTo(0.1);
  });

  it("empty manager: getResolved returns empty map", () => {
    const mgr = new ExpressionManager();
    expect(mgr.getResolved().size).toBe(0);
  });

  it("zero weight slot does not cause division by zero", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 0);
    expect(mgr.getEffectiveWeight(a)).toBe(0);
    expect(mgr.size).toBe(1);
  });

  it("setWeight on nonexistent ID is a no-op", () => {
    const mgr = new ExpressionManager();
    mgr.setWeight(999, 0.5); // should not throw
    expect(mgr.size).toBe(0);
  });

  it("removeSlot on nonexistent ID is a no-op", () => {
    const mgr = new ExpressionManager();
    mgr.removeSlot(999); // should not throw
    expect(mgr.size).toBe(0);
  });

  // ─── source / kind dedup ─────────────────────────────────

  it("per-(source, kind) dedup: same source+kind releases previous slot", () => {
    const mgr = new ExpressionManager();
    const first = mgr.addSlot("mcp", "mood", "happy", 0.6);
    const second = mgr.addSlot("mcp", "mood", "sad", 0.4);

    // first slot は dedup により release されている
    expect(mgr.getEffectiveWeight(first)).toBe(0);
    expect(mgr.getEffectiveWeight(second)).toBe(0.4);
    expect(mgr.size).toBe(1);
  });

  it("different sources, same kind: higher priority wins", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("persona", "mood", "happy", 0.3);
    mgr.addSlot("mcp", "mood", "happy", 0.4);
    // mcp(3) > persona(2) → persona suppressed
    expect(mgr.size).toBe(2);
    expect(mgr.getResolved().get("happy")).toBeCloseTo(0.4);
  });

  it("4 slots of different (source, kind): priority suppression + scale-down", () => {
    const mgr = new ExpressionManager();
    const a = mgr.addSlot("persona", "mood", "happy", 1);
    const b = mgr.addSlot("mcp", "mood", "sad", 1);
    const c = mgr.addSlot("reflex", "eye", "blink", 1);
    const d = mgr.addSlot("idle", "lip", "aa", 1);

    // mcp(3) > persona(2) in mood → persona suppressed
    // active: mcp/mood 1 + reflex/eye 1 + idle/lip 1 = 3 → scale 1/3
    expect(mgr.getEffectiveWeight(a)).toBe(0);
    expect(mgr.getEffectiveWeight(b)).toBeCloseTo(1 / 3);
    expect(mgr.getEffectiveWeight(c)).toBeCloseTo(1 / 3);
    expect(mgr.getEffectiveWeight(d)).toBeCloseTo(1 / 3);
  });

  it('source "reflex" suppresses "mcp" in same kind (reflex priority > mcp)', () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("mcp", "mood", "happy", 0.3);
    mgr.addSlot("reflex", "mood", "happy", 0.2);
    // reflex(4) > mcp(3) in mood → mcp suppressed
    expect(mgr.getResolved().get("happy")).toBeCloseTo(0.2);
  });

  it("getSlots returns snapshots with source / kind / weights", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("mcp", "mood", "happy", 0.7);
    mgr.addSlot("reflex", "eye", "blink", 0.4);

    const snaps = mgr.getSlots();
    expect(snaps).toHaveLength(2);
    const happy = snaps.find((s) => s.expressionName === "happy");
    const blink = snaps.find((s) => s.expressionName === "blink");
    expect(happy).toMatchObject({
      source: "mcp",
      kind: "mood",
      expressionName: "happy",
      requestedWeight: 0.7,
    });
    expect(blink).toMatchObject({
      source: "reflex",
      kind: "eye",
      expressionName: "blink",
      requestedWeight: 0.4,
    });
    // total 1.1 → scaled-down
    expect(happy?.effectiveWeight).toBeCloseTo(0.7 / 1.1);
    expect(blink?.effectiveWeight).toBeCloseTo(0.4 / 1.1);
  });

  it("detects active non-idle mood so Body can suspend idle overlays", () => {
    const mgr = new ExpressionManager();
    mgr.addSlot("idle", "mood", "neutral", 1);
    mgr.addSlot("idle", "custom", "relaxed", 0.4);
    expect(mgr.hasActiveNonIdleMood()).toBe(false);

    const happy = mgr.addSlot("persona", "mood", "happy", 0.6);
    expect(mgr.getEffectiveWeight(happy)).toBeCloseTo(0.6);
    expect(mgr.hasActiveNonIdleMood()).toBe(true);
  });

  it("ignores suppressed persona mood when a higher-priority mood owns the face", () => {
    const mgr = new ExpressionManager();
    const happy = mgr.addSlot("persona", "mood", "happy", 0.6);
    mgr.addSlot("mcp", "mood", "sad", 0.4);

    expect(mgr.getEffectiveWeight(happy)).toBe(0);
    expect(mgr.hasActiveNonIdleMood()).toBe(true);
  });
});

// ─── ExpressionSinkTracker ───────────────────────────────
//
// Body.applyExpressions の reset bug 対策。前 frame で書いた expression 名のうち、
// 今 frame の resolved に居ないものを sink 経由で 0 に戻す責務を担う。
// VRM 1.0 preset / viseme に限らず任意の blendshape 名（Fcl_* 等）も等しく扱う。

describe("ExpressionSinkTracker", () => {
  function recorder() {
    const writes: Array<[string, number]> = [];
    const sink = (name: string, weight: number) => {
      writes.push([name, weight]);
    };
    return { writes, sink };
  }

  it("first apply: writes every name in the batch", () => {
    const tracker = new ExpressionSinkTracker();
    const { writes, sink } = recorder();
    tracker.apply(
      new Map([
        ["happy", 0.5],
        ["aa", 0.3],
      ]),
      sink,
    );
    expect(writes).toHaveLength(2);
    expect(writes).toContainEqual(["happy", 0.5]);
    expect(writes).toContainEqual(["aa", 0.3]);
  });

  it("name dropped from batch on next apply gets zeroed via the sink", () => {
    const tracker = new ExpressionSinkTracker();
    tracker.apply(
      new Map([
        ["happy", 0.5],
        ["Fcl_BRW_Sorrow", 0.4],
      ]),
      () => {},
    );

    const { writes, sink } = recorder();
    tracker.apply(new Map([["happy", 0.5]]), sink);

    expect(writes).toContainEqual(["Fcl_BRW_Sorrow", 0]);
    expect(writes).toContainEqual(["happy", 0.5]);
  });

  it("name kept across frames is rewritten, never spuriously zeroed", () => {
    const tracker = new ExpressionSinkTracker();
    tracker.apply(new Map([["happy", 0.5]]), () => {});

    const { writes, sink } = recorder();
    tracker.apply(new Map([["happy", 0.3]]), sink);

    expect(writes).toEqual([["happy", 0.3]]);
  });

  it("empty batch after non-empty: zeroes everything written last frame", () => {
    const tracker = new ExpressionSinkTracker();
    tracker.apply(
      new Map([
        ["happy", 0.5],
        ["Fcl_BRW_Sorrow", 0.4],
      ]),
      () => {},
    );

    const { writes, sink } = recorder();
    tracker.apply(new Map(), sink);

    expect(writes).toHaveLength(2);
    expect(writes).toContainEqual(["happy", 0]);
    expect(writes).toContainEqual(["Fcl_BRW_Sorrow", 0]);
  });

  it("custom Fcl_* blendshapes are tracked the same as VRM 1.0 presets (regression)", () => {
    // ── Regression for the reset bug ─────────────────────────────────────
    // 旧 Body.applyExpressions は reset list が VRM 1.0 preset + visemes に
    // hardcode されており、Fcl_* 系 custom blendshape は slot release 後も
    // 直前の値を保持してしまっていた。tracker は名前を識別せず last-frame
    // tracking で zeroing するので、custom 名も等しく扱える。
    const tracker = new ExpressionSinkTracker();
    tracker.apply(new Map([["Fcl_EYE_Spread", 0.7]]), () => {});

    const { writes, sink } = recorder();
    tracker.apply(new Map(), sink);

    expect(writes).toEqual([["Fcl_EYE_Spread", 0]]);
  });

  it("re-adding a name after zeroing it works without leaking state", () => {
    const tracker = new ExpressionSinkTracker();
    tracker.apply(new Map([["Fcl_BRW_Joy", 0.6]]), () => {});
    tracker.apply(new Map(), () => {}); // zeroed here

    const { writes, sink } = recorder();
    tracker.apply(new Map([["Fcl_BRW_Joy", 0.4]]), sink);

    // 再 apply 時は zeroing は不要、新値だけ書く
    expect(writes).toEqual([["Fcl_BRW_Joy", 0.4]]);
  });
});

// ─── expressionTargetToName ──────────────────────────────

describe("expressionTargetToName", () => {
  it("maps mood preset", () => {
    expect(expressionTargetToName({ kind: "mood", preset: "happy" })).toBe("happy");
    expect(expressionTargetToName({ kind: "mood", preset: "sad" })).toBe("sad");
  });

  it("maps eye variant", () => {
    expect(expressionTargetToName({ kind: "eye", variant: "blink" })).toBe("blink");
    expect(expressionTargetToName({ kind: "eye", variant: "lookdown" })).toBe("lookdown");
  });

  it("maps lip phoneme", () => {
    expect(expressionTargetToName({ kind: "lip", phoneme: "aa" })).toBe("aa");
  });

  it("maps custom blendShapeName", () => {
    expect(expressionTargetToName({ kind: "custom", blendShapeName: "pout" })).toBe("pout");
  });

  it("maps part region+emotion to the Hana Tool Fcl_*_* morph name", () => {
    // 単発の sanity check
    expect(expressionTargetToName({ kind: "part", region: "brow", emotion: "sorrow" })).toBe(
      "Fcl_BRW_Sorrow",
    );
    expect(expressionTargetToName({ kind: "part", region: "eye", emotion: "joy" })).toBe(
      "Fcl_EYE_Joy",
    );
    expect(expressionTargetToName({ kind: "part", region: "mouth", emotion: "surprised" })).toBe(
      "Fcl_MTH_Surprised",
    );
  });

  it("part: every (region × emotion) combination resolves to the canonical Fcl_*_* name", () => {
    // 部位 prefix と emotion suffix の table と突き合わせる exhaustive check
    const REGION_PREFIX = { brow: "BRW", eye: "EYE", mouth: "MTH" } as const;
    const EMOTION_SUFFIX = {
      angry: "Angry",
      fun: "Fun",
      joy: "Joy",
      sorrow: "Sorrow",
      surprised: "Surprised",
    } as const;
    for (const region of ["brow", "eye", "mouth"] as const) {
      for (const emotion of ["angry", "fun", "joy", "sorrow", "surprised"] as const) {
        const name = expressionTargetToName({ kind: "part", region, emotion });
        expect(name).toBe(`Fcl_${REGION_PREFIX[region]}_${EMOTION_SUFFIX[emotion]}`);
      }
    }
  });
});

// ─── EyeSystem ───────────────────────────────────────────

describe("EyeSystem", () => {
  it("idle mode: output is within expected range", () => {
    const eye = new EyeSystem(() => 0.5);
    // Advance several seconds to trigger saccades
    for (let i = 0; i < 100; i++) eye.update(0.05);
    const out = eye.getOutput();
    expect(out.yaw).toBeGreaterThanOrEqual(-30);
    expect(out.yaw).toBeLessThanOrEqual(30);
    expect(out.pitch).toBeGreaterThanOrEqual(-25);
    expect(out.pitch).toBeLessThanOrEqual(25);
  });

  it("override: output matches override target", () => {
    const eye = new EyeSystem();
    eye.setOverride(15, -10);
    expect(eye.getOutput()).toEqual({ yaw: 15, pitch: -10 });
  });

  it("override pauses idle updates", () => {
    const eye = new EyeSystem(() => 0.5);
    // Get initial idle state
    for (let i = 0; i < 10; i++) eye.update(0.05);
    const beforeOverride = eye.getOutput();

    // Set override
    eye.setOverride(20, 5);
    expect(eye.getOutput()).toEqual({ yaw: 20, pitch: 5 });

    // Update several frames — idle should NOT advance
    for (let i = 0; i < 100; i++) eye.update(0.05);
    expect(eye.getOutput()).toEqual({ yaw: 20, pitch: 5 });

    // Release — should return to where idle was
    eye.releaseOverride(1); // first override ID is 1
    const afterRelease = eye.getOutput();
    // After release, idle resumes from paused state (same as beforeOverride)
    expect(afterRelease.yaw).toBeCloseTo(beforeOverride.yaw, 0);
    expect(afterRelease.pitch).toBeCloseTo(beforeOverride.pitch, 0);
  });

  it("new override replaces previous", () => {
    const eye = new EyeSystem();
    const id1 = eye.setOverride(10, 5);
    expect(eye.getOutput()).toEqual({ yaw: 10, pitch: 5 });

    const id2 = eye.setOverride(-15, 8);
    expect(eye.getOutput()).toEqual({ yaw: -15, pitch: 8 });
    expect(id2).not.toBe(id1);
  });

  it("stale override release has no effect", () => {
    const eye = new EyeSystem();
    const id1 = eye.setOverride(10, 5);
    eye.setOverride(-15, 8); // replaces id1

    eye.releaseOverride(id1); // stale — should be ignored
    expect(eye.getOutput()).toEqual({ yaw: -15, pitch: 8 });
    expect(eye.hasOverride).toBe(true);
  });

  it("hasOverride reflects state", () => {
    const eye = new EyeSystem();
    expect(eye.hasOverride).toBe(false);

    const id = eye.setOverride(0, 0);
    expect(eye.hasOverride).toBe(true);

    eye.releaseOverride(id);
    expect(eye.hasOverride).toBe(false);
  });

  it("ambient offset nudges idle and override gaze", () => {
    const eye = new EyeSystem(() => 0.5);
    eye.setAmbientOffset(8, 6);
    eye.update(1);
    const ambient = eye.getOutput();
    expect(ambient.yaw).toBeGreaterThan(0);
    expect(ambient.pitch).toBeGreaterThan(0);

    const id = eye.setOverride(2, -3);
    eye.update(1);
    expect(eye.getOutput()).toEqual({ yaw: 10, pitch: 3 });

    eye.releaseOverride(id);
    expect(eye.getOutput().yaw).toBeGreaterThan(0);
  });
});

// ─── CursorAttentionSystem ──────────────────────────────

describe("CursorAttentionSystem", () => {
  it("starts an episode after a randomized 8-15s delay", () => {
    const attention = new CursorAttentionSystem(() => 0);

    attention.update(7.9);
    expect(attention.isActive).toBe(false);

    attention.update(0.2);
    expect(attention.isActive).toBe(true);
    expect(attention.getOutput().mode).toBe("eyes");
  });

  it("triggerCursorAttention: episode starts immediately without waiting for ambient timer", () => {
    // ambient timer は 8〜15 秒だが trigger を呼ぶと即座に active になる
    const attention = new CursorAttentionSystem(() => 0);
    expect(attention.isActive).toBe(false);

    attention.triggerCursorAttention();
    expect(attention.isActive).toBe(true);
  });

  it("triggerCursorAttention: episode runs for the specified duration", () => {
    const attention = new CursorAttentionSystem(() => 0);
    attention.triggerCursorAttention(2.5);

    // 2.4 秒後はまだ active
    attention.update(2.4);
    expect(attention.isActive).toBe(true);

    // 2.5 秒を超えたら終了
    attention.update(0.2);
    expect(attention.isActive).toBe(false);
  });

  it("triggerCursorAttention: uses random duration when not specified", () => {
    // random が 0 → duration = DURATION_MIN_S = 1.0
    const attention = new CursorAttentionSystem(() => 0);
    attention.triggerCursorAttention();

    attention.update(0.9);
    expect(attention.isActive).toBe(true);

    attention.update(0.2);
    expect(attention.isActive).toBe(false);
  });

  it("triggerCursorAttention: emits start event with requested duration", () => {
    const events: unknown[] = [];
    const attention = new CursorAttentionSystem(
      () => 0,
      (e) => events.push(e),
    );

    attention.triggerCursorAttention(1.5);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "start", durationS: 1.5 });
  });

  it("source 変化検知パターン: 同 source の連続 snapshot では trigger は 1 回のみ", () => {
    // Body.initAttention の source-change ロジックを模倣したテスト
    let triggerCount = 0;
    const attention = new CursorAttentionSystem(() => 0);
    const origTrigger = attention.triggerCursorAttention.bind(attention);
    // triggerCursorAttention の呼び出し回数を計測するラッパー
    let lastSource: string | null = null;

    function handleSnapshot(source: string | null): void {
      if (source === null) {
        lastSource = null;
        return;
      }
      if (source !== lastSource) {
        triggerCount++;
        origTrigger();
      }
      lastSource = source;
    }

    // source A で 3 回連続 snapshot → trigger は 1 回
    handleSnapshot("mouse");
    handleSnapshot("mouse");
    handleSnapshot("mouse");
    expect(triggerCount).toBe(1);

    // source B に変化 → trigger が追加で 1 回
    handleSnapshot("terminal");
    expect(triggerCount).toBe(2);

    // null → source C → trigger が追加で 1 回
    handleSnapshot(null);
    handleSnapshot("input-cursor");
    expect(triggerCount).toBe(3);
  });

  it("briefly follows the pointer with a delayed, subtle output", () => {
    const values = [0, 0.5, 0.9];
    const attention = new CursorAttentionSystem(() => values.shift() ?? 0.5);

    attention.update(8);
    attention.setPointerPositionFromHead(1000, 0, 500, 500, 1000, 1000);
    attention.update(1 / 60);

    const out = attention.getOutput();
    expect(out.mode).toBe("both");
    expect(out.eyeYawDeg).toBeGreaterThan(0);
    expect(out.eyeYawDeg).toBeLessThan(72);
    expect(out.headYawRad).toBeGreaterThan(0);
    expect(out.headPitchRad).toBeGreaterThan(0);
  });

  it("computes pointer direction from the projected head position", () => {
    const values = [0, 0.5, 0.9];
    const attention = new CursorAttentionSystem(() => values.shift() ?? 0.5);

    attention.update(8);
    attention.setPointerPositionFromHead(700, 300, 500, 500, 1000, 1000);
    attention.update(1);

    const snapshot = attention.getDebugSnapshot();
    expect(snapshot.targetX).toBeGreaterThan(0);
    expect(snapshot.targetY).toBeGreaterThan(0);

    const out = attention.getOutput();
    expect(out.eyeYawDeg).toBeGreaterThan(0);
    expect(out.eyePitchDeg).toBeLessThan(0);
    expect(out.headYawRad).toBeGreaterThan(0);
    expect(out.headPitchRad).toBeGreaterThan(0);
  });

  it("applies eye output from the current target without lag", () => {
    const values = [0, 0.5, 0];
    const attention = new CursorAttentionSystem(() => values.shift() ?? 0.5);

    attention.update(8);
    attention.update(0.3);
    attention.setPointerPositionFromHead(850, 500, 500, 500, 1000, 1000);

    const out = attention.getOutput();
    const snapshot = attention.getDebugSnapshot();
    expect(snapshot.targetX).toBe(1);
    expect(snapshot.lagX).toBeLessThan(1);
    expect(out.eyeYawDeg).toBeCloseTo(56);
  });

  // ─── ambientGate ─────────────────────────────────────────

  it("ambientGate が true を返す場合: ambient タイマー発火で episode が開始する", () => {
    // random=0 → delay=8s、duration=1s
    const attention = new CursorAttentionSystem(
      () => 0,
      undefined,
      () => true,
    );

    attention.update(8.1);
    expect(attention.isActive).toBe(true);
  });

  it("ambientGate が false を返す場合: ambient タイマー発火で episode をスキップしタイマーをリセット", () => {
    // random=0 → delay=8s
    const attention = new CursorAttentionSystem(
      () => 0,
      undefined,
      () => false,
    );

    attention.update(8.1);
    // episode はスキップされる
    expect(attention.isActive).toBe(false);

    // タイマーが再セットされているため、さらに 8 秒待っても gate=false なら再スキップ
    attention.update(8.1);
    expect(attention.isActive).toBe(false);
  });

  it("ambientGate が undefined の場合: 後方互換で episode が開始する", () => {
    // gate 未指定 → 従来通り動作
    const attention = new CursorAttentionSystem(() => 0);

    attention.update(8.1);
    expect(attention.isActive).toBe(true);
  });

  it("triggerCursorAttention は gate=false でも episode を開始する（ゲート無視）", () => {
    // ambient gate は常に false だが、直接 trigger は通る
    const attention = new CursorAttentionSystem(
      () => 0,
      undefined,
      () => false,
    );

    // ambient では発火しない
    attention.update(8.1);
    expect(attention.isActive).toBe(false);

    // 直接 trigger → gate を無視して即時 episode 開始
    attention.triggerCursorAttention();
    expect(attention.isActive).toBe(true);
  });

  it("logs start and end events with duration and next delay", () => {
    const events: unknown[] = [];
    const values = [0, 0, 0.49, 1];
    const attention = new CursorAttentionSystem(
      () => values.shift() ?? 0,
      (event) => events.push(event),
    );

    attention.update(8);
    expect(events).toEqual([{ kind: "start", mode: "eyes", durationS: 1, nextDelayS: null }]);

    attention.update(1.1);
    expect(events).toEqual([
      { kind: "start", mode: "eyes", durationS: 1, nextDelayS: null },
      { kind: "end", mode: "eyes", durationS: 1, nextDelayS: 15 },
    ]);
  });
});

// ─── IdleSquintSystem ───────────────────────────────────

describe("IdleSquintSystem", () => {
  it("starts a subtle squint after a randomized idle delay", () => {
    const squint = new IdleSquintSystem(() => 1);

    expect(squint.update(21.9, true)).toBe(0);
    expect(squint.isActive).toBe(false);

    expect(squint.update(0.2, true)).toBe(0);
    expect(squint.isActive).toBe(true);

    const value = squint.update(0.08, true);
    expect(value).toBeGreaterThan(0);
    expect(value).toBeLessThanOrEqual(0.3);
  });

  it("randomizes each episode strength between 0.1 and 0.3", () => {
    const values = [0, 0, 0, 0, 0, 1];
    const squint = new IdleSquintSystem(() => values.shift() ?? 0);

    squint.update(8.1, true);
    squint.update(0.2, true);
    expect(squint.value).toBeCloseTo(0.1);

    squint.update(0.3, true);
    squint.update(8.1, true);
    squint.update(0.2, true);
    expect(squint.value).toBeCloseTo(0.3);
  });

  it("clears immediately when idle is disabled", () => {
    const squint = new IdleSquintSystem(() => 0);

    squint.update(8.1, true);
    squint.update(0.1, true);
    expect(squint.value).toBeGreaterThan(0);

    expect(squint.update(0.1, false)).toBe(0);
    expect(squint.value).toBe(0);
    expect(squint.isActive).toBe(false);
  });

  it("fades out and schedules another episode after duration", () => {
    const squint = new IdleSquintSystem(() => 0);

    squint.update(8.1, true);
    squint.update(0.1, true);
    expect(squint.value).toBeGreaterThan(0);

    expect(squint.update(0.4, true)).toBe(0);
    expect(squint.isActive).toBe(false);
  });
});

// ─── IdleMicroexpressionSystem ──────────────────────────
//
// Idle 中の Fcl_* morph 微震えで「神経の入った顔」を作る反射層。
// IdleSquintSystem に近いが、複数 morph を pool から選ぶ点と、
// (source, kind, name) ではなく event 形 ({morph, weight}) を返す点が違う。

describe("IdleMicroexpressionSystem", () => {
  it("starts inactive, only emits after the cooldown elapses", () => {
    const micro = new IdleMicroexpressionSystem(() => 0);
    // random=0 → cooldown=NEXT_MIN_S 相当
    expect(micro.update(0.5, true)).toBeNull();
    // cooldown を十分越える delta
    const event = micro.update(2.0, true);
    expect(event).not.toBeNull();
  });

  it("emits a morph from the configured pool", () => {
    const micro = new IdleMicroexpressionSystem(() => 0);
    micro.update(2.0, true);
    const event = micro.update(0.05, true);
    expect(event).not.toBeNull();
    if (event) {
      expect(MICRO_MORPH_POOL).toContain(event.morph);
    }
  });

  it("weight is positive during the episode and stays within configured bounds", () => {
    // random sequence で「最大 weight、最大 duration、最後の morph」を狙う
    const values = [0.999, 0.999, 0.999, 0.999];
    const micro = new IdleMicroexpressionSystem(() => values.shift() ?? 0);
    micro.update(4.1, true); // 越えれば始まる
    const event = micro.update(0.15, true); // fade window 内
    expect(event).not.toBeNull();
    if (event) {
      expect(event.weight).toBeGreaterThan(0);
      // 振幅上限は WEIGHT_MAX (=0.22)。fade window 中なので fade 倍率 ≤ 1。
      expect(event.weight).toBeLessThanOrEqual(0.22);
    }
  });

  it("disabling immediately clears any active event", () => {
    const micro = new IdleMicroexpressionSystem(() => 0);
    micro.update(2.0, true);
    micro.update(0.1, true);
    expect(micro.value).not.toBeNull();

    const next = micro.update(0.05, false);
    expect(next).toBeNull();
    expect(micro.value).toBeNull();
  });

  it("emits null after the episode duration elapses and schedules another", () => {
    const micro = new IdleMicroexpressionSystem(() => 0);
    micro.update(2.0, true); // start
    expect(micro.value).not.toBeNull();
    // random=0 → DURATION_MIN_S 短め (=0.25s)。十分越えれば終了。
    const after = micro.update(0.4, true);
    expect(after).toBeNull();
  });

  it("picks different morphs across episodes when randomness varies", () => {
    // 2 episode 観察: 1 回目は morph index=0、2 回目は最終 index
    const values = [
      0, // cooldown1
      0, // duration1
      0, // weight1
      0, // morph idx1 = 0
      0, // cooldown2
      0, // duration2
      0, // weight2
      0.99, // morph idx2 = pool.length-1
    ];
    const micro = new IdleMicroexpressionSystem(() => values.shift() ?? 0);

    micro.update(2.0, true);
    const first = micro.update(0.05, true);
    expect(first?.morph).toBe(MICRO_MORPH_POOL[0]);

    // 1 回目終了 + 2 回目開始
    micro.update(0.4, true);
    micro.update(2.0, true);
    const second = micro.update(0.05, true);
    expect(second?.morph).toBe(MICRO_MORPH_POOL[MICRO_MORPH_POOL.length - 1]);
  });
});

// ─── MICRO_*_POOL composition ────────────────────────────
//
// Pool 自体の中身が user-facing な振る舞いを決める（眉だけ動く、目だけ動く、口だけ動く、
// asymmetric が出る等）。各 region で「必須 morph が含まれている」ことを test として
// 固定する。Pool を入れ替えた時にここで気づける。

describe("MICRO_BROW_POOL", () => {
  it("contains Fcl_BRW_* emotion variants only", () => {
    for (const name of MICRO_BROW_POOL) {
      expect(name.startsWith("Fcl_BRW_")).toBe(true);
    }
  });
});

describe("MICRO_EYE_POOL", () => {
  it("contains Fcl_EYE_* variants only", () => {
    for (const name of MICRO_EYE_POOL) {
      expect(name.startsWith("Fcl_EYE_")).toBe(true);
    }
  });

  it("includes asymmetric L/R variants for wink-like twitches", () => {
    expect(MICRO_EYE_POOL).toContain("Fcl_EYE_Close_L");
    expect(MICRO_EYE_POOL).toContain("Fcl_EYE_Close_R");
    expect(MICRO_EYE_POOL).toContain("Fcl_EYE_Joy_L");
    expect(MICRO_EYE_POOL).toContain("Fcl_EYE_Joy_R");
  });
});

describe("MICRO_MOUTH_POOL", () => {
  it("contains Fcl_MTH_* variants only", () => {
    for (const name of MICRO_MOUTH_POOL) {
      expect(name.startsWith("Fcl_MTH_")).toBe(true);
    }
  });

  it("includes shapes for silent mouth life: small / close / up / down", () => {
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Small");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Close");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Up");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Down");
  });

  it("includes への字 morph (Fcl_MTH_Angry) and a slight-smile morph (Fcl_MTH_Joy)", () => {
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Angry");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_Joy");
  });

  it("includes asymmetric SkinFung L/R for one-sided smirk", () => {
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_SkinFung_L");
    expect(MICRO_MOUTH_POOL).toContain("Fcl_MTH_SkinFung_R");
  });

  it("does not include visemes (aa/ih/ou/ee/oh) — lip sync owns those", () => {
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_A");
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_I");
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_U");
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_E");
    expect(MICRO_MOUTH_POOL).not.toContain("Fcl_MTH_O");
  });
});

describe("MICRO_MORPH_POOL (backward-compat aggregate)", () => {
  it("is the union of the three region pools", () => {
    const expected = new Set([...MICRO_BROW_POOL, ...MICRO_EYE_POOL, ...MICRO_MOUTH_POOL]);
    const actual = new Set(MICRO_MORPH_POOL);
    expect(actual).toEqual(expected);
  });
});

// ─── EyelidExpressionController ─────────────────────────

describe("EyelidExpressionController", () => {
  it("applies idle squint as blink while reducing neutral budget", () => {
    const expressions = new ExpressionManager();
    const blink = new BlinkSystem(() => 0);
    const squint = new IdleSquintSystem(() => 0);
    const eyelids = new EyelidExpressionController(expressions, blink, squint);
    const neutralSlot = expressions.addSlot("idle", "mood", "neutral", 1);

    eyelids.update(0, 8.1, {
      idle: true,
      explicitBlinkActive: false,
      relaxedValue: 0,
      neutralSlotId: neutralSlot,
    });
    eyelids.update(0, 0.2, {
      idle: true,
      explicitBlinkActive: false,
      relaxedValue: 0,
      neutralSlotId: neutralSlot,
    });

    const resolved = expressions.getResolved();
    expect(resolved.get("blink")).toBeCloseTo(0.1);
    expect(expressions.getRequestedWeight(neutralSlot)).toBeCloseTo(0.9);
    expect(blink.isSuppressed).toBe(true);
  });

  it("does not start idle squint while an explicit blink is active", () => {
    const expressions = new ExpressionManager();
    const blink = new BlinkSystem(() => 0);
    const squint = new IdleSquintSystem(() => 0);
    const eyelids = new EyelidExpressionController(expressions, blink, squint);
    const neutralSlot = expressions.addSlot("idle", "mood", "neutral", 1);

    eyelids.update(0, 6.1, {
      idle: true,
      explicitBlinkActive: true,
      relaxedValue: 0,
      neutralSlotId: neutralSlot,
    });
    eyelids.update(0, 0.3, {
      idle: true,
      explicitBlinkActive: true,
      relaxedValue: 0,
      neutralSlotId: neutralSlot,
    });

    expect(expressions.getResolved().get("blink")).toBeUndefined();
    expect(blink.isSuppressed).toBe(false);
  });
});

// ─── gazeTargetToAngles ──────────────────────────────────

describe("gazeTargetToAngles", () => {
  it("camera: looks straight ahead", () => {
    const out = gazeTargetToAngles({ kind: "camera" });
    expect(out.yaw).toBe(0);
    expect(out.pitch).toBe(0);
  });

  it("away: non-zero yaw", () => {
    const out = gazeTargetToAngles({ kind: "away" }, () => 0.8);
    expect(Math.abs(out.yaw)).toBeGreaterThan(10);
  });

  it("point: forward direction gives ~0 yaw", () => {
    const out = gazeTargetToAngles({ kind: "point", direction: { x: 0, y: 0, z: 1 } });
    expect(out.yaw).toBeCloseTo(0, 0);
    expect(out.pitch).toBeCloseTo(0, 0);
  });

  it("point: right direction gives positive yaw", () => {
    const out = gazeTargetToAngles({ kind: "point", direction: { x: 1, y: 0, z: 1 } });
    expect(out.yaw).toBeGreaterThan(0);
  });

  it("screen-element: approximated as downward gaze", () => {
    const out = gazeTargetToAngles({ kind: "screen-element", selector: ".terminal" });
    expect(out.pitch).toBeLessThan(0); // looking down
  });
});

// ─── BlinkSystem ─────────────────────────────────────────

describe("BlinkSystem", () => {
  it("starts with value 0", () => {
    const blink = new BlinkSystem();
    expect(blink.value).toBe(0);
  });

  it("eventually produces a blink (value reaches 1.0)", () => {
    const blink = new BlinkSystem(() => 0); // min random → shortest interval
    let maxValue = 0;
    // Run for 10 seconds of simulated time
    for (let i = 0; i < 600; i++) {
      const v = blink.update(1 / 60);
      if (v > maxValue) maxValue = v;
    }
    expect(maxValue).toBe(1.0);
  });

  it("returns to 0 after blink completes", () => {
    const blink = new BlinkSystem(() => 0);
    // Fast forward until blink starts and finishes
    for (let i = 0; i < 600; i++) blink.update(1 / 60);
    // After enough time, should be back at 0
    for (let i = 0; i < 120; i++) blink.update(1 / 60);
    // Should have returned to 0 at some point
    expect(blink.value).toBe(0);
  });

  it("suppress stops blink generation", () => {
    const blink = new BlinkSystem(() => 0);
    blink.suppress();
    // Run for several seconds
    for (let i = 0; i < 600; i++) blink.update(1 / 60);
    expect(blink.value).toBe(0);
  });

  it("resume after suppress restarts blink cycle", () => {
    const blink = new BlinkSystem(() => 0);
    const token = blink.suppress();
    blink.resume(token);
    let maxValue = 0;
    for (let i = 0; i < 600; i++) {
      const v = blink.update(1 / 60);
      if (v > maxValue) maxValue = v;
    }
    expect(maxValue).toBe(1.0);
  });

  it("keeps blink suppressed until every suppression token is released", () => {
    const blink = new BlinkSystem(() => 0);
    const tokenA = blink.suppress();
    const tokenB = blink.suppress();

    blink.resume(tokenA);
    expect(blink.isSuppressed).toBe(true);
    for (let i = 0; i < 600; i++) blink.update(1 / 60);
    expect(blink.value).toBe(0);

    blink.resume(tokenB);
    expect(blink.isSuppressed).toBe(false);
  });

  it("values stay in [0, 1] range", () => {
    const blink = new BlinkSystem();
    for (let i = 0; i < 3600; i++) {
      const v = blink.update(1 / 60);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
