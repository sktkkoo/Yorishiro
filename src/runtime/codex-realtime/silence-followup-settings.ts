import { isRealtimeDebugEnabled, subscribeRealtimeDebug } from "./realtime-debug";
export interface SilenceFollowupSettings {
  readonly enabled: boolean;
  readonly silenceSeconds: number;
  readonly cooldownSeconds: number;
}
export const DEFAULT_SILENCE_FOLLOWUP: SilenceFollowupSettings = {
  enabled: false,
  silenceSeconds: 60,
  cooldownSeconds: 300,
};
const KEY = "yorishiro.realtime.silence-followup.v1";
const EVENT = "yorishiro:realtime-silence-settings";
const bounded = (value: unknown, fallback: number, min: number, max: number) =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
/** ローカル実験フラグと機能の選択が両方有効になるまで、会話を収集しない。 */
export function readSilenceFollowupSettings(): SilenceFollowupSettings {
  if (!isRealtimeDebugEnabled()) return DEFAULT_SILENCE_FOLLOWUP;
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_SILENCE_FOLLOWUP;
    const settings = value as Record<string, unknown>;
    return {
      enabled: settings.enabled === true,
      silenceSeconds: bounded(settings.silenceSeconds, 60, 30, 600),
      cooldownSeconds: bounded(settings.cooldownSeconds, 300, 60, 3600),
    };
  } catch {
    return DEFAULT_SILENCE_FOLLOWUP;
  }
}
export function writeSilenceFollowupSettings(settings: SilenceFollowupSettings): void {
  if (!isRealtimeDebugEnabled()) return;
  const value = {
    enabled: settings.enabled === true,
    silenceSeconds: bounded(settings.silenceSeconds, 60, 30, 600),
    cooldownSeconds: bounded(settings.cooldownSeconds, 300, 60, 3600),
  };
  localStorage.setItem(KEY, JSON.stringify(value));
  window.dispatchEvent(new Event(EVENT));
}
export function subscribeSilenceFollowupSettings(listener: () => void): () => void {
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", storage);
  const debug = subscribeRealtimeDebug(listener);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", storage);
    debug();
  };
}
