/** Reviewed finite performances; never enter the ordinary looping idle catalog. */
export const OCCASIONAL_IDLE_ANIMATIONS = [
  "/animations/recorded-idle/survey.vrma",
  "/animations/mixamo/Warrior Stretch.vrma",
] as const;

/** Keep rare performances varied while respecting installed assets and entry poses. */
export function selectOccasionalIdleAnimation(options: {
  readonly available: ReadonlySet<string>;
  readonly previous: string | null;
  readonly canPlay: (animation: string) => boolean;
  readonly random: () => number;
}): string | null {
  const compatible = OCCASIONAL_IDLE_ANIMATIONS.filter(
    (animation) => options.available.has(animation) && options.canPlay(animation),
  );
  if (compatible.length === 0) return null;
  const alternatives = compatible.filter((animation) => animation !== options.previous);
  const candidates = alternatives.length > 0 ? alternatives : compatible;
  const sample = options.random();
  const unit = Number.isFinite(sample) ? Math.max(0, Math.min(1, sample)) : 0.5;
  return candidates[Math.min(candidates.length - 1, Math.floor(unit * candidates.length))];
}
