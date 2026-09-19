import { describe, expect, it } from "vitest";
import {
  type CharacterMotionProfile,
  compileMotionProfile,
  DEFAULT_CHARACTER_MOTION_PROFILE,
} from "./motion-profile";

const profile = (): CharacterMotionProfile => ({
  ...DEFAULT_CHARACTER_MOTION_PROFILE,
  modelSha256: "avatar-a",
  programs: [DEFAULT_CHARACTER_MOTION_PROFILE.programs[0]],
});

describe("character motion program admission", () => {
  it("admits only the reviewed avatar's programs and retains the independent calibrated fallback", () => {
    const compatible = compileMotionProfile(profile(), "avatar-a");
    const other = compileMotionProfile(profile(), "avatar-b");
    expect(compatible.programs).toHaveLength(1);
    expect(other.programs).toEqual([]);
    expect(other.rejections[0].reason).toBe("avatar-mismatch");
    expect(other.support).toEqual({ recorded: false, fallback: true });
  });

  it("rejects unsupported whole-body composition and absent authored review", () => {
    const source = profile();
    const program = source.programs[0];
    const result = compileMotionProfile(
      {
        ...source,
        programs: [
          {
            ...program,
            composition: { ...program.composition, mask: "full-body", support: "replace" },
          },
          { ...program, entry: { ...program.entry, id: "unreviewed" }, review: "" },
        ],
      },
      "avatar-a",
    );
    expect(result.programs).toEqual([]);
    expect(result.rejections.map((rejection) => rejection.reason)).toEqual([
      "unsupported-composition",
      "missing-review",
    ]);
  });

  it("keeps all default automatic routes free of rejected performances, with HandOnHip posture-only", () => {
    const compiled = compileMotionProfile(
      DEFAULT_CHARACTER_MOTION_PROFILE,
      DEFAULT_CHARACTER_MOTION_PROFILE.modelSha256,
    );
    expect(
      compiled.programs.some(
        ({ entry }) =>
          ["anim:Idle", "anim:Idle Chatting 2"].includes(entry.animation) ||
          entry.animation.includes("Shrugging"),
      ),
    ).toBe(false);
    const hip = compiled.byAnimation.get("anim:VRMA_06_HandOnHip");
    expect(hip?.role).toBe("posture");
    expect(hip?.entry.cooldownMs).toBe(180_000);
    expect(compiled.cadence.postureDurationMs[1]).toBeLessThanOrEqual(12_000);
    expect(compiled.programs.filter((program) => program.role === "ambient")).toEqual([]);
    expect(compiled.programs.filter((program) => program.role === "speech")).toHaveLength(5);
  });

  it("snapshots nested authoring data so one character's later edits cannot mutate a live profile", () => {
    const source = profile();
    const entry = { ...source.programs[0].entry, intents: ["agree" as const] };
    const authored = { ...source, programs: [{ ...source.programs[0], entry }] };
    const first = compileMotionProfile(authored, "avatar-a");
    entry.intents.push("agree");
    entry.animation = "changed";
    const second = compileMotionProfile(authored, "avatar-a");
    expect(first.programs[0].entry.intents).toEqual(["agree"]);
    expect(first.programs[0].entry.animation).not.toBe("changed");
    expect(second.programs[0].entry.animation).toBe("changed");
    expect(Object.isFrozen(first.programs[0].entry.intents)).toBe(true);
  });
});
