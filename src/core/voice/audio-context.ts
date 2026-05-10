let sharedCtx: AudioContext | null = null;
let gestureListenerAttached = false;

/** 24 kHz の共有 AudioContext を返す。ブラウザの autoplay policy 対策込み。 */
export function getAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new AudioContext({ sampleRate: 24000 });
    attachGestureResume(sharedCtx);
  }
  return sharedCtx;
}

function attachGestureResume(ctx: AudioContext): void {
  if (gestureListenerAttached) return;
  gestureListenerAttached = true;

  const resume = () => {
    if (ctx.state === "suspended") ctx.resume();
    window.removeEventListener("keydown", resume);
    window.removeEventListener("mousedown", resume);
    window.removeEventListener("touchstart", resume);
  };
  window.addEventListener("keydown", resume, { once: true });
  window.addEventListener("mousedown", resume, { once: true });
  window.addEventListener("touchstart", resume, { once: true });
}

/** テスト用: シングルトンをリセットする */
export function _resetAudioContext(): void {
  sharedCtx = null;
  gestureListenerAttached = false;
}
