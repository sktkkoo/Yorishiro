import { describe, expect, it } from "vitest";
import { createSeededMotionRandom, DEFAULT_MOTION_CATALOG } from "./motion-catalog";
import { type MotionDecision, MotionDirector, type MotionDirectorContext } from "./motion-director";

const idle: MotionDirectorContext = { enabled: true, context: "idle", intent: "neutral" };

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
      options: { loop: false, transition: "immediate", mask: "upper-body", speed: 1 },
    });
    expect(director.request({ intent: "emphasize", context: "speech" })).toBeNull();
    advance(director, 2_400, { ...idle, context: "speech" });
    const second = director.request({ intent: "agree", context: "speech" });
    expect(second).not.toBeNull();
    expect(second?.animation).not.toBe(first?.animation);
    expect(advance(director, 2_400)).toEqual([]);
  });

  it("returns to a recorded idle after speech settles instead of waiting an entire ambient dwell", () => {
    const director = new MotionDirector({ random: createSeededMotionRandom(42) });
    director.request({ intent: "agree", context: "speech" });
    expect(advance(director, 10_000, { ...idle, context: "speech" })).toEqual([]);
    expect(advance(director, 2_400)).toEqual([]);
    expect(advance(director, 100)).toHaveLength(1);
    expect(director.getSnapshot().lastDecision?.context).toBe("idle");
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
