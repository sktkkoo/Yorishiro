import { describe, expect, it } from "vitest";
import { MotionCompositionController, type MotionCompositionInput } from "./motion-composition";
import { compileMotionProfile, DEFAULT_CHARACTER_MOTION_PROFILE } from "./motion-profile";

function fixture() {
  const profile = compileMotionProfile(
    DEFAULT_CHARACTER_MOTION_PROFILE,
    DEFAULT_CHARACTER_MOTION_PROFILE.modelSha256,
  );
  const controller = new MotionCompositionController(profile);
  const input: MotionCompositionInput = {
    enabled: true,
    moving: true,
    claimed: false,
    activity: "idle",
    phase: "idle",
    ungroundedSpeech: false,
    relaxed: false,
    recordedActive: true,
    recordedOwnsUpper: true,
    scheduled: null,
    postureActive: false,
    occasionalActive: false,
  };
  return { profile, controller, input };
}

describe("whole-body composition grants", () => {
  it("keeps support excluded until every committed lower owner has physically settled", () => {
    const { controller, input } = fixture();
    controller.commit(1, "full-body");
    controller.commit(2, "full-body");
    expect(controller.resolve(input).support.recorded).toBe(false);
    controller.settled(1);
    expect(controller.resolve(input).exclusivePerformance).toBe(true);
    controller.commit(3, "upper-body");
    controller.settled(2);
    expect(controller.resolve(input).support.recorded).toBe(true);
    expect(controller.resolve(input).exclusivePerformance).toBe(false);
  });

  it("requires actual recorded support for reviewed posture even with an accepted pending request", () => {
    const { profile, controller, input } = fixture();
    const program = profile.programs.find((candidate) => candidate.role === "posture");
    if (!program) throw new Error("posture fixture missing");
    input.scheduled = {
      source: "idle",
      priority: "idle-fidget",
      animation: program.entry.animation,
    };
    expect(controller.admits(program, controller.resolve(input))).toBe(true);
    input.recordedActive = false;
    const plan = controller.resolve(input);
    expect(controller.admits(program, plan)).toBe(false);
    expect(plan.support.fallback).toBe(true);
    input.claimed = true;
    expect(controller.resolve(input).support.fallback).toBe(false);
  });

  it("reuses frame-plan containers while updating grants across conversation boundaries", () => {
    const { controller, input } = fixture();
    const plan = controller.resolve(input);
    const grants = plan.grants;
    const support = plan.support;
    expect(grants.occasional).toBe(true);
    input.phase = "user-speaking";
    expect(controller.resolve(input)).toBe(plan);
    expect(plan.grants).toBe(grants);
    expect(plan.support).toBe(support);
    expect(grants.occasional).toBe(false);
    expect(support.recorded).toBe(true);
    expect(support.upper).toBe(false);
  });
});
