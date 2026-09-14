import type { MotionContext } from "./motion-catalog";
import type { RecordedAxialStrength } from "./recorded-base-player";

export interface RecordedBodyUnit {
  readonly id: string;
  readonly animation: string;
  readonly context: MotionContext;
  /** Reviewed low hands that may receive a small relaxed hand fidget. */
  readonly handsAtRest?: boolean;
  /** Shared authored neutral reference for axial attenuation across this recording. */
  readonly axialReferenceTimeSec?: number;
  readonly startTimeSec: number;
  readonly endTimeSec: number;
  readonly contactWindows: readonly {
    readonly startTimeSec: number;
    readonly endTimeSec: number;
    readonly feet: "both";
  }[];
}

export interface RecordedBodyManifest {
  readonly schemaVersion: 1;
  readonly targetModelSha256: string;
  readonly units: readonly RecordedBodyUnit[];
}

export interface RecordedBodyPlayback {
  readonly id: number;
  readonly completion: Promise<void>;
  readonly phaseSec: number;
  readonly held: boolean;
  readonly paused: boolean;
  stop(fadeMs?: number): Promise<void>;
  cancel(): void;
  setUpperWeight(value: number, fadeMs?: number): void;
  setPaused(paused: boolean): void;
  setAxialStrength(strength: RecordedAxialStrength, fadeMs?: number): void;
}

interface RecordedBodyPlayer {
  preloadRecordedBase(ref: string): Promise<boolean>;
  playRecordedBase(
    ref: string,
    options: {
      startTimeSec: number;
      endTimeSec: number;
      fadeInMs: number;
      contactWindows: RecordedBodyUnit["contactWindows"];
      isCurrent: () => boolean;
      onCommit?: () => void;
      initialPose?: boolean;
      axialReferenceTimeSec?: number;
      getInitialState?: () => {
        readonly paused: boolean;
        readonly upperWeight: number;
        readonly axialStrength?: RecordedAxialStrength;
      };
    },
  ): Promise<RecordedBodyPlayback>;
}

/** Complete recorded body units, with upper gestures free to interrupt their arms.
 * A conversation boundary never cuts a supporting leg or resets the pelvis.
 * The player owns contact compatibility and synchronized action clocks.
 */
export class RecordedBodySequencer {
  private units: readonly RecordedBodyUnit[] = [];
  private prepared: Promise<void> | null = null;
  private current: { unit: RecordedBodyUnit; playback: RecordedBodyPlayback } | null = null;
  private pending = false;
  private enabled = false;
  private disposed = false;
  private generation = 0;
  private elapsedMs = 0;
  private retryAtMs = 0;
  private context: MotionContext = "idle";
  private upperEnabled = true;
  private allowBaseUpper = true;
  private intensity = 1;
  private upperStrength = 1;
  private paused = false;
  private axialStrength: RecordedAxialStrength = { torso: 1, head: 1 };
  private readonly lastPlayed = new Map<string, number>();
  private lastRejection: string | null = null;
  private initialRejection: string | null = null;
  private lastSuspension: { reason: string; unit: string } | null = null;

  constructor(
    private readonly player: RecordedBodyPlayer,
    private readonly options: {
      modelSha256?: string;
      loadManifest?: () => Promise<unknown>;
      random?: () => number;
      onCommit?: () => void;
    } = {},
  ) {}

  /** Independent from layer ownership: damp axial motion without weakening the hands or feet. */
  setAxialStrength(strength: RecordedAxialStrength, fadeMs = 350): void {
    const torso = clampIntensity(strength.torso);
    const head = clampIntensity(strength.head);
    if (torso === this.axialStrength.torso && head === this.axialStrength.head) return;
    this.axialStrength = { torso, head };
    this.current?.playback.setAxialStrength(this.axialStrength, fadeMs);
  }

  prepare(): Promise<void> {
    this.prepared ??= this.prepareOnce();
    return this.prepared;
  }

  /** Called only before the avatar enters the rendered scene. */
  async initialize(intensity = 1): Promise<void> {
    this.intensity = clampIntensity(intensity);
    await this.prepare();
    if (this.disposed || this.current || this.pending) return;
    const candidates = this.units.filter((unit) => unit.context === "idle");
    if (candidates.length === 0) return;
    this.enabled = true;
    this.context = "idle";
    this.pending = true;
    await this.selectNext(candidates, ++this.generation, true);
  }

  private async prepareOnce(): Promise<void> {
    // Target contact adaptation includes the actual shoes. A rig/name match alone
    // cannot qualify another avatar for this reviewed bundle.
    if (!this.options.modelSha256) return;
    try {
      const input = await (this.options.loadManifest ?? loadBundledManifest)();
      const manifest = parseRecordedBodyManifest(input, this.options.modelSha256);
      if (!manifest || this.disposed) return;
      const available = new Set<string>();
      for (const ref of new Set(manifest.units.map((unit) => unit.animation))) {
        if (this.disposed) return;
        if (await this.player.preloadRecordedBase(ref)) available.add(ref);
      }
      if (!this.disposed)
        this.units = manifest.units.filter((unit) => available.has(unit.animation));
    } catch {
      // Optional source assets may be absent; the existing recorded idle remains.
      this.units = [];
    }
  }

  update(
    deltaMs: number,
    enabled: boolean,
    context: MotionContext,
    allowBaseUpper = true,
    intensity = 1,
  ): void {
    if (this.disposed) return;
    if (Number.isFinite(deltaMs)) this.elapsedMs += Math.max(0, Math.min(1_000, deltaMs));
    if (!enabled) {
      this.suspend(650);
      return;
    }
    this.enabled = true;
    const nextIntensity = clampIntensity(intensity);
    const intensityChanged = nextIntensity !== this.intensity;
    this.intensity = nextIntensity;
    if (this.context !== context && this.pending) {
      this.generation++;
      this.pending = false;
    }
    this.context = context;
    this.allowBaseUpper = allowBaseUpper;
    const upperEnabled =
      this.intensity > 0 && allowBaseUpper && this.current?.unit.context === context;
    const upperStrength = upperEnabled ? this.intensity : 0;
    this.upperEnabled = upperEnabled;
    if (upperStrength !== this.upperStrength) {
      this.upperStrength = upperStrength;
      this.current?.playback.setUpperWeight(upperStrength, intensityChanged ? 350 : 650);
    }
    const paused = this.intensity === 0;
    if (paused !== this.paused) this.current?.playback.setPaused(paused);
    this.paused = paused;
    if (
      paused ||
      this.pending ||
      (this.current && !this.current.playback.held) ||
      this.elapsedMs < this.retryAtMs
    )
      return;
    const candidates = this.units.filter((unit) => unit.context === context);
    // Keep a compatible recorded weight shift available when the requested
    // activity has a different stance. Its arms stay suppressed; the new
    // activity's upper performance can continue over the supporting legs.
    if (this.current && this.current.unit.context !== context) candidates.push(this.current.unit);
    if (candidates.length === 0) return;
    this.pending = true;
    const generation = ++this.generation;
    void this.selectNext(candidates, generation);
  }

  private async selectNext(
    candidates: readonly RecordedBodyUnit[],
    generation: number,
    initialPose = false,
  ): Promise<void> {
    const isCurrent = () => !this.disposed && this.enabled && generation === this.generation;
    // Prefer less recent complete units. Physical acceptance remains a hard gate
    // inside playRecordedBase; a rejected candidate does not retire the old base.
    const pool = candidates.map((unit) => {
      const age = this.elapsedMs - (this.lastPlayed.get(unit.id) ?? -120_000);
      const weight =
        unit.id === this.current?.unit.id ? 0.1 : Math.min(1, Math.max(0.15, age / 60_000));
      return { unit, weight };
    });
    try {
      while (pool.length > 0 && isCurrent() && (initialPose || this.intensity > 0)) {
        const contextual = pool.some((item) => item.unit.context === this.context)
          ? pool.filter((item) => item.unit.context === this.context)
          : pool;
        const alternatives = contextual.filter((item) => item.unit.id !== this.current?.unit.id);
        const eligible = alternatives.length > 0 ? alternatives : contextual;
        const random = this.options.random?.() ?? Math.random();
        let draw =
          (Number.isFinite(random) ? Math.max(0, Math.min(0.999999, random)) : 0.5) *
          eligible.reduce((sum, item) => sum + item.weight, 0);
        let selected = eligible.length - 1;
        for (let i = 0; i < eligible.length; i++) {
          draw -= eligible[i].weight;
          if (draw < 0) {
            selected = i;
            break;
          }
        }
        const candidate = eligible[selected];
        pool.splice(pool.indexOf(candidate), 1);
        const { unit } = candidate;
        try {
          const playback = await this.player.playRecordedBase(unit.animation, {
            startTimeSec: unit.startTimeSec,
            endTimeSec: unit.endTimeSec,
            contactWindows: unit.contactWindows,
            fadeInMs: initialPose ? 0 : 800,
            initialPose,
            axialReferenceTimeSec: unit.axialReferenceTimeSec,
            isCurrent,
            onCommit: this.options.onCommit,
            getInitialState: () => ({
              paused: this.intensity === 0,
              axialStrength: this.axialStrength,
              upperWeight:
                this.allowBaseUpper && unit.context === this.context ? this.intensity : 0,
            }),
          });
          if (!isCurrent()) {
            playback.cancel();
            return;
          }
          this.current = { unit, playback };
          this.upperEnabled =
            this.intensity > 0 && this.allowBaseUpper && unit.context === this.context;
          this.upperStrength = this.upperEnabled ? this.intensity : 0;
          this.paused = this.intensity === 0;
          // A new lower-body unit must inherit the current upper ownership at
          // once. Fading from its default gain of one would briefly bring idle
          // arms back during listening/speech on every lower-body transition.
          playback.setUpperWeight(this.upperStrength, 0);
          playback.setPaused(this.paused);
          playback.setAxialStrength(this.axialStrength, 0);
          this.lastPlayed.set(unit.id, this.elapsedMs);
          this.lastRejection = null;
          return;
        } catch (error) {
          if (!isCurrent()) return;
          // A contact mismatch is pose-dependent; do not permanently exclude the
          // recording. Missing/invalid clips were screened by prepareOnce.
          if (error instanceof DOMException && error.name === "AbortError") return;
          this.lastRejection = error instanceof Error ? error.message : String(error);
          if (initialPose) this.initialRejection = this.lastRejection;
        }
      }
      this.retryAtMs = this.elapsedMs + 2_000;
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }

  get active(): boolean {
    return this.current !== null;
  }
  get ownsUpperBody(): boolean {
    return (
      this.intensity > 0 &&
      this.allowBaseUpper &&
      this.current !== null &&
      this.current.unit.context === this.context
    );
  }

  get allowsHandFidget(): boolean {
    return this.ownsUpperBody && this.current?.unit.handsAtRest === true;
  }

  getSnapshot() {
    return {
      axialStrength: this.axialStrength,
      targetModelSha256: this.options.modelSha256 ?? null,
      availableUnits: this.units.length,
      pending: this.pending,
      lastRejection: this.lastRejection,
      initialRejection: this.initialRejection,
      lastSuspension: this.lastSuspension,
      active: this.current
        ? {
            id: this.current.unit.id,
            animation: this.current.unit.animation,
            context: this.current.unit.context,
            phaseSec: this.current.playback.phaseSec,
            held: this.current.playback.held,
            paused: this.current.playback.paused,
            upperEnabled: this.upperEnabled,
            upperStrength: this.upperStrength,
          }
        : null,
    };
  }

  suspend(fadeMs = 650, reason = "disabled"): void {
    this.enabled = false;
    if (!this.pending && !this.current) return;
    if (this.current) this.lastSuspension = { reason, unit: this.current.unit.id };
    this.generation++;
    this.pending = false;
    const previous = this.current;
    this.current = null;
    if (fadeMs <= 0) previous?.playback.cancel();
    else void previous?.playback.stop(fadeMs);
  }

  dispose(): void {
    this.disposed = true;
    this.suspend(0);
  }
}

function clampIntensity(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
}

async function loadBundledManifest(): Promise<unknown> {
  const response = await fetch("/animations/recorded-body/manifest.json");
  if (!response.ok) return null;
  return response.json();
}

export function parseRecordedBodyManifest(
  input: unknown,
  modelSha256: string,
): RecordedBodyManifest | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<RecordedBodyManifest>;
  if (
    value.schemaVersion !== 1 ||
    value.targetModelSha256 !== modelSha256 ||
    !Array.isArray(value.units) ||
    value.units.length > 64
  )
    return null;
  const ids = new Set<string>();
  for (const unit of value.units) {
    if (
      !unit ||
      typeof unit.id !== "string" ||
      ids.has(unit.id) ||
      typeof unit.animation !== "string" ||
      !/^\/animations\/recorded-body\/[A-Za-z0-9_-]+\.vrma$/.test(unit.animation) ||
      !["idle", "speech"].includes(unit.context) ||
      (unit.handsAtRest !== undefined && typeof unit.handsAtRest !== "boolean") ||
      !Number.isFinite(unit.startTimeSec) ||
      !Number.isFinite(unit.endTimeSec) ||
      unit.startTimeSec < 0 ||
      unit.endTimeSec - unit.startTimeSec < 2 ||
      unit.endTimeSec > 180 ||
      !Array.isArray(unit.contactWindows) ||
      unit.contactWindows.length > 64 ||
      !unit.contactWindows.every(
        (window: RecordedBodyUnit["contactWindows"][number]) =>
          window &&
          typeof window === "object" &&
          window.feet === "both" &&
          Number.isFinite(window.startTimeSec) &&
          Number.isFinite(window.endTimeSec) &&
          window.startTimeSec >= 0 &&
          window.endTimeSec > window.startTimeSec,
      )
    )
      return null;
    if (
      ![unit.startTimeSec, unit.endTimeSec].every((time) =>
        unit.contactWindows.some(
          (window: RecordedBodyUnit["contactWindows"][number]) =>
            time >= window.startTimeSec && time <= window.endTimeSec,
        ),
      )
    )
      return null;
    if (
      unit.axialReferenceTimeSec !== undefined &&
      (!Number.isFinite(unit.axialReferenceTimeSec) || unit.axialReferenceTimeSec < 0)
    )
      return null;
    ids.add(unit.id);
  }
  return value as RecordedBodyManifest;
}
