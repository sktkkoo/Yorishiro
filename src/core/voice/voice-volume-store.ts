import { getOrInit } from "../../runtime/hot-data";
import { KEYS } from "../../runtime/module-registry/keys";

type VoiceVolumeListener = (volume: number) => void;

/** Clamp persisted/runtime voice volume to the supported unit interval. */
export function clampVoiceVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(1, value));
}

export class VoiceVolumeStore {
  private volume = 1;
  private readonly listeners = new Set<VoiceVolumeListener>();

  get(): number {
    return this.volume;
  }

  set(value: number): number {
    const next = clampVoiceVolume(value);
    if (next === this.volume) return next;
    this.volume = next;
    for (const listener of this.listeners) listener(next);
    return next;
  }

  subscribe(listener: VoiceVolumeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/** HMR-stable runtime source of truth for all voice output paths. */
export function getVoiceVolumeStore(): VoiceVolumeStore {
  return getOrInit(KEYS.VOICE_VOLUME, () => new VoiceVolumeStore());
}

/**
 * Creates the Settings write boundary: runtime audio changes first, persistence follows.
 * Only the newest request may roll the hot value back. Config writes are queued by App,
 * but newer slider requests intentionally update the store before older writes settle.
 */
export function createPersistedVoiceVolumeSetter(
  persist: (volume: number) => Promise<void>,
  store = getVoiceVolumeStore(),
): (volume: number) => Promise<void> {
  let latestRequest = 0;
  // Initialize lazily: App loads persisted config into the hot store after its
  // first render, while this setter is memoized during that render.
  let lastPersistedVolume: number | null = null;
  return async (volume: number): Promise<void> => {
    if (lastPersistedVolume === null) lastPersistedVolume = store.get();
    const request = ++latestRequest;
    const clamped = store.set(volume);
    try {
      await persist(clamped);
      // App's config queue settles writes in call order, so this is the latest
      // value known to have reached disk even while newer optimistic calls exist.
      lastPersistedVolume = clamped;
    } catch (error) {
      if (request === latestRequest) store.set(lastPersistedVolume);
      throw error;
    }
  };
}
