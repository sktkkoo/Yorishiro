import { describe, expect, it } from "vitest";
import { createSeededMotionRandom, DEFAULT_MOTION_CATALOG } from "./motion-catalog";
import { type MotionDecision, MotionDirector, type MotionDirectorContext } from "./motion-director";

const idle: MotionDirectorContext = { enabled: true, context: "idle", intent: "neutral" };
const speaking: MotionDirectorContext = { enabled: true, context: "speech", intent: "explain" };

function advance(
  director: MotionDirector,
  durationMs: number,
  context: MotionDirectorContext = idle,
): MotionDecision[] {
  const decisions: MotionDecision[] = [];
  for (let remaining = durationMs; remaining > 0; remaining -= 100) {
    const decision = director.update(Math.min(100, remaining), context);
    if (decision) decisions.push(decision);
  }
  return decisions;
}

describe("MotionDirector", () => {
  it("filters physical incompatibility before the final five and retains the evaluated entry", () => {
    const catalog = Array.from({ length: 7 }, (_, index) => ({
      ...DEFAULT_MOTION_CATALOG[0],
      id: `candidate-${index}`,
      animation: `anim:candidate-${index}`,
    }));
    const evaluated: string[] = [];
    const director = new MotionDirector({
      catalog,
      initialDelayMs: 0,
      random: () => 0,
      evaluateTransition: (animation, options) => {
        evaluated.push(animation);
        expect(options).toMatchObject({ loop: true, weight: 0.9, speed: 0.9 });
        return animation === "anim:candidate-6" ? { cost: 0.03, startTimeSec: 2.4 } : null;
      },
    });
    const decision = director.update(0, idle);
    expect(evaluated).toHaveLength(7);
    expect(decision?.animation).toBe("anim:candidate-6");
    expect(decision?.options.startTimeSec).toBe(2.4);
    expect(decision?.candidates).toHaveLength(1);
    expect(decision?.candidates[0].transition?.cost).toBe(0.03);
  });

  it("favours a compatible seam before drawing, using the actual playback strength", () => {
    const first = DEFAULT_MOTION_CATALOG.find((entry) => entry.id === "speech-conversation");
    if (!first) throw new Error("conversation fixture missing");
    const director = new MotionDirector({
      catalog: [first, { ...first, id: "second", animation: "anim:second" }],
      initialDelayMs: 0,
      random: () => 0,
      evaluateTransition: (animation, options) => {
        expect(options.weight).toBeCloseTo(0.85);
        return { cost: animation === first.animation ? 0.4 : 0.02, startTimeSec: 1 };
      },
    });
    const decision = director.update(0, speaking);
    expect(decision?.animation).toBe("anim:second");
    expect(decision?.candidates[0].weight).toBeGreaterThan(decision?.candidates[1].weight ?? 0);
  });

  it("keeps the current performance and preserves history and speech cooldown when every seam fails", () => {
    let compatible = true;
    const director = new MotionDirector({
      initialDelayMs: 0,
      random: () => 0,
      evaluateTransition: () => (compatible ? { cost: 0, startTimeSec: 0 } : null),
    });
    const first = director.update(0, idle);
    compatible = false;
    expect(director.request({ context: "speech", intent: "agree" })).toBeNull();
    expect(director.getSnapshot()).toMatchObject({
      suppressedReason: "transition",
      lastDecision: first,
    });
    expect(director.getSnapshot().history).toHaveLength(1);
    compatible = true;
    expect(director.request({ context: "speech", intent: "agree" })).not.toBeNull();
  });

  it("does not use non-finite seam evidence or enter a finite gesture halfway through", () => {
    for (const transition of [
      { cost: Number.NaN, startTimeSec: 0 },
      { cost: -1, startTimeSec: 0 },
      { cost: 0, startTimeSec: Infinity },
      { cost: 0, startTimeSec: 2 },
    ]) {
      const director = new MotionDirector({ evaluateTransition: () => transition });
      expect(director.request({ context: "speech", intent: "agree" })).toBeNull();
      expect(director.getSnapshot().history).toHaveLength(0);
    }
  });

  it("produces five real ambient variations with dwell time, no repeats, and clip cooldowns", () => {
    const director = new MotionDirector({ random: createSeededMotionRandom(71) });
    const decisions = advance(director, 600_000);
    expect(decisions.length).toBeGreaterThan(20);
    expect(decisions.length).toBeLessThan(45);
    expect(new Set(decisions.map((decision) => decision.animation)).size).toBe(5);
    const previousByAnimation = new Map<string, number>();
    for (let i = 0; i < decisions.length; i++) {
      const decision = decisions[i];
      expect(decision.options).toMatchObject({
        loop: true,
        transition: "matched",
        mask: "upper-body",
      });
      expect(decision.options.weight).toBeGreaterThanOrEqual(0.85);
      expect(decision.nextDueAtMs - decision.selectedAtMs).toBeGreaterThanOrEqual(12_000);
      expect(decision.nextDueAtMs - decision.selectedAtMs).toBeLessThanOrEqual(25_000);
      if (i > 0) {
        expect(decision.animation).not.toBe(decisions[i - 1].animation);
        expect(decision.selectedAtMs - decisions[i - 1].selectedAtMs).toBeGreaterThanOrEqual(
          12_000,
        );
      }
      const previous = previousByAnimation.get(decision.animation);
      if (previous !== undefined) {
        const clip = DEFAULT_MOTION_CATALOG.find((item) => item.animation === decision.animation);
        expect(decision.selectedAtMs - previous).toBeGreaterThanOrEqual(
          clip?.cooldownMs ?? Infinity,
        );
      }
      previousByAnimation.set(decision.animation, decision.selectedAtMs);
    }
  });

  it("yields to owned or speech motion and allows a settling gap when idle resumes", () => {
    const director = new MotionDirector({ random: createSeededMotionRandom(5) });
    expect(advance(director, 60_000, { ...idle, blocked: true })).toEqual([]);
    expect(director.getSnapshot()).toMatchObject({
      phase: "blocked",
      suppressedReason: "priority",
    });
    expect(advance(director, 2_400)).toEqual([]);
    expect(advance(director, 100)).toHaveLength(1);
    expect(advance(director, 60_000, { ...idle, context: "speech" })).toEqual([]);
    expect(advance(director, 2_400)).toEqual([]);
  });

  it("pauses selection when disabled without accumulating a backlog on re-enable", () => {
    const director = new MotionDirector();
    expect(advance(director, 60_000, { ...idle, enabled: false })).toEqual([]);
    expect(director.getSnapshot().phase).toBe("disabled");
    expect(director.update(3_600_000, idle)).toBeNull();
    expect(director.getSnapshot().elapsedMs).toBe(61_000);
    expect(advance(director, 200)).toHaveLength(1);
  });

  it("keeps the current idle through occasional quiet periods instead of issuing another motion", () => {
    const director = new MotionDirector({ random: () => 0, initialDelayMs: 0 });
    const first = director.update(0, idle);
    expect(first).not.toBeNull();
    expect(director.getSnapshot().quietUntilMs).toBe(13_000);
    expect(advance(director, 11_900)).toEqual([]);
    expect(director.getSnapshot().phase).toBe("dwelling");
    expect(advance(director, 100)).toEqual([]);
    expect(director.getSnapshot()).toMatchObject({ phase: "quiet", lastDecision: first });
    expect(advance(director, 900)).toEqual([]);
    expect(advance(director, 100)).toHaveLength(1);
  });

  it("uses finite, beginning-aligned speech motifs and prevents successive cue flurries", () => {
    const director = new MotionDirector({ random: createSeededMotionRandom(9) });
    const first = director.request({ intent: "agree", context: "speech", intensity: 0.4 });
    expect(first).toMatchObject({
      reason: "speech-intent",
      intent: "agree",
      options: {
        loop: false,
        transition: "immediate",
        mask: "upper-body",
        speed: 1,
        maxDurationMs: 6_000,
      },
    });
    expect(director.request({ intent: "emphasize", context: "speech" })).toBeNull();
    advance(director, 2_400, { ...idle, context: "speech" });
    const second = director.request({ intent: "agree", context: "speech" });
    expect(second).not.toBeNull();
    expect(second?.animation).not.toBe(first?.animation);
    expect(advance(director, 2_400)).toEqual([]);
  });

  it("varies a long explanation with restrained matched recordings independently of emotion cues", () => {
    const director = new MotionDirector({ random: createSeededMotionRandom(73) });
    const decisions = advance(director, 180_000, speaking);
    expect(decisions.length).toBeGreaterThanOrEqual(9);
    expect(decisions.length).toBeLessThanOrEqual(18);
    expect(new Set(decisions.map((entry) => entry.animation)).size).toBe(3);
    for (const [index, decision] of decisions.entries()) {
      expect(decision).toMatchObject({
        context: "speech",
        intent: "explain",
        reason: "speech-dwell-elapsed",
        options: { loop: true, transition: "matched", mask: "upper-body" },
      });
      expect(decision.options.maxDurationMs).toBeUndefined();
      expect(decision.options.weight).toBeCloseTo(0.85);
      expect(decision.nextDueAtMs - decision.selectedAtMs).toBeGreaterThanOrEqual(10_000);
      expect(decision.nextDueAtMs - decision.selectedAtMs).toBeLessThanOrEqual(18_000);
      if (index > 0) expect(decision.animation).not.toBe(decisions[index - 1].animation);
    }
  });

  it("allows a grounded cue immediately after speech background starts, then settles back into explanation", () => {
    const director = new MotionDirector({ initialDelayMs: 0, random: () => 0.5 });
    expect(director.update(0, speaking)?.intent).toBe("explain");
    expect(director.request({ intent: "emphasize", context: "speech" })?.intent).toBe("emphasize");
    expect(advance(director, 6_000, { ...speaking, blocked: true })).toEqual([]);
    expect(advance(director, 2_400, speaking)).toEqual([]);
    expect(advance(director, 100, speaking)[0]?.intent).toBe("explain");
    director.requestNextIdle(600);
    expect(advance(director, 500, idle)).toEqual([]);
    expect(advance(director, 100, idle)[0]?.context).toBe("idle");
  });

  it("returns to a recorded idle after speech settles instead of waiting an entire ambient dwell", () => {
    const director = new MotionDirector({ random: createSeededMotionRandom(42) });
    director.request({ intent: "agree", context: "speech" });
    expect(advance(director, 10_000, { ...idle, context: "speech" })).toEqual([]);
    expect(advance(director, 2_400)).toEqual([]);
    expect(advance(director, 100)).toHaveLength(1);
    expect(director.getSnapshot().lastDecision?.context).toBe("idle");
  });

  it("reconsiders changed listening context promptly while preserving no-repeat and priority gates", () => {
    const director = new MotionDirector({ random: createSeededMotionRandom(7), initialDelayMs: 0 });
    const first = director.update(0, idle);
    director.requestNextIdle(600);
    expect(advance(director, 500, { ...idle, intent: "attentive" })).toEqual([]);
    const listening = advance(director, 100, { ...idle, intent: "attentive" });
    expect(listening).toHaveLength(1);
    expect(listening[0].animation).not.toBe(first?.animation);
    expect(["anim:Idle", "anim:Idle Watching Something"]).toContain(listening[0].animation);
    director.requestNextIdle(0);
    expect(advance(director, 5_000, { ...idle, blocked: true })).toEqual([]);
  });

  it("omits unavailable or failed assets and backs off when the safe pool is exhausted", () => {
    const availableAnimations = new Set(["anim:Idle"]);
    const director = new MotionDirector({ initialDelayMs: 0, availableAnimations });
    expect(director.update(0, idle)?.animation).toBe("anim:Idle");
    director.excludeAnimation("anim:Idle");
    expect(advance(director, 30_000)).toEqual([]);
    expect(director.getSnapshot().suppressedReason).toBe("cooldown");
    availableAnimations.add("anim:Idle Looking Around");
    expect(advance(director, 3_000).map((decision) => decision.animation)).toEqual([
      "anim:Idle Looking Around",
    ]);
  });

  it("exposes reproducible decision evidence and copies history for observers", () => {
    const first = new MotionDirector({ random: createSeededMotionRandom(123) });
    const second = new MotionDirector({ random: createSeededMotionRandom(123) });
    expect(advance(first, 120_000)).toEqual(advance(second, 120_000));
    const snapshot = first.getSnapshot();
    expect(snapshot.lastDecision?.candidates.length).toBeGreaterThan(0);
    expect(snapshot.lastDecision?.candidates.length).toBeLessThanOrEqual(5);
    expect(snapshot.history).not.toBe(first.getSnapshot().history);
  });
});
