import type { MotionContext } from "./motion-catalog";

export interface RecordedBodyUnit {
  readonly id: string;
  readonly animation: string;
  readonly context: MotionContext;
  /** Reviewed low hands that may receive a small relaxed hand fidget. */
  readonly handsAtRest?: boolean;
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
  stop(fadeMs?: number): Promise<void>;
  cancel(): void;
  setUpperWeight(value: number, fadeMs?: number): void;
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
  private readonly lastPlayed = new Map<string, number>();

  constructor(
    private readonly player: RecordedBodyPlayer,
    private readonly options: {
      modelSha256?: string;
      loadManifest?: () => Promise<unknown>;
      random?: () => number;
      onCommit?: () => void;
    } = {},
  ) {}

  prepare(): Promise<void> {
    this.prepared ??= this.prepareOnce();
    return this.prepared;
  }

  /** Called only before the avatar enters the rendered scene. */
  async initialize(): Promise<void> {
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

  update(deltaMs: number, enabled: boolean, context: MotionContext, allowBaseUpper = true): void {
    if (this.disposed) return;
    if (Number.isFinite(deltaMs)) this.elapsedMs += Math.max(0, Math.min(1_000, deltaMs));
    if (!enabled) {
      this.suspend(650);
      return;
    }
    this.enabled = true;
    if (this.context !== context && this.pending) {
      this.generation++;
      this.pending = false;
    }
    this.context = context;
    this.allowBaseUpper = allowBaseUpper;
    const upperEnabled = allowBaseUpper && this.current?.unit.context === context;
    if (upperEnabled !== this.upperEnabled) {
      this.upperEnabled = upperEnabled;
      this.current?.playback.setUpperWeight(upperEnabled ? 1 : 0, 650);
    }
    if (
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
      while (pool.length > 0 && isCurrent()) {
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
            isCurrent,
            onCommit: this.options.onCommit,
          });
          if (!isCurrent()) {
            playback.cancel();
            return;
          }
          this.current = { unit, playback };
          this.upperEnabled = this.allowBaseUpper && unit.context === this.context;
          // A new lower-body unit must inherit the current upper ownership at
          // once. Fading from its default gain of one would briefly bring idle
          // arms back during listening/speech on every lower-body transition.
          playback.setUpperWeight(this.upperEnabled ? 1 : 0, this.upperEnabled ? 650 : 0);
          this.lastPlayed.set(unit.id, this.elapsedMs);
          return;
        } catch (error) {
          if (!isCurrent()) return;
          // A contact mismatch is pose-dependent; do not permanently exclude the
          // recording. Missing/invalid clips were screened by prepareOnce.
          if (error instanceof DOMException && error.name === "AbortError") return;
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
      this.allowBaseUpper && this.current !== null && this.current.unit.context === this.context
    );
  }

  get allowsHandFidget(): boolean {
    return this.ownsUpperBody && this.current?.unit.handsAtRest === true;
  }

  getSnapshot() {
    return {
      targetModelSha256: this.options.modelSha256 ?? null,
      availableUnits: this.units.length,
      pending: this.pending,
      active: this.current
        ? {
            id: this.current.unit.id,
            animation: this.current.unit.animation,
            context: this.current.unit.context,
            phaseSec: this.current.playback.phaseSec,
            held: this.current.playback.held,
            upperEnabled: this.upperEnabled,
          }
        : null,
    };
  }

  suspend(fadeMs = 650): void {
    this.enabled = false;
    if (!this.pending && !this.current) return;
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
    ids.add(unit.id);
  }
  return value as RecordedBodyManifest;
}
