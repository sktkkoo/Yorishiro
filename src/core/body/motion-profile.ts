import { DEFAULT_MOTION_CATALOG, type MotionCatalogEntry } from "./motion-catalog";

export type MotionProgramRole = "ambient" | "posture" | "occasional" | "speech";

export interface MotionProgram {
  /** Authored review record; structural compatibility alone is not admission. */
  readonly review: string;
  readonly entry: MotionCatalogEntry;
  readonly role: MotionProgramRole;
  readonly composition: {
    readonly mask: "upper-body" | "full-body";
    readonly support: "retain-standing" | "replace";
    readonly gain: "idle" | "speech";
    /** Recorded support is required for the reviewed occasional performances. */
    readonly requiresRecordedSupport?: boolean;
  };
}

export interface CharacterMotionProfile {
  readonly id: string;
  /** Optional exact avatar binding. A mismatch admits no automatic programs. */
  readonly modelSha256?: string;
  readonly programs: readonly MotionProgram[];
  readonly support: { readonly recorded: boolean; readonly fallback: boolean };
  readonly cadence: {
    readonly postureWaitMs: readonly [number, number];
    readonly postureDurationMs: readonly [number, number];
    readonly occasionalWaitMs: readonly [number, number];
  };
}

const upperStanding = { mask: "upper-body", support: "retain-standing" } as const;

function reviewedEntry(id: string): MotionCatalogEntry {
  const entry = DEFAULT_MOTION_CATALOG.find((candidate) => candidate.id === id);
  if (!entry) throw new Error(`Missing reviewed motion catalog entry: ${id}`);
  return entry;
}

/** Admission is character data; a catalog entry alone does not authorize playback. */
export const DEFAULT_CHARACTER_MOTION_PROFILE: CharacterMotionProfile = {
  id: "reviewed-standing",
  modelSha256: "739a1515cffe09c17a535eb52a11f88640fc7728b86b9e4c74f00c353437b7cd",
  support: { recorded: true, fallback: true },
  cadence: {
    postureWaitMs: [15_000, 25_000],
    postureDurationMs: [8_000, 12_000],
    occasionalWaitMs: [90_000, 150_000],
  },
  programs: [
    ...[
      "speech-appreciate",
      "speech-chat",
      "speech-celebrate",
      "speech-thoughtful",
      "speech-present",
    ].map(
      (id): MotionProgram => ({
        review: "docs/decisions/motion-orchestration.md",
        entry: reviewedEntry(id),
        role: "speech",
        composition: { ...upperStanding, gain: "speech" },
      }),
    ),
    {
      review: "docs/decisions/recorded-idle-dynamics.md",
      entry: reviewedEntry("idle-rest-hand"),
      role: "posture",
      composition: { ...upperStanding, gain: "idle", requiresRecordedSupport: true },
    },
    ...[
      ["idle-survey", "/animations/recorded-idle/survey.vrma"],
      ["idle-stretch", "/animations/mixamo/Warrior Stretch.vrma"],
    ].map(
      ([id, animation]): MotionProgram => ({
        review: "docs/decisions/mixamo-motion-review.json; docs/decisions/idle-survey-review.md",
        entry: {
          id,
          animation,
          family: id,
          contexts: ["idle"],
          intents: ["neutral", "relaxed"],
          features: [0.7, 0.5, 0.3, 0.3, 0.1, 0.3],
          weight: 1,
          speed: 1,
          cooldownMs: 90_000,
          playback: "once",
        },
        role: "occasional",
        composition: { ...upperStanding, gain: "idle", requiresRecordedSupport: true },
      }),
    ),
  ],
};

export interface CompiledMotionProfile {
  readonly id: string;
  readonly programs: readonly MotionProgram[];
  readonly byAnimation: ReadonlyMap<string, MotionProgram>;
  readonly support: CharacterMotionProfile["support"];
  readonly cadence: CharacterMotionProfile["cadence"];
  readonly rejections: readonly { readonly id: string; readonly reason: string }[];
}

/** This first slice admits reviewed upper-over-standing composition only. */
export function compileMotionProfile(
  profile: CharacterMotionProfile,
  modelSha256?: string,
): CompiledMotionProfile {
  const compatible = !profile.modelSha256 || profile.modelSha256 === modelSha256;
  const programs: MotionProgram[] = [];
  const byAnimation = new Map<string, MotionProgram>();
  const ids = new Set<string>();
  const rejections: { id: string; reason: string }[] = [];
  const cadenceValid =
    Object.values(profile.cadence).every(
      (range) =>
        range.length === 2 && range.every(Number.isFinite) && range[0] >= 0 && range[1] >= range[0],
    ) &&
    profile.cadence.postureDurationMs[0] > 0 &&
    profile.cadence.postureDurationMs[1] <= 30_000;
  for (const program of profile.programs) {
    const { entry, composition } = program;
    const reason = !compatible
      ? "avatar-mismatch"
      : !cadenceValid
        ? "invalid-cadence"
        : composition.mask !== "upper-body" || composition.support !== "retain-standing"
          ? "unsupported-composition"
          : ids.has(entry.id) || byAnimation.has(entry.animation)
            ? "duplicate-program"
            : !program.review?.trim()
              ? "missing-review"
              : !["ambient", "posture", "occasional", "speech"].includes(program.role) ||
                  !["idle", "speech"].includes(composition.gain) ||
                  !entry.id?.trim() ||
                  !entry.animation?.trim() ||
                  !Number.isFinite(entry.speed) ||
                  entry.speed <= 0 ||
                  !Number.isFinite(entry.weight) ||
                  entry.weight <= 0 ||
                  entry.weight > 1 ||
                  (entry.maxWeight !== undefined &&
                    (!Number.isFinite(entry.maxWeight) ||
                      entry.maxWeight <= 0 ||
                      entry.maxWeight > 1)) ||
                  !Number.isFinite(entry.cooldownMs) ||
                  entry.cooldownMs < 0 ||
                  !entry.contexts.length ||
                  !entry.contexts.every((context) => context === "idle" || context === "speech") ||
                  !entry.intents.length ||
                  !entry.features.every(Number.isFinite)
                ? "invalid-program"
                : program.role === "occasional" && entry.playback !== "once"
                  ? "unbounded-occasional"
                  : null;
    if (reason) {
      rejections.push({ id: entry.id, reason });
      continue;
    }
    ids.add(entry.id);
    const admitted = Object.freeze({
      ...program,
      entry: Object.freeze({
        ...entry,
        contexts: Object.freeze([...entry.contexts]),
        intents: Object.freeze([...entry.intents]),
        features: Object.freeze([...entry.features]) as MotionCatalogEntry["features"],
      }),
      composition: Object.freeze({ ...composition }),
    });
    programs.push(admitted);
    byAnimation.set(entry.animation, admitted);
  }
  return {
    id: profile.id,
    programs: Object.freeze(programs),
    byAnimation,
    support: Object.freeze({
      recorded: compatible && profile.support.recorded,
      fallback: profile.support.fallback,
    }),
    cadence: Object.freeze(
      Object.fromEntries(
        Object.entries(
          cadenceValid ? profile.cadence : DEFAULT_CHARACTER_MOTION_PROFILE.cadence,
        ).map(([key, range]) => [key, Object.freeze([...range])]),
      ) as unknown as CharacterMotionProfile["cadence"],
    ),
    rejections: Object.freeze(rejections),
  };
}
