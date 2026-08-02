/**
 * ExpressionIntentArbiter — pure policy layer の unit tests（#83 M1）。
 *
 * clock（envelope / pulse）、owner replacement、region + lane conflict、
 * reason code、ambient guard を VRM / Body なしで固定する。
 */

import { describe, expect, it } from "vitest";
import type { ExpressionIntentRequest, ExpressionIntentSnapshotEntry } from "./expression-intent";
import { EXPRESSION_DOMAIN_CLAIM_ID, ExpressionIntentArbiter } from "./expression-intent-arbiter";
import {
  deriveExpressionPriorityClass,
  EYELID_PHYSIOLOGY_OCCUPANCY,
  FULL_FACE_AFFECT_OCCUPANCY,
  findAmbientPolicyViolation,
  findOccupancyConflict,
  MOUTH_ARTICULATION_OCCUPANCY,
} from "./expression-intent-policy";

function request(overrides: Partial<ExpressionIntentRequest> = {}): ExpressionIntentRequest {
  return {
    owner: { producerId: "test", scopeId: "scope-1" },
    source: "idle",
    semantic: { role: "baseline", target: "neutral" },
    occupancy: FULL_FACE_AFFECT_OCCUPANCY,
    salience: "ambient",
    intensity: 1,
    lifecycle: { kind: "held" },
    ...overrides,
  };
}

function entryOf(
  arbiter: ExpressionIntentArbiter,
  intentId: string,
): ExpressionIntentSnapshotEntry {
  const entry = arbiter.getSnapshot().intents.find((i) => i.intentId === intentId);
  if (!entry) throw new Error(`intent ${intentId} not in snapshot`);
  return entry;
}

// ─── policy table ────────────────────────────────────────

describe("expression intent policy", () => {
  it("source / role から priority class を導出する", () => {
    expect(deriveExpressionPriorityClass("idle", { role: "baseline" })).toBe("ambient-baseline");
    expect(deriveExpressionPriorityClass("thinking", { role: "grounded-state" })).toBe(
      "grounded-activity",
    );
    expect(deriveExpressionPriorityClass("speech", { role: "grounded-state" })).toBe(
      "grounded-conversation",
    );
    expect(deriveExpressionPriorityClass("persona", { role: "explicit-action" })).toBe(
      "explicit-persona",
    );
    expect(deriveExpressionPriorityClass("mcp", { role: "explicit-action" })).toBe(
      "explicit-external",
    );
    expect(deriveExpressionPriorityClass("system", { role: "explicit-action" })).toBe(
      "explicit-external",
    );
    expect(deriveExpressionPriorityClass("reflex", { role: "baseline" })).toBe("ordinary-reflex");
    // safety-reflex role は source を問わず最上位 class
    expect(deriveExpressionPriorityClass("reflex", { role: "safety-reflex" })).toBe(
      "safety-reflex",
    );
  });

  it("conflict は同 region + 同 lane のみ。articulation は競合対象にしない", () => {
    expect(
      findOccupancyConflict(FULL_FACE_AFFECT_OCCUPANCY, [{ region: "brow", lane: "affect" }]),
    ).toEqual({ region: "brow", lane: "affect" });
    // mood(affect) と blink(physiology) は同じ目の周辺でも lane が違えば共存
    expect(
      findOccupancyConflict(FULL_FACE_AFFECT_OCCUPANCY, EYELID_PHYSIOLOGY_OCCUPANCY),
    ).toBeNull();
    // mouth/affect と mouth/articulation は共存（lip sync の予約 lane）
    expect(
      findOccupancyConflict(FULL_FACE_AFFECT_OCCUPANCY, MOUTH_ARTICULATION_OCCUPANCY),
    ).toBeNull();
  });

  it("ambient guard: role と state を制約する", () => {
    expect(
      findAmbientPolicyViolation({ salience: "ambient", semantic: { role: "baseline" } }),
    ).toBeNull();
    expect(
      findAmbientPolicyViolation({ salience: "ambient", semantic: { role: "grounded-state" } }),
    ).toBe("role");
    expect(
      findAmbientPolicyViolation({
        salience: "ambient",
        semantic: { role: "baseline", state: "happy" },
      }),
    ).toBe("state");
    // ambient 以外の salience には適用しない
    expect(
      findAmbientPolicyViolation({ salience: "grounded", semantic: { role: "grounded-state" } }),
    ).toBeNull();
  });
});

// ─── admission / conflict ────────────────────────────────

describe("ExpressionIntentArbiter admission", () => {
  it("単独 intent は active として admit される", () => {
    const arbiter = new ExpressionIntentArbiter();
    const handle = arbiter.acquire(request());
    const admitted = arbiter.getAdmitted();
    expect(admitted).toHaveLength(1);
    expect(admitted[0]?.intentId).toBe(handle.intentId);
    expect(admitted[0]?.effectiveIntensity).toBe(1);
    expect(entryOf(arbiter, handle.intentId).phase).toBe("active");
    expect(entryOf(arbiter, handle.intentId).reason).toBeNull();
  });

  it("grounded speech は overlap する ambient affect を suppress し、reason を残す", () => {
    const arbiter = new ExpressionIntentArbiter();
    const idle = arbiter.acquire(request());
    const speech = arbiter.acquire(
      request({
        owner: { producerId: "speech", scopeId: "utterance-1" },
        source: "speech",
        semantic: { role: "grounded-state", state: "happy" },
        salience: "grounded",
        intensity: 0.5,
      }),
    );

    const idleEntry = entryOf(arbiter, idle.intentId);
    expect(idleEntry.phase).toBe("suppressed");
    expect(idleEntry.reason).toBe("ambient-suspended-by-grounded");
    expect(idleEntry.suppressedBy).toBe(speech.intentId);
    expect(entryOf(arbiter, speech.intentId).phase).toBe("active");

    // 上位の release で ambient が再 admit される
    speech.release();
    expect(entryOf(arbiter, idle.intentId).phase).toBe("active");
    expect(entryOf(arbiter, idle.intentId).reason).toBeNull();
  });

  it("lane が違えば同じ顔でも共存する（mood + blink + articulation）", () => {
    const arbiter = new ExpressionIntentArbiter();
    const mood = arbiter.acquire(
      request({
        source: "speech",
        semantic: { role: "grounded-state", state: "happy" },
        salience: "grounded",
      }),
    );
    const blink = arbiter.acquire(
      request({
        owner: { producerId: "blink", scopeId: "auto" },
        source: "reflex",
        semantic: { role: "baseline" },
        occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
        salience: "reflex",
      }),
    );
    const viseme = arbiter.acquire(
      request({
        owner: { producerId: "lipsync", scopeId: "audio-1" },
        source: "speech",
        semantic: { role: "grounded-state", state: "articulating" },
        occupancy: MOUTH_ARTICULATION_OCCUPANCY,
        salience: "grounded",
      }),
    );

    const admittedIds = arbiter.getAdmitted().map((i) => i.intentId);
    expect(admittedIds).toContain(mood.intentId);
    expect(admittedIds).toContain(blink.intentId);
    expect(admittedIds).toContain(viseme.intentId);
  });

  it("priority ladder: 同 occupancy では上位 class が下位を suppress する", () => {
    const ladder = [
      { source: "idle", role: "baseline", salience: "ambient" },
      { source: "thinking", role: "grounded-state", salience: "grounded" },
      { source: "speech", role: "grounded-state", salience: "grounded" },
      { source: "persona", role: "explicit-action", salience: "explicit" },
      { source: "mcp", role: "explicit-action", salience: "explicit" },
    ] as const;
    for (let i = 0; i < ladder.length - 1; i++) {
      const lower = ladder[i];
      const higher = ladder[i + 1];
      if (!lower || !higher) continue;
      const arbiter = new ExpressionIntentArbiter();
      const low = arbiter.acquire(
        request({
          owner: { producerId: `low-${lower.source}`, scopeId: "s" },
          source: lower.source,
          semantic: { role: lower.role },
          salience: lower.salience,
        }),
      );
      const high = arbiter.acquire(
        request({
          owner: { producerId: `high-${higher.source}`, scopeId: "s" },
          source: higher.source,
          semantic: { role: higher.role },
          salience: higher.salience,
        }),
      );
      expect(entryOf(arbiter, low.intentId).phase, `${lower.source} < ${higher.source}`).toBe(
        "suppressed",
      );
      expect(entryOf(arbiter, high.intentId).phase, `${lower.source} < ${higher.source}`).toBe(
        "active",
      );
    }
  });

  it("同 class の categorical intent（同一 occupancy）は latest wins", () => {
    const arbiter = new ExpressionIntentArbiter();
    const first = arbiter.acquire(
      request({
        owner: { producerId: "persona-a", scopeId: "reaction-1" },
        source: "persona",
        semantic: { role: "explicit-action", target: "happy" },
        salience: "explicit",
      }),
    );
    const second = arbiter.acquire(
      request({
        owner: { producerId: "persona-b", scopeId: "reaction-2" },
        source: "persona",
        semantic: { role: "explicit-action", target: "sad" },
        salience: "explicit",
      }),
    );

    const firstEntry = entryOf(arbiter, first.intentId);
    expect(firstEntry.phase).toBe("suppressed");
    expect(firstEntry.reason).toBe("exclusive-tie-lost");
    expect(firstEntry.suppressedBy).toBe(second.intentId);
    expect(entryOf(arbiter, second.intentId).phase).toBe("active");

    // 勝者の release で敗者が復帰する
    second.release();
    expect(entryOf(arbiter, first.intentId).phase).toBe("active");
  });

  it("同 class の baseline 同士は blend する（idle の並存を保つ）", () => {
    const arbiter = new ExpressionIntentArbiter();
    const base = arbiter.acquire(request());
    const micro = arbiter.acquire(
      request({
        owner: { producerId: "micro-brow", scopeId: "episode-1" },
        semantic: { role: "baseline", target: "Fcl_BRW_Joy" },
        occupancy: [{ region: "brow", lane: "affect" }],
        intensity: 0.15,
      }),
    );

    expect(entryOf(arbiter, base.intentId).phase).toBe("blended");
    expect(entryOf(arbiter, micro.intentId).phase).toBe("blended");
    expect(arbiter.getAdmitted()).toHaveLength(2);
  });

  it("physiology lane: explicit eyelid action が ordinary auto-blink を suspend する", () => {
    const arbiter = new ExpressionIntentArbiter();
    const autoBlink = arbiter.acquire(
      request({
        owner: { producerId: "auto-blink", scopeId: "auto" },
        source: "reflex",
        semantic: { role: "baseline" },
        occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
        salience: "reflex",
      }),
    );
    expect(entryOf(arbiter, autoBlink.intentId).phase).toBe("active");

    // class rank では reflex > mcp だが、physiology lane 内では explicit-action が上
    const explicitBlink = arbiter.acquire(
      request({
        owner: { producerId: "mcp", scopeId: "request-1" },
        source: "mcp",
        semantic: { role: "explicit-action", target: "blink" },
        occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
        salience: "explicit",
      }),
    );
    expect(entryOf(arbiter, autoBlink.intentId).phase).toBe("suppressed");
    expect(entryOf(arbiter, autoBlink.intentId).reason).toBe("lower-priority-overlap");
    expect(entryOf(arbiter, explicitBlink.intentId).phase).toBe("active");

    // safety reflex はさらにその上
    const safety = arbiter.acquire(
      request({
        owner: { producerId: "safety", scopeId: "startle-1" },
        source: "reflex",
        semantic: { role: "safety-reflex" },
        occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
        salience: "reflex",
      }),
    );
    expect(entryOf(arbiter, explicitBlink.intentId).phase).toBe("suppressed");
    expect(entryOf(arbiter, safety.intentId).phase).toBe("active");

    // release で段階的に復帰する
    safety.release();
    expect(entryOf(arbiter, explicitBlink.intentId).phase).toBe("active");
    explicitBlink.release();
    expect(entryOf(arbiter, autoBlink.intentId).phase).toBe("active");
  });

  it("physiology lane: ambient episode（idle squint）は baseline reflex より優先する", () => {
    const arbiter = new ExpressionIntentArbiter();
    const autoBlink = arbiter.acquire(
      request({
        owner: { producerId: "auto-blink", scopeId: "auto" },
        source: "reflex",
        semantic: { role: "baseline" },
        occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
        salience: "reflex",
      }),
    );
    const squint = arbiter.acquire(
      request({
        owner: { producerId: "idle-squint", scopeId: "episode-1" },
        source: "idle",
        semantic: { role: "baseline", target: "blink" },
        occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
        salience: "ambient",
        intensity: 0.2,
      }),
    );

    expect(entryOf(arbiter, autoBlink.intentId).phase).toBe("suppressed");
    expect(entryOf(arbiter, squint.intentId).phase).toBe("active");
  });
});

// ─── ownership / replacement ─────────────────────────────

describe("ExpressionIntentArbiter ownership", () => {
  it("同じ (producer, replacementKey) の新 intent は旧 intent を replace する", () => {
    const arbiter = new ExpressionIntentArbiter();
    const first = arbiter.acquire(
      request({
        owner: { producerId: "speech-mood", scopeId: "utterance-1", replacementKey: "mood" },
        source: "speech",
        semantic: { role: "grounded-state", state: "happy" },
        salience: "grounded",
      }),
    );
    const second = arbiter.acquire(
      request({
        owner: { producerId: "speech-mood", scopeId: "utterance-2", replacementKey: "mood" },
        source: "speech",
        semantic: { role: "grounded-state", state: "sad" },
        salience: "grounded",
      }),
    );

    const firstEntry = entryOf(arbiter, first.intentId);
    expect(firstEntry.phase).toBe("expired");
    expect(firstEntry.reason).toBe("replaced-same-owner");
    expect(entryOf(arbiter, second.intentId).phase).toBe("active");

    // 古い handle の release は新 owner を解放しない
    first.release();
    expect(entryOf(arbiter, second.intentId).phase).toBe("active");
    expect(arbiter.getAdmitted()).toHaveLength(1);
  });

  it("古い generation の acquire は replacement intent を変更できない", () => {
    const arbiter = new ExpressionIntentArbiter();
    const current = arbiter.acquire(
      request({
        owner: {
          producerId: "speech-mood",
          scopeId: "utterance-2",
          generation: 5,
          replacementKey: "mood",
        },
        source: "speech",
        semantic: { role: "grounded-state", state: "happy" },
        salience: "grounded",
      }),
    );

    const stale = arbiter.acquire(
      request({
        owner: {
          producerId: "speech-mood",
          scopeId: "utterance-1",
          generation: 3,
          replacementKey: "mood",
        },
        source: "speech",
        semantic: { role: "grounded-state", state: "angry" },
        salience: "grounded",
      }),
    );

    expect(stale.intentId).toBe("stale");
    expect(entryOf(arbiter, current.intentId).phase).toBe("active");
    // stale handle の release も現 owner に影響しない
    stale.release();
    expect(entryOf(arbiter, current.intentId).phase).toBe("active");
  });

  it("updateIntensity は生きている intent の requested intensity を変える", () => {
    const arbiter = new ExpressionIntentArbiter();
    const handle = arbiter.acquire(request({ intensity: 0.4 }));
    handle.updateIntensity(0.8);
    expect(arbiter.getAdmitted()[0]?.effectiveIntensity).toBeCloseTo(0.8);

    handle.release();
    handle.updateIntensity(0.2);
    expect(entryOf(arbiter, handle.intentId).requestedIntensity).toBeCloseTo(0.8);
  });
});

// ─── lifecycle / clock ───────────────────────────────────

describe("ExpressionIntentArbiter lifecycle clock", () => {
  it("attack envelope は attackMs をかけて 0 → 1 に進む", () => {
    const arbiter = new ExpressionIntentArbiter();
    arbiter.acquire(
      request({
        intensity: 1,
        lifecycle: { kind: "held", attackMs: 300 },
      }),
    );
    expect(arbiter.getAdmitted()[0]?.effectiveIntensity).toBe(0);
    arbiter.update(0.15);
    expect(arbiter.getAdmitted()[0]?.effectiveIntensity).toBeCloseTo(0.5);
    arbiter.update(0.15);
    expect(arbiter.getAdmitted()[0]?.effectiveIntensity).toBeCloseTo(1);
  });

  it("release envelope は releaseMs をかけて減衰し、0 到達で expired になる", () => {
    const arbiter = new ExpressionIntentArbiter();
    const handle = arbiter.acquire(
      request({
        intensity: 1,
        lifecycle: { kind: "held", releaseMs: 400 },
      }),
    );
    handle.release();
    expect(entryOf(arbiter, handle.intentId).phase).toBe("releasing");
    expect(entryOf(arbiter, handle.intentId).reason).toBe("released");

    arbiter.update(0.2);
    expect(arbiter.getAdmitted()[0]?.effectiveIntensity).toBeCloseTo(0.5);
    arbiter.update(0.2);
    expect(entryOf(arbiter, handle.intentId).phase).toBe("expired");
    expect(arbiter.getAdmitted()).toHaveLength(0);
  });

  it("releaseMs なしの release は即 expired し、次々 update で purge される", () => {
    const arbiter = new ExpressionIntentArbiter();
    const handle = arbiter.acquire(request());
    handle.release();
    expect(entryOf(arbiter, handle.intentId).phase).toBe("expired");
    expect(entryOf(arbiter, handle.intentId).reason).toBe("released");

    arbiter.update(1 / 60);
    arbiter.update(1 / 60);
    expect(arbiter.getSnapshot().intents).toHaveLength(0);
  });

  it("pulse は durationMs 経過で自動 release され、reason は expired", () => {
    const arbiter = new ExpressionIntentArbiter();
    const handle = arbiter.acquire(
      request({
        lifecycle: { kind: "pulse", durationMs: 500, releaseMs: 200 },
      }),
    );
    arbiter.update(0.4);
    expect(entryOf(arbiter, handle.intentId).phase).toBe("active");
    arbiter.update(0.2);
    expect(entryOf(arbiter, handle.intentId).phase).toBe("releasing");
    expect(entryOf(arbiter, handle.intentId).reason).toBe("expired");
    arbiter.update(0.3);
    expect(entryOf(arbiter, handle.intentId).phase).toBe("expired");
  });

  it("suppressed の間も envelope clock は進む（復帰時に到達済みの値で出る）", () => {
    const arbiter = new ExpressionIntentArbiter();
    const idle = arbiter.acquire(
      request({ intensity: 1, lifecycle: { kind: "held", attackMs: 200 } }),
    );
    const speech = arbiter.acquire(
      request({
        owner: { producerId: "speech", scopeId: "u1" },
        source: "speech",
        semantic: { role: "grounded-state", state: "happy" },
        salience: "grounded",
      }),
    );
    arbiter.update(0.2);
    expect(entryOf(arbiter, idle.intentId).phase).toBe("suppressed");

    speech.release();
    expect(entryOf(arbiter, idle.intentId).phase).toBe("active");
    expect(arbiter.getAdmitted()[0]?.effectiveIntensity).toBeCloseTo(1);
  });
});

// ─── ambient guard / domain claim ────────────────────────

describe("ExpressionIntentArbiter guards", () => {
  it("ambient producer は grounded-state / explicit-action を発行できない", () => {
    const arbiter = new ExpressionIntentArbiter();
    const violating = arbiter.acquire(
      request({
        semantic: { role: "grounded-state", state: "happy" },
      }),
    );

    const entry = entryOf(arbiter, violating.intentId);
    expect(entry.phase).toBe("suppressed");
    expect(entry.reason).toBe("ambient-policy-rejected");
    expect(arbiter.getAdmitted()).toHaveLength(0);
  });

  it("ambient intent は semantic.state（意味状態の主張）を持てない", () => {
    const arbiter = new ExpressionIntentArbiter();
    const violating = arbiter.acquire(
      request({
        semantic: { role: "baseline", state: "concerned" },
      }),
    );
    expect(entryOf(arbiter, violating.intentId).reason).toBe("ambient-policy-rejected");
  });

  it("domain claim 中は全 intent が domain-claimed になり、解除で復帰する", () => {
    const arbiter = new ExpressionIntentArbiter();
    const idle = arbiter.acquire(request());
    const speech = arbiter.acquire(
      request({
        owner: { producerId: "speech", scopeId: "u1" },
        source: "speech",
        semantic: { role: "grounded-state", state: "happy" },
        salience: "grounded",
      }),
    );

    arbiter.setDomainClaimed(true);
    for (const handle of [idle, speech]) {
      const entry = entryOf(arbiter, handle.intentId);
      expect(entry.phase).toBe("suppressed");
      expect(entry.reason).toBe("domain-claimed");
      expect(entry.suppressedBy).toBe(EXPRESSION_DOMAIN_CLAIM_ID);
    }
    // claim は観察（reason）と apply 層のガードで表現し、manager slot 互換層
    // への出力（admitted）は落とさない。legacy の「claim 中も slot は据え置き、
    // VRM 書き込みだけ止まる」挙動との互換（policy 上の勝者 speech のみ出力）。
    expect(arbiter.getAdmitted()).toHaveLength(1);
    expect(arbiter.getAdmitted()[0]?.intentId).toBe(speech.intentId);

    arbiter.setDomainClaimed(false);
    expect(entryOf(arbiter, speech.intentId).phase).toBe("active");
    expect(entryOf(arbiter, idle.intentId).phase).toBe("suppressed");
    expect(entryOf(arbiter, idle.intentId).reason).toBe("ambient-suspended-by-grounded");
  });
});
