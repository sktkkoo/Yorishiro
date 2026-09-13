import type { AnimationPlayer } from "./animation-player";

type Playback = Awaited<ReturnType<AnimationPlayer["play"]>>;

/**
 * Keeps the reviewed Idle recording's hips and legs alive beneath upper-body
 * performances. This is recorded motion, not a generated sway or foot IK.
 * Body decides when a full-body owner or animation claim must take precedence.
 */
export class RecordedIdleFoundation {
  private ready = false;
  private preparation: Promise<void> | null = null;
  private enabled = false;
  private disposed = false;
  private pending = false;
  private generation = 0;
  private gain = 1;
  private playback: Playback | null = null;

  constructor(private readonly player: AnimationPlayer) {}

  prepare(): Promise<void> {
    this.preparation ??= this.player
      .preload("anim:Idle", { mask: "lower-body", loop: true })
      .then((ready) => {
        if (!this.disposed) this.ready = ready;
      })
      .catch(() => {
        this.ready = false;
      });
    return this.preparation;
  }

  update(enabled: boolean, gain: number): void {
    if (this.disposed) return;
    const nextGain = Number.isFinite(gain) ? Math.max(0, Math.min(1, gain)) : 0;
    if (!enabled || nextGain === 0) {
      this.suspend(650);
      return;
    }
    this.enabled = true;
    if (this.gain !== nextGain) {
      this.gain = nextGain;
      this.playback?.setWeight(nextGain, 350);
    }
    if (!this.ready || this.pending || this.playback) return;
    this.pending = true;
    const generation = ++this.generation;
    const initialGain = this.gain;
    const isCurrent = () => !this.disposed && this.enabled && generation === this.generation;
    void this.player
      .play("anim:Idle", {
        mask: "lower-body",
        layer: "foundation",
        loop: true,
        speed: 0.9,
        weight: initialGain,
        fadeInMs: 1_200,
        isCurrent,
      })
      .then((playback) => {
        if (!isCurrent()) {
          playback.cancel();
          return;
        }
        this.pending = false;
        this.playback = playback;
        if (initialGain !== this.gain) playback.setWeight(this.gain, 350);
        void playback.completion.then(() => {
          if (this.playback === playback) this.playback = null;
        });
      })
      .catch((error: unknown) => {
        if (generation !== this.generation) return;
        this.pending = false;
        // A failed recording must not retry every render frame.
        if (!(error instanceof DOMException && error.name === "AbortError")) this.ready = false;
      });
  }

  suspend(fadeMs = 650): void {
    this.enabled = false;
    if (!this.pending && !this.playback) return;
    this.generation++;
    this.pending = false;
    const playback = this.playback;
    this.playback = null;
    if (fadeMs <= 0) playback?.cancel();
    else void playback?.stop(fadeMs);
  }

  dispose(): void {
    this.disposed = true;
    this.suspend(0);
  }
}
