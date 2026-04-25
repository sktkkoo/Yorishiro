import { type AttentionTarget, isValidAttentionRect } from "./attention-target";

export interface AttentionResolverOptions {
  readonly now: number;
  readonly maxAgeMsByKind?: Partial<Record<AttentionTarget["kind"], number>>;
}

const DEFAULT_MAX_AGE_MS: Record<AttentionTarget["kind"], number> = {
  mouse: 800,
  "input-cursor": 2000,
  "focused-dom": Number.POSITIVE_INFINITY,
  "terminal-region": 2000,
  "mcp-ui": 2000,
};

export function resolveAttentionTarget(
  candidates: ReadonlyArray<AttentionTarget | null | undefined>,
  options: AttentionResolverOptions,
): AttentionTarget | null {
  let best: AttentionTarget | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (!candidate || !isFresh(candidate, options) || !isValidAttentionRect(candidate.rect)) {
      continue;
    }
    const score = candidate.priority * 1000 + candidate.confidence;
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }

  return best;
}

function isFresh(target: AttentionTarget, options: AttentionResolverOptions): boolean {
  const maxAgeMs = options.maxAgeMsByKind?.[target.kind] ?? DEFAULT_MAX_AGE_MS[target.kind];
  if (!Number.isFinite(maxAgeMs)) return true;
  return options.now - target.timestamp <= maxAgeMs;
}
