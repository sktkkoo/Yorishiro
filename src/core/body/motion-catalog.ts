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
  | "agree"
  | "consider"
  | "reassure"
  | "emphasize";

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
  readonly speed: number;
  readonly cooldownMs: number;
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
const CONVERSATION_INTENTS = ["agree", "consider", "reassure", "emphasize"] as const;

/** Only prop-free, standing clips belong in the ambient pool. */
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
    id: "idle-orient",
    animation: "anim:Idle Looking Around",
    family: "orient",
    contexts: ["idle"],
    intents: IDLE_INTENTS,
    features: [0.7, 1, 0.4, 0.1, 0, 0.32],
    weight: 0.86,
    speed: 0.85,
    cooldownMs: 36_000,
  },
  {
    id: "idle-survey",
    animation: "anim:Idle Looking Around 2",
    family: "orient",
    contexts: ["idle"],
    intents: IDLE_INTENTS,
    features: [0.8, 0.85, 0.6, 0.1, 0, 0.24],
    weight: 0.86,
    speed: 0.82,
    cooldownMs: 36_000,
  },
  {
    id: "idle-observe",
    animation: "anim:Idle Watching Something",
    family: "observe",
    contexts: ["idle"],
    intents: IDLE_INTENTS,
    features: [0.85, 1, 0.85, 0.2, 0, 0.14],
    weight: 0.88,
    speed: 0.88,
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
    cooldownMs: 60_000,
  },
  {
    id: "speech-appreciate",
    animation: "anim:Thankful",
    family: "acknowledge",
    contexts: ["speech"],
    intents: ["agree", "reassure"],
    features: [0.65, 0.6, 0.1, 1, 0.15, 0.3],
    weight: 0.42,
    speed: 1,
    cooldownMs: 6_000,
  },
  {
    id: "speech-conversation",
    animation: "anim:Idle Conversation",
    family: "converse",
    contexts: ["speech"],
    intents: CONVERSATION_INTENTS,
    features: [0.55, 0.9, 0.55, 0.8, 0.45, 0.38],
    weight: 0.36,
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
    weight: 0.34,
    speed: 1,
    cooldownMs: 6_000,
  },
  {
    id: "speech-reflect",
    animation: "anim:Idle Chatting 2",
    family: "reflect",
    contexts: ["speech"],
    intents: ["consider", "reassure", "agree"],
    features: [0.75, 0.85, 1, 0.6, 0.25, 0.3],
    weight: 0.32,
    speed: 1,
    cooldownMs: 6_000,
  },
  {
    id: "speech-emphasize",
    animation: "anim:Conversational Emphasis Planted Prototype",
    family: "emphasize",
    contexts: ["speech"],
    intents: ["emphasize"],
    features: [0.3, 0.9, 0.2, 0.55, 1, 0.65],
    weight: 0.44,
    speed: 1,
    cooldownMs: 8_000,
  },
];

const INTENT_FEATURES: Readonly<Record<MotionIntent, MotionFeatures>> = {
  neutral: [1, 0.5, 0.3, 0.25, 0, 0.15],
  attentive: [0.75, 1, 0.65, 0.3, 0, 0.2],
  relaxed: [1, 0.25, 0.2, 0.4, 0, 0.1],
  thinking: [0.85, 0.8, 1, 0.1, 0, 0.15],
  agree: [0.55, 0.7, 0.15, 1, 0.3, 0.35],
  consider: [0.8, 0.8, 1, 0.45, 0.2, 0.3],
  reassure: [1, 0.65, 0.5, 1, 0.1, 0.2],
  emphasize: [0.35, 0.9, 0.25, 0.6, 1, 0.65],
};

export interface MotionRetrievalOptions {
  readonly nowMs: number;
  readonly history?: readonly MotionHistoryEntry[];
  readonly catalog?: readonly MotionCatalogEntry[];
  /** Restrict to installed/usable animations when that information is available. */
  readonly availableAnimations?: ReadonlySet<string>;
  readonly limit?: number;
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
    if (entry.id === last?.id) continue;
    const clipHistory = history.filter((item) => item.id === entry.id);
    const previous = clipHistory[clipHistory.length - 1];
    if (previous && options.nowMs - previous.selectedAtMs < entry.cooldownMs) continue;
    const score = cosineMotionSimilarity(features, entry.features);
    if (score <= 0) continue;
    const age = previous ? Math.max(0, options.nowMs - previous.selectedAtMs) : Infinity;
    const recencyWeight = Math.min(1, 0.5 + age / 120_000);
    const familyWeight = last?.family === entry.family ? 0.35 : 1;
    candidates.push({
      id: entry.id,
      animation: entry.animation,
      score,
      weight: score ** 4 * recencyWeight * familyWeight,
      entry,
    });
  }
  const limit = Math.max(0, Math.min(5, Math.floor(options.limit ?? 5)));
  return candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, limit);
}

export function sampleMotionCandidate(
  candidates: readonly MotionCandidate[],
  random: () => number,
): MotionCandidate | null {
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
