import { describe, expect, it } from "vitest";
import {
  type CharacterMotionProfile,
  compileMotionProfile,
  DEFAULT_CHARACTER_MOTION_PROFILE,
  defaultMotionProfileForAvatar,
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

  it.each([
    undefined,
    "another-avatar",
  ])("shares speech without Yori support/contact data for %s", (sha) => {
    const generic = compileMotionProfile(defaultMotionProfileForAvatar(sha), sha);
    const yori = compileMotionProfile(
      DEFAULT_CHARACTER_MOTION_PROFILE,
      DEFAULT_CHARACTER_MOTION_PROFILE.modelSha256,
    );
    expect(generic.programs.map((program) => program.entry)).toEqual(
      yori.programs.filter((program) => program.role === "speech").map((program) => program.entry),
    );
    expect(generic.programs).toHaveLength(5);
    expect(generic.rejections).toEqual([]);
    expect(generic.support).toEqual({ recorded: false, fallback: true });
    expect(generic.footContacts.size).toBe(0);
    expect(defaultMotionProfileForAvatar(DEFAULT_CHARACTER_MOTION_PROFILE.modelSha256)).toBe(
      DEFAULT_CHARACTER_MOTION_PROFILE,
    );
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

  it("keeps reviewed contact geometry independent of automatic acting admission and avatar-bound", () => {
    const source = { ...profile(), programs: [] };
    const compatible = compileMotionProfile(source, "avatar-a");
    const other = compileMotionProfile(source, "avatar-b");
    expect(compatible.programs).toEqual([]);
    expect(compatible.footContacts.has("anim:Idle Chatting")).toBe(true);
    expect(compatible.footContacts.has("anim:Idle Chatting 2")).toBe(true);
    expect(other.footContacts.size).toBe(0);
    const contact = compatible.footContacts.get("anim:Idle Chatting 2");
    expect(Object.isFrozen(contact?.left[0])).toBe(true);
  });

  it("rejects malformed contact annotations without changing the acting program", () => {
    const source = profile();
    const result = compileMotionProfile(
      {
        ...source,
        footContacts: {
          "anim:invalid": { sourceSha256: "unverified", durationSec: 5, left: [[0, 5]], right: [] },
        },
      },
      "avatar-a",
    );
    expect(result.programs).toHaveLength(1);
    expect(result.footContacts.size).toBe(0);
  });
});
