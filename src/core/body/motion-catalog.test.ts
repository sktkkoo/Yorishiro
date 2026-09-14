import { describe, expect, it } from "vitest";
import {
  cosineMotionSimilarity,
  createSeededMotionRandom,
  DEFAULT_MOTION_CATALOG,
  type MotionCatalogEntry,
  type MotionHistoryEntry,
  retrieveMotionCandidates,
  sampleMotionCandidate,
} from "./motion-catalog";

describe("local semantic motion catalog", () => {
  it.each([
    "celebrate",
    "sad",
    "uncertain",
  ] as const)("keeps %s unassigned until an explicitly reviewed contextual recording is registered", (intent) => {
    expect(retrieveMotionCandidates({ context: "speech", intent }, { nowMs: 0 })).toEqual([]);
    const reviewed: MotionCatalogEntry = {
      ...DEFAULT_MOTION_CATALOG[0],
      id: `reviewed-${intent}`,
      contexts: ["speech"],
      intents: [intent],
      playback: "once",
    };
    expect(
      retrieveMotionCandidates(
        { context: "speech", intent },
        { nowMs: 0, catalog: [reviewed] },
      ).map((entry) => entry.id),
    ).toEqual([reviewed.id]);
    expect(
      retrieveMotionCandidates(
        { context: "speech", intent: "explain" },
        { nowMs: 0, catalog: [reviewed] },
      ),
    ).toEqual([]);
    expect(
      retrieveMotionCandidates({ context: "idle", intent }, { nowMs: 0, catalog: [reviewed] }),
    ).toEqual([]);
  });

  it("limits automatic idle to the reviewed quiet recordings, keeping the rare survey separate", () => {
    const idle = DEFAULT_MOTION_CATALOG.filter((entry) => entry.contexts.includes("idle"));
    expect(idle.map((entry) => entry.animation).sort()).toEqual([
      "anim:Idle",
      "anim:VRMA_06_HandOnHip",
    ]);
    expect(idle.every((entry) => entry.weight >= 0.85)).toBe(true);
  });

  it("gates by context and intent before ranking rather than trusting vector proximity", () => {
    const unsafe: MotionCatalogEntry = {
      ...DEFAULT_MOTION_CATALOG[0],
      id: "speech-only",
      animation: "anim:Talking On Phone",
      contexts: ["speech"],
      intents: ["agree"],
    };
    const idle = retrieveMotionCandidates(
      { intent: "neutral", context: "idle" },
      { nowMs: 0, catalog: [...DEFAULT_MOTION_CATALOG, unsafe] },
    );
    expect(idle).toHaveLength(2);
    expect(idle.every((item) => item.entry.contexts.includes("idle"))).toBe(true);
    expect(idle.some((item) => item.id === "speech-only")).toBe(false);
    expect(
      retrieveMotionCandidates({ intent: "emphasize", context: "idle" }, { nowMs: 0 }),
    ).toEqual([]);
  });

  it("retrieves meaningful different leaders for reflective and emphatic speech", () => {
    const consider = retrieveMotionCandidates(
      { intent: "consider", context: "speech" },
      { nowMs: 0 },
    );
    const emphasize = retrieveMotionCandidates(
      { intent: "emphasize", context: "speech" },
      { nowMs: 0 },
    );
    expect(consider[0].id).toBe("speech-chat");
    expect(consider.some((candidate) => candidate.id === "speech-animated")).toBe(false);
    expect(emphasize[0].id).toBe("speech-animated");
    for (const candidates of [consider, emphasize]) {
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates.length).toBeLessThanOrEqual(5);
      expect(candidates.map((entry) => entry.score)).toEqual(
        candidates.map((entry) => entry.score).sort((a, b) => b - a),
      );
    }
  });

  it("keeps unreviewed prototypes out of automatic selection while retaining recorded emphasis candidates", () => {
    expect(
      DEFAULT_MOTION_CATALOG.some((entry) => /Prototype|Idle Conversation/i.test(entry.animation)),
    ).toBe(false);
    const candidates = retrieveMotionCandidates(
      { intent: "emphasize", context: "speech" },
      { nowMs: 0 },
    );
    expect(candidates.map((entry) => entry.animation).sort()).toEqual([
      "anim:Idle Chatting",
      "anim:Idle Chatting 2",
    ]);
  });

  it("gives ordinary explanation a conversational pool without assigning emotion or emphasis", () => {
    const candidates = retrieveMotionCandidates(
      { intent: "explain", context: "speech" },
      { nowMs: 0 },
    );
    expect(candidates.map((entry) => entry.animation).sort()).toEqual([
      "anim:Idle Chatting",
      "anim:Idle Chatting 2",
    ]);
    expect(retrieveMotionCandidates({ intent: "explain", context: "idle" }, { nowMs: 0 })).toEqual(
      [],
    );
  });

  it("never repeats the last motif and enforces per-clip cooldown across intervening choices", () => {
    const history: MotionHistoryEntry[] = [
      { id: "idle-balance", family: "balance", context: "idle", selectedAtMs: 1_000 },
      { id: "idle-rest-hand", family: "rest", context: "idle", selectedAtMs: 20_000 },
    ];
    const early = retrieveMotionCandidates(
      { intent: "neutral", context: "idle" },
      { nowMs: 25_000, history },
    );
    expect(early.some((item) => item.id === "idle-balance")).toBe(false);
    expect(early.some((item) => item.id === "idle-rest-hand")).toBe(false);
    const later = retrieveMotionCandidates(
      { intent: "neutral", context: "idle" },
      { nowMs: 100_000, history },
    );
    expect(later.some((item) => item.id === "idle-balance")).toBe(true);
    expect(later.some((item) => item.id === "idle-rest-hand")).toBe(false);
  });

  it("reduces same-family sampling weight while preserving semantic ranking", () => {
    const query = { intent: "neutral", context: "idle" } as const;
    const catalog: MotionCatalogEntry[] = [
      { ...DEFAULT_MOTION_CATALOG[0], id: "first", family: "shared" },
      { ...DEFAULT_MOTION_CATALOG[0], id: "sibling", family: "shared" },
      { ...DEFAULT_MOTION_CATALOG[0], id: "other", family: "distinct" },
    ];
    const first = retrieveMotionCandidates(query, { nowMs: 50_000, catalog });
    const following = retrieveMotionCandidates(query, {
      nowMs: 50_000,
      catalog,
      history: [{ id: "first", family: "shared", context: "idle", selectedAtMs: 40_000 }],
    });
    const original = first.find((item) => item.id === "sibling");
    const penalized = following.find((item) => item.id === "sibling");
    expect(original).toBeDefined();
    expect(penalized?.score).toBe(original?.score);
    expect(penalized?.weight).toBeCloseTo((original?.weight ?? 0) * 0.35);
    expect(following.find((item) => item.id === "other")?.weight).toBe(
      first.find((item) => item.id === "other")?.weight,
    );
  });

  it("keeps listening in a quiet attentive pool without scanning or hand-on-hip poses", () => {
    const candidates = retrieveMotionCandidates(
      { intent: "attentive", context: "idle" },
      { nowMs: 0 },
    );
    expect(candidates.map((entry) => entry.animation)).toEqual(["anim:Idle"]);
    expect(candidates.every((entry) => entry.entry.features[5] <= 0.15)).toBe(true);
    expect(
      retrieveMotionCandidates(
        { intent: "attentive", context: "idle" },
        {
          nowMs: 0,
          availableAnimations: new Set([
            "anim:VRMA_06_HandOnHip",
            "anim:Idle Watching Something",
            "anim:Idle Looking Around",
            "anim:Idle Looking Around 2",
            "/animations/recorded-idle/survey.vrma",
          ]),
        },
      ),
    ).toEqual([]);
  });

  it("respects installed asset availability without falling back to excluded motions", () => {
    const availableAnimations = new Set(["anim:Idle"]);
    const candidates = retrieveMotionCandidates(
      { intent: "neutral", context: "idle" },
      { nowMs: 0, availableAnimations },
    );
    expect(candidates.map((entry) => entry.animation)).toEqual(["anim:Idle"]);
    expect(
      retrieveMotionCandidates(
        { intent: "agree", context: "speech" },
        { nowMs: 0, availableAnimations },
      ),
    ).toEqual([]);
  });

  it("samples proportionally to weights and reproduces an evaluation seed", () => {
    const candidates = retrieveMotionCandidates(
      { intent: "neutral", context: "idle" },
      { nowMs: 0 },
    ).slice(0, 2);
    const weighted = candidates.map((entry, index) => ({ ...entry, weight: index === 0 ? 9 : 1 }));
    const randomA = createSeededMotionRandom(2026);
    const randomB = createSeededMotionRandom(2026);
    let firstSelections = 0;
    for (let i = 0; i < 5_000; i++) {
      const first = sampleMotionCandidate(weighted, randomA);
      expect(first?.id).toBe(sampleMotionCandidate(weighted, randomB)?.id);
      if (first?.id === weighted[0].id) firstSelections++;
    }
    expect(firstSelections / 5_000).toBeGreaterThan(0.87);
    expect(firstSelections / 5_000).toBeLessThan(0.93);
  });

  it("handles empty vectors, empty pools, and invalid random values without throwing", () => {
    expect(cosineMotionSimilarity([0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1])).toBe(0);
    expect(cosineMotionSimilarity([1, 0, 0, 0, 0, 0], [1, 0, 0, 0, 0, 0])).toBe(1);
    expect(sampleMotionCandidate([], () => 0)).toBeNull();
    const candidates = retrieveMotionCandidates(
      { intent: "neutral", context: "idle" },
      { nowMs: 0 },
    );
    expect(sampleMotionCandidate(candidates, () => Number.NaN)).not.toBeNull();
    expect(sampleMotionCandidate(candidates, () => 1)?.id).toBe(
      candidates[candidates.length - 1]?.id,
    );
  });
});
