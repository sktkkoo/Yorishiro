/**
 * Small, local semantic motion index. Features are deliberately inspectable:
 * calmness, attention, reflection, affiliation, emphasis, movement energy.
 * No embedding service, model download, network request, or vector DB is needed.
 * New clips must be reviewed for their environment requirements before indexing.
 */
export type MotionIntent =
  | "neutral"
  | "attentive"
  | "relaxed"
  | "thinking"
  | "explain"
  | "agree"
  | "consider"
  | "reassure"
  | "emphasize"
  | "celebrate"
  | "sad"
  | "uncertain";

export type MotionContext = "idle" | "speech";
export type MotionFeatures = readonly [number, number, number, number, number, number];

export interface MotionCatalogEntry {
  readonly id: string;
  readonly animation: string;
  readonly family: string;
  readonly contexts: readonly MotionContext[];
  readonly intents: readonly MotionIntent[];
  readonly features: MotionFeatures;
  readonly weight: number;
  /** Clip-specific reviewed strength ceiling, applied before physical entry evaluation. */
  readonly maxWeight?: number;
  readonly speed: number;
  readonly cooldownMs: number;
  /** Reviewed finite acting: start at zero, never use as a looping explanation baseline. */
  readonly playback?: "once";
  /** Optional reviewed finite exit budget. Once-only clips otherwise keep their natural end. */
  readonly maxDurationMs?: number;
  /** Only reviewed short speech one-shots may finish their return after normal audio end. */
  readonly finishAfterSpeech?: true;
}

export interface SemanticMotionQuery {
  readonly intent: MotionIntent;
  readonly context: MotionContext;
  /** Expressiveness, in [0, 1], rather than a probability of playing. */
  readonly intensity?: number;
}

export interface MotionHistoryEntry {
  readonly id: string;
  readonly family: string;
  readonly context: MotionContext;
  readonly selectedAtMs: number;
}

export interface MotionCandidate {
  readonly id: string;
  readonly animation: string;
  readonly score: number;
  /** Sampling weight after semantic fit, recency, and family diversity. */
  readonly weight: number;
  readonly entry: MotionCatalogEntry;
}

const IDLE_INTENTS = ["neutral", "attentive", "relaxed", "thinking"] as const;
const CONVERSATION_INTENTS = ["explain", "agree", "consider", "reassure", "emphasize"] as const;

/**
 * Documented source assets only. Local extraction/generation prototypes remain
 * available for explicit playback, but are not automatic production candidates.
 * Idle Conversation is excluded: source wrist/forearm coupling failed acting QA.
 * Watching and whole Looking Around clips fail low-wrist QA. The safe survey
 * interval is a separate, infrequent finite performance over the recorded base.
 * Shrugging is manual-only: the shoulder lift is distracting in conversation.
 * Idle Chatting 2 is manual-only after user-confirmed arm jitter around 3–4 s.
 * See CREDITS.md and docs/decisions/motion-source-eligibility.md.
 */
export const DEFAULT_MOTION_CATALOG: readonly MotionCatalogEntry[] = [
  {
    id: "idle-balance",
    animation: "anim:Idle",
    family: "balance",
    contexts: ["idle"],
    intents: IDLE_INTENTS,
    features: [1, 0.4, 0.2, 0.3, 0, 0.12],
    weight: 0.9,
    speed: 0.9,
    cooldownMs: 30_000,
  },

  {
    id: "idle-rest-hand",
    animation: "anim:VRMA_06_HandOnHip",
    family: "rest",
    contexts: ["idle"],
    intents: ["neutral", "relaxed"],
    features: [0.85, 0.25, 0.15, 0.3, 0.15, 0.2],
    weight: 0.85,
    speed: 0.8,
    cooldownMs: 180_000,
  },
  {
    id: "speech-appreciate",
    animation: "anim:Thankful",
    family: "acknowledge",
    contexts: ["speech"],
    intents: ["agree", "reassure"],
    features: [0.65, 0.6, 0.1, 1, 0.15, 0.3],
    weight: 0.6,
    speed: 1,
    cooldownMs: 6_000,
  },
  {
    id: "speech-chat",
    animation: "anim:Idle Chatting",
    family: "explain",
    contexts: ["speech"],
    intents: CONVERSATION_INTENTS,
    features: [0.5, 0.8, 0.35, 0.85, 0.6, 0.42],
    weight: 0.85,
    speed: 1,
    cooldownMs: 6_000,
  },
  // These short recordings passed Yori upper-body composition over both D/A
  // supports. Keep prop-dependent Texting and the foot-dependent Sad out here.
  // See docs/decisions/mixamo-motion-review.json for exact source hashes and QA.
  {
    id: "speech-celebrate",
    animation: "/animations/mixamo/Fist Pump.vrma",
    family: "celebration",
    contexts: ["speech"],
    intents: ["celebrate"],
    features: [0.15, 0.7, 0.1, 1, 1, 0.9],
    weight: 1,
    speed: 1,
    cooldownMs: 90_000,
    playback: "once",
    finishAfterSpeech: true,
  },
  {
    id: "speech-thoughtful",
    animation: "/animations/mixamo/Thoughtful Head Shake.vrma",
    family: "reflection",
    contexts: ["speech"],
    intents: ["consider", "uncertain"],
    features: [0.75, 0.85, 1, 0.2, 0.15, 0.3],
    weight: 1,
    speed: 1,
    cooldownMs: 20_000,
    playback: "once",
    finishAfterSpeech: true,
  },
  {
    id: "speech-present",
    animation: "/animations/mixamo/Hands Forward Gesture.vrma",
    family: "presentation",
    contexts: ["speech"],
    intents: ["emphasize"],
    features: [0.4, 0.95, 0.4, 0.8, 0.9, 0.55],
    weight: 1,
    speed: 1,
    cooldownMs: 20_000,
    playback: "once",
    finishAfterSpeech: true,
  },
];

const INTENT_FEATURES: Readonly<Record<MotionIntent, MotionFeatures>> = {
  neutral: [1, 0.5, 0.3, 0.25, 0, 0.15],
  attentive: [0.75, 1, 0.65, 0.3, 0, 0.2],
  relaxed: [1, 0.25, 0.2, 0.4, 0, 0.1],
  thinking: [0.85, 0.8, 1, 0.1, 0, 0.15],
  explain: [0.75, 0.9, 0.6, 0.65, 0.2, 0.3],
  agree: [0.55, 0.7, 0.15, 1, 0.3, 0.35],
  consider: [0.8, 0.8, 1, 0.45, 0.2, 0.3],
  reassure: [1, 0.65, 0.5, 1, 0.1, 0.2],
  emphasize: [0.35, 0.9, 0.25, 0.6, 1, 0.65],
  celebrate: [0.15, 0.7, 0.1, 1, 1, 0.9],
  sad: [0.8, 0.35, 0.8, 0.3, 0.1, 0.15],
  uncertain: [0.65, 0.8, 1, 0.35, 0.2, 0.3],
};

export interface MotionRetrievalOptions {
  readonly nowMs: number;
  readonly history?: readonly MotionHistoryEntry[];
  readonly catalog?: readonly MotionCatalogEntry[];
  /** Restrict to installed/usable animations when that information is available. */
  readonly availableAnimations?: ReadonlySet<string>;
  readonly limit?: number;
  /** Internal two-stage selection: let the physical gate run before truncating to five. */
  readonly includeAllEligible?: boolean;
  /** An absent speech background may resume after its ordinary clip cooldown. */
  readonly allowConsecutive?: boolean;
}

export function cosineMotionSimilarity(a: MotionFeatures, b: MotionFeatures): number {
  let dot = 0;
  let lengthA = 0;
  let lengthB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    lengthA += a[i] ** 2;
    lengthB += b[i] ** 2;
  }
  return lengthA > 0 && lengthB > 0 ? dot / Math.sqrt(lengthA * lengthB) : 0;
}

/** Semantic fit ranks first; sampling weights then encourage restrained variety. */
export function retrieveMotionCandidates(
  query: SemanticMotionQuery,
  options: MotionRetrievalOptions,
): readonly MotionCandidate[] {
  const history = options.history ?? [];
  const contextualHistory = history.filter((item) => item.context === query.context);
  const last = contextualHistory[contextualHistory.length - 1];
  const features = INTENT_FEATURES[query.intent];
  if (!features || !Number.isFinite(options.nowMs)) return [];
  const candidates: MotionCandidate[] = [];
  for (const entry of options.catalog ?? DEFAULT_MOTION_CATALOG) {
    if (!entry.contexts.includes(query.context) || !entry.intents.includes(query.intent)) continue;
    if (options.availableAnimations && !options.availableAnimations.has(entry.animation)) continue;
    // A short contextual reaction can recur after its clip cooldown, even when
    // no other speech motif occurred during a long silence. Continuous/idle
    // recordings still avoid consecutive selections of the same clip.
    if (
      entry.id === last?.id &&
      !options.allowConsecutive &&
      !(query.context === "speech" && entry.playback === "once")
    )
      continue;
    const clipHistory = history.filter((item) => item.id === entry.id);
    const previous = clipHistory[clipHistory.length - 1];
    if (previous && options.nowMs - previous.selectedAtMs < entry.cooldownMs) continue;
    const score = cosineMotionSimilarity(features, entry.features);
    if (score <= 0) continue;
    const age = previous ? Math.max(0, options.nowMs - previous.selectedAtMs) : Infinity;
    const recencyWeight = Math.min(1, 0.5 + age / 120_000);
    const familyWeight = last?.family === entry.family ? 0.35 : 1;
    const energyWeight =
      query.intent === "attentive" || query.intent === "thinking"
        ? 1 / (1 + Math.max(0, entry.features[5] - features[5]) * 8)
        : 1;
    candidates.push({
      id: entry.id,
      animation: entry.animation,
      score,
      weight: score ** 4 * recencyWeight * familyWeight * energyWeight,
      entry,
    });
  }
  const limit = Math.max(0, Math.min(5, Math.floor(options.limit ?? 5)));
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return options.includeAllEligible ? candidates : candidates.slice(0, limit);
}

export function sampleMotionCandidate<T extends MotionCandidate>(
  candidates: readonly T[],
  random: () => number,
): T | null {
  if (candidates.length === 0) return null;
  const total = candidates.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0)) return null;
  const sample = random();
  let cursor = (Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5) * total;
  for (const candidate of candidates) {
    cursor -= candidate.weight;
    if (cursor < 0) return candidate;
  }
  return candidates[candidates.length - 1];
}

/** Reproducible selection for debugging and offline evaluation. */
export function createSeededMotionRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}
