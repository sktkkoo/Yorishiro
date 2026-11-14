/** 開発者がこのアプリ内だけで明示的に有効化する。通常設定や Pack へ同期しない。 */
const KEY = "yorishiro:realtime-debug";
const EVENT = "yorishiro:realtime-debug-changed";

export function isRealtimeDebugEnabled(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setRealtimeDebugEnabled(enabled: boolean): void {
  try {
    if (enabled) globalThis.localStorage?.setItem(KEY, "1");
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // 保存不可なら無効のまま。診断設定が音声を停止させてはならない。
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}

export function subscribeRealtimeDebug(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const storage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === null) listener();
  };
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", storage);
  return () => {
    window.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", storage);
  };
}
