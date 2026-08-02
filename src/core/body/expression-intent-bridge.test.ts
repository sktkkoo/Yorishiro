/**
 * ExpressionIntentResolver / SlotBridge / shadow comparison の unit tests
 * （#83 M2）。
 *
 * resolver の direct-target 分類、keyed slot の独立 dedup、bridge の差分
 * 同期（add / update / remove、owner handle 一つでの回収）、shadow diff の
 * 検出を固定する。
 */

import { describe, expect, it } from "vitest";
import type { AdmittedExpressionIntent } from "./expression-intent";
import { ExpressionIntentArbiter } from "./expression-intent-arbiter";
import { buildExpressionIntentDebugView } from "./expression-intent-debug";
import {
  EYELID_PHYSIOLOGY_OCCUPANCY,
  FULL_FACE_AFFECT_OCCUPANCY,
} from "./expression-intent-policy";
import { ExpressionIntentResolver } from "./expression-intent-resolver";
import { collectShadowExpectations, diffShadowAgainstSlots } from "./expression-intent-shadow";
import { ExpressionIntentSlotBridge } from "./expression-intent-slot-bridge";
import { ExpressionManager } from "./expression-manager";

function admitted(overrides: Partial<AdmittedExpressionIntent> = {}): AdmittedExpressionIntent {
  return {
    intentId: "intent-1",
    source: "idle",
    semantic: { role: "baseline", target: "neutral" },
    occupancy: FULL_FACE_AFFECT_OCCUPANCY,
    effectiveIntensity: 1,
    ...overrides,
  };
}

function resolveOne(
  resolver: ExpressionIntentResolver,
  intent: AdmittedExpressionIntent,
): { kind: string; name: string; weight: number } | null {
  let result: { kind: string; name: string; weight: number } | null = null;
  const ok = resolver.resolve(intent, (kind, name, weight) => {
    result = { kind, name, weight };
  });
  return ok ? result : null;
}

// ─── resolver ────────────────────────────────────────────

describe("ExpressionIntentResolver", () => {
  const resolver = new ExpressionIntentResolver();

  it("semantic.state は host 共通 mapping で mood に解決される", () => {
    const result = resolveOne(
      resolver,
      admitted({
        source: "speech",
        semantic: { role: "grounded-state", state: "happy" },
        effectiveIntensity: 0.4,
      }),
    );
    expect(result).toEqual({ kind: "mood", name: "happy", weight: 0.4 });
  });

  it("full-face occupancy の VRM preset target は mood、部分 occupancy は custom", () => {
    expect(
      resolveOne(resolver, admitted({ semantic: { role: "baseline", target: "neutral" } })),
    ).toEqual({ kind: "mood", name: "neutral", weight: 1 });
    // relaxed は eye 周辺のみの occupancy なので legacy と同じ custom になる
    expect(
      resolveOne(
        resolver,
        admitted({
          semantic: { role: "baseline", target: "relaxed" },
          occupancy: [{ region: "eye", lane: "affect" }],
          effectiveIntensity: 0.3,
        }),
      ),
    ).toEqual({ kind: "custom", name: "relaxed", weight: 0.3 });
  });

  it("blink / viseme / Fcl morph は legacy kind に合わせて分類される", () => {
    expect(
      resolveOne(
        resolver,
        admitted({
          semantic: { role: "baseline", target: "blink" },
          occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
        }),
      ),
    ).toEqual({ kind: "eye", name: "blink", weight: 1 });
    expect(
      resolveOne(
        resolver,
        admitted({
          semantic: { role: "grounded-state", target: "aa" },
          occupancy: [{ region: "mouth", lane: "articulation" }],
        }),
      ),
    ).toEqual({ kind: "lip", name: "aa", weight: 1 });
    // baseline の Fcl morph（idle micro）は legacy 通り custom
    expect(
      resolveOne(
        resolver,
        admitted({
          semantic: { role: "baseline", target: "Fcl_BRW_Joy" },
          occupancy: [{ region: "brow", lane: "affect" }],
          effectiveIntensity: 0.15,
        }),
      ),
    ).toEqual({ kind: "custom", name: "Fcl_BRW_Joy", weight: 0.15 });
    // 明示 action の Fcl morph（persona part 指定）は part-{region}
    expect(
      resolveOne(
        resolver,
        admitted({
          source: "persona",
          semantic: { role: "explicit-action", target: "Fcl_BRW_Sorrow" },
          occupancy: [{ region: "brow", lane: "affect" }],
        }),
      ),
    ).toEqual({ kind: "part-brow", name: "Fcl_BRW_Sorrow", weight: 1 });
  });

  it("state 無し・target 無し、または occupancy 無しの未知 target は unmapped", () => {
    expect(resolveOne(resolver, admitted({ semantic: { role: "baseline" } }))).toBeNull();
    expect(
      resolveOne(
        resolver,
        admitted({ semantic: { role: "baseline", target: "MysteryMorph" }, occupancy: [] }),
      ),
    ).toBeNull();
  });
});

// ─── keyed slot ──────────────────────────────────────────

describe("ExpressionManager keyed slots", () => {
  it("keyed slot は legacy の (source, kind) dedup に参加しない", () => {
    const mgr = new ExpressionManager();
    const keyed = mgr.addKeyedSlot("intent-1:mood:neutral", "idle", "mood", "neutral", 1);
    // legacy addSlot は keyed slot を蹴らない
    const legacy = mgr.addSlot("idle", "mood", "neutral", 0.5);
    expect(mgr.getRequestedWeight(keyed)).toBe(1);
    expect(mgr.getRequestedWeight(legacy)).toBe(0.5);
    expect(mgr.size).toBe(2);
    // 同じ key の再登録は replace になる
    const replaced = mgr.addKeyedSlot("intent-1:mood:neutral", "idle", "mood", "neutral", 0.7);
    expect(mgr.getRequestedWeight(keyed)).toBe(0);
    expect(mgr.getRequestedWeight(replaced)).toBe(0.7);
    expect(mgr.size).toBe(2);
  });

  it("keyed slot も source priority と weight budget の対象になる", () => {
    const mgr = new ExpressionManager();
    const idleKeyed = mgr.addKeyedSlot("intent-1:mood:neutral", "idle", "mood", "neutral", 0.8);
    const persona = mgr.addSlot("persona", "mood", "happy", 0.8);
    // 同 kind 内の source priority 抑止は keyed slot にも効く
    expect(mgr.getEffectiveWeight(idleKeyed)).toBe(0);
    expect(mgr.getEffectiveWeight(persona)).toBeCloseTo(0.8);

    // budget scale も共通（persona mood 0.8 + persona keyed custom 0.4 = 1.2 → scale）
    const keyedCustom = mgr.addKeyedSlot(
      "intent-2:custom:Fcl_BRW_Joy",
      "persona",
      "custom",
      "Fcl_BRW_Joy",
      0.4,
    );
    expect(mgr.getEffectiveWeight(persona)).toBeCloseTo(0.8 / 1.2);
    expect(mgr.getEffectiveWeight(keyedCustom)).toBeCloseTo(0.4 / 1.2);
  });

  it("getSlots は keyed slot の key を公開する", () => {
    const mgr = new ExpressionManager();
    mgr.addKeyedSlot("intent-9:mood:happy", "speech", "mood", "happy", 0.5);
    mgr.addSlot("idle", "mood", "neutral", 1);
    const keys = mgr.getSlots().map((s) => s.key);
    expect(keys).toContain("intent-9:mood:happy");
    expect(keys).toContain(undefined);
  });
});

// ─── slot bridge ─────────────────────────────────────────

describe("ExpressionIntentSlotBridge", () => {
  it("admitted の差分を add / update / remove として manager に同期する", () => {
    const mgr = new ExpressionManager();
    const bridge = new ExpressionIntentSlotBridge(mgr, new ExpressionIntentResolver());
    const arbiter = new ExpressionIntentArbiter();

    const handle = arbiter.acquire({
      owner: { producerId: "state-base", scopeId: "state-idle" },
      source: "idle",
      semantic: { role: "baseline", target: "neutral" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "ambient",
      intensity: 1,
      lifecycle: { kind: "held" },
    });

    bridge.sync(arbiter.getAdmitted());
    expect(mgr.getSlots()).toHaveLength(1);
    expect(mgr.getSlots()[0]).toMatchObject({
      source: "idle",
      kind: "mood",
      expressionName: "neutral",
      requestedWeight: 1,
    });

    // intensity 更新は同じ slot の weight 更新になる（slot 数は不変）
    handle.updateIntensity(0.6);
    bridge.sync(arbiter.getAdmitted());
    expect(mgr.getSlots()).toHaveLength(1);
    expect(mgr.getSlots()[0]?.requestedWeight).toBeCloseTo(0.6);

    // release で admitted から消えると bridge が slot を回収する
    handle.release();
    bridge.sync(arbiter.getAdmitted());
    expect(mgr.getSlots()).toHaveLength(0);
    expect(bridge.size).toBe(0);
  });

  it("suppress された intent の slot は回収され、復帰で再作成される", () => {
    const mgr = new ExpressionManager();
    const bridge = new ExpressionIntentSlotBridge(mgr, new ExpressionIntentResolver());
    const arbiter = new ExpressionIntentArbiter();

    arbiter.acquire({
      owner: { producerId: "state-base", scopeId: "state-idle" },
      source: "idle",
      semantic: { role: "baseline", target: "neutral" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "ambient",
      intensity: 1,
      lifecycle: { kind: "held" },
    });
    bridge.sync(arbiter.getAdmitted());
    expect(mgr.size).toBe(1);

    const speech = arbiter.acquire({
      owner: { producerId: "speech-mood", scopeId: "u1" },
      source: "speech",
      semantic: { role: "grounded-state", state: "happy" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "grounded",
      intensity: 0.5,
      lifecycle: { kind: "held" },
    });
    bridge.sync(arbiter.getAdmitted());
    // idle は suppress されて slot 回収、speech の slot だけが残る
    expect(mgr.getSlots().map((s) => s.expressionName)).toEqual(["happy"]);

    speech.release();
    bridge.sync(arbiter.getAdmitted());
    expect(mgr.getSlots().map((s) => s.expressionName)).toEqual(["neutral"]);
  });

  it("unmapped intent は slot を作らず観察用に記録される", () => {
    const mgr = new ExpressionManager();
    const bridge = new ExpressionIntentSlotBridge(mgr, new ExpressionIntentResolver());
    const arbiter = new ExpressionIntentArbiter();

    const handle = arbiter.acquire({
      owner: { producerId: "mystery", scopeId: "s1" },
      source: "mcp",
      semantic: { role: "explicit-action" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "explicit",
      intensity: 1,
      lifecycle: { kind: "held" },
    });
    bridge.sync(arbiter.getAdmitted());
    expect(mgr.size).toBe(0);
    expect(bridge.getUnmappedIntentIds().has(handle.intentId)).toBe(true);
  });
});

// ─── debug facade（#83 M6）───────────────────────────────

describe("buildExpressionIntentDebugView", () => {
  function makeJoined(): {
    arbiter: ExpressionIntentArbiter;
    mgr: ExpressionManager;
    bridge: ExpressionIntentSlotBridge;
  } {
    const mgr = new ExpressionManager();
    const bridge = new ExpressionIntentSlotBridge(mgr, new ExpressionIntentResolver());
    const arbiter = new ExpressionIntentArbiter();
    return { arbiter, mgr, bridge };
  }

  it("total weight > 1 は manager が一度だけ scale し、budget-scaled として説明できる", () => {
    const { arbiter, mgr, bridge } = makeJoined();
    arbiter.acquire({
      owner: { producerId: "speech-mood", scopeId: "u1" },
      source: "speech",
      semantic: { role: "grounded-state", state: "happy" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "grounded",
      intensity: 0.8,
      lifecycle: { kind: "held" },
    });
    arbiter.acquire({
      owner: { producerId: "auto-blink", scopeId: "auto" },
      source: "reflex",
      semantic: { role: "baseline", target: "blink" },
      occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
      salience: "reflex",
      intensity: 0.6,
      lifecycle: { kind: "held" },
    });
    bridge.sync(arbiter.getAdmitted());

    // 合計 1.4 > 1 → 一度だけ proportional scale（同率）
    const view = buildExpressionIntentDebugView(arbiter.getSnapshot(), mgr.getSlots());
    const moodEntry = view.intents.find((i) => i.owner.producerId === "speech-mood");
    const blinkEntry = view.intents.find((i) => i.owner.producerId === "auto-blink");
    expect(moodEntry?.contributions[0]).toMatchObject({
      expressionName: "happy",
      numericNote: "budget-scaled",
    });
    expect(moodEntry?.contributions[0]?.effectiveWeight).toBeCloseTo(0.8 / 1.4);
    expect(blinkEntry?.contributions[0]?.effectiveWeight).toBeCloseTo(0.6 / 1.4);
    expect(view.legacySlots).toHaveLength(0);
  });

  it("migration 中の manager compatibility priority による抑止を manager-suppressed として説明する", () => {
    const { arbiter, mgr, bridge } = makeJoined();
    arbiter.acquire({
      owner: { producerId: "state-base", scopeId: "state-idle" },
      source: "idle",
      semantic: { role: "baseline", target: "neutral" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "ambient",
      intensity: 1,
      lifecycle: { kind: "held" },
    });
    bridge.sync(arbiter.getAdmitted());
    // legacy 経路の persona mood が同 kind に居ると manager priority が idle を抑止する
    mgr.addSlot("persona", "mood", "happy", 0.5);

    const view = buildExpressionIntentDebugView(arbiter.getSnapshot(), mgr.getSlots());
    const stateBase = view.intents.find((i) => i.owner.producerId === "state-base");
    expect(stateBase?.phase).toBe("active");
    expect(stateBase?.contributions[0]?.numericNote).toBe("manager-suppressed");
    // intent 経路外の legacy slot は legacySlots に分離される
    expect(view.legacySlots.map((s) => s.expressionName)).toEqual(["happy"]);
  });

  it("解決できなかった intent は unmapped-target として表示される", () => {
    const { arbiter, mgr, bridge } = makeJoined();
    const handle = arbiter.acquire({
      owner: { producerId: "mystery", scopeId: "s1" },
      source: "mcp",
      semantic: { role: "explicit-action" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "explicit",
      intensity: 1,
      lifecycle: { kind: "held" },
    });
    bridge.sync(arbiter.getAdmitted());

    const view = buildExpressionIntentDebugView(
      arbiter.getSnapshot(),
      mgr.getSlots(),
      bridge.getUnmappedIntentIds(),
    );
    const entry = view.intents.find((i) => i.intentId === handle.intentId);
    expect(entry?.reason).toBe("unmapped-target");
    expect(entry?.contributions).toHaveLength(0);
  });
});

// ─── shadow comparison ───────────────────────────────────

describe("expression intent shadow comparison", () => {
  it("intent 経路と legacy slot が一致していれば diff は空", () => {
    const arbiter = new ExpressionIntentArbiter();
    const resolver = new ExpressionIntentResolver();
    arbiter.acquire({
      owner: { producerId: "state-base", scopeId: "state-idle" },
      source: "idle",
      semantic: { role: "baseline", target: "neutral" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "ambient",
      intensity: 1,
      lifecycle: { kind: "held" },
    });

    const mgr = new ExpressionManager();
    mgr.addSlot("idle", "mood", "neutral", 1);

    const expectations = collectShadowExpectations(arbiter.getAdmitted(), resolver);
    const diffs = diffShadowAgainstSlots(
      expectations,
      mgr.getSlots(),
      (slot) => slot.source === "idle" && slot.key === undefined,
    );
    expect(diffs).toEqual([]);
  });

  it("weight のずれ・legacy 側欠落・intent 側欠落を検出する", () => {
    const arbiter = new ExpressionIntentArbiter();
    const resolver = new ExpressionIntentResolver();
    arbiter.acquire({
      owner: { producerId: "state-base", scopeId: "state-idle" },
      source: "idle",
      semantic: { role: "baseline", target: "neutral" },
      occupancy: FULL_FACE_AFFECT_OCCUPANCY,
      salience: "ambient",
      intensity: 0.4,
      lifecycle: { kind: "held" },
    });

    const mgr = new ExpressionManager();
    mgr.addSlot("idle", "mood", "neutral", 1);
    mgr.addSlot("idle", "custom", "relaxed", 0.3);

    const expectations = collectShadowExpectations(arbiter.getAdmitted(), resolver);
    const diffs = diffShadowAgainstSlots(
      expectations,
      mgr.getSlots(),
      (slot) => slot.source === "idle" && slot.key === undefined,
    );
    expect(diffs.some((d) => d.includes("weight mismatch") && d.includes("neutral"))).toBe(true);
    expect(diffs.some((d) => d.includes("legacy-only") && d.includes("relaxed"))).toBe(true);

    const emptyDiffs = diffShadowAgainstSlots(expectations, [], () => true);
    expect(emptyDiffs.some((d) => d.includes("intent-only") && d.includes("neutral"))).toBe(true);
  });

  it("M6 cutover後はpure harnessでbridge出力とのparityを検証できる", () => {
    const arbiter = new ExpressionIntentArbiter();
    const resolver = new ExpressionIntentResolver();
    const manager = new ExpressionManager();
    const bridge = new ExpressionIntentSlotBridge(manager, resolver);
    arbiter.acquire({
      owner: { producerId: "speech-brow", scopeId: "acoustic" },
      source: "speech",
      semantic: { role: "grounded-state", target: "Fcl_BRW_Surprised" },
      occupancy: [{ region: "brow", lane: "affect" }],
      salience: "grounded",
      intensity: 0.06,
      lifecycle: { kind: "held" },
    });

    const admitted = arbiter.getAdmitted();
    bridge.sync(admitted);
    expect(
      diffShadowAgainstSlots(
        collectShadowExpectations(admitted, resolver),
        manager.getSlots(),
        (slot) => slot.key !== undefined,
      ),
    ).toEqual([]);
  });
});
