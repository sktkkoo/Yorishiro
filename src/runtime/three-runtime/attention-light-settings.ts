import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";

type Listener = () => void;

export class AttentionLightSettingsStore {
  private enabled = true;
  private readonly listeners = new Set<Listener>();

  getEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function getAttentionLightSettingsStore(): AttentionLightSettingsStore {
  return getOrInit(KEYS.ATTENTION_LIGHT_SETTINGS, () => new AttentionLightSettingsStore());
}
