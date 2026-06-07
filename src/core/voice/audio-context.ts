type RuntimeAudioContextState = AudioContextState | "interrupted";

let sharedCtx: AudioContext | null = null;
let gestureResumeAttached = new WeakSet<AudioContext>();

/** 24 kHz の共有 AudioContext を返す。ブラウザの autoplay policy 対策込み。 */
export function getAudioContext(): AudioContext {
  if (!sharedCtx || getRuntimeState(sharedCtx) === "closed") {
    sharedCtx = createAudioContext();
    attachGestureResume(sharedCtx);
  }
  return sharedCtx;
}

/**
 * 共有 AudioContext を再生可能な状態にする。
 *
 * WebKit/WKWebView は長時間の非操作・sleep・画面ロック等で `interrupted`
 * に遷移することがある。`suspended` だけを見ると、合成済み buffer の
 * 解析で口だけ動き、実音声は出ない状態に入り得る。
 */
export async function ensureAudioContextRunning(): Promise<AudioContext> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctx = getAudioContext();
    const state = getRuntimeState(ctx);

    if (state === "running") return ctx;
    if (state === "closed") {
      if (sharedCtx === ctx) sharedCtx = null;
      continue;
    }

    if (state === "suspended" || state === "interrupted") {
      try {
        await ctx.resume();
      } catch (error) {
        if (getRuntimeState(ctx) === "closed" && sharedCtx === ctx) {
          sharedCtx = null;
          continue;
        }
        throw error;
      }

      const resumedState = getRuntimeState(ctx);
      if (resumedState === "running") return ctx;
      if (resumedState === "closed" && sharedCtx === ctx) {
        sharedCtx = null;
        continue;
      }
      throw new Error(`AudioContext is not running after resume (state: ${resumedState})`);
    }

    throw new Error(`AudioContext is not running (state: ${state})`);
  }

  throw new Error("AudioContext could not be recreated");
}

function createAudioContext(): AudioContext {
  return new AudioContext({ sampleRate: 24000 });
}

function getRuntimeState(ctx: AudioContext): RuntimeAudioContextState {
  return ctx.state as RuntimeAudioContextState;
}

function attachGestureResume(ctx: AudioContext): void {
  if (gestureResumeAttached.has(ctx) || typeof window === "undefined") return;
  gestureResumeAttached.add(ctx);

  const resume = () => {
    const state = getRuntimeState(ctx);
    if (state === "suspended" || state === "interrupted") void ctx.resume();
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
  gestureResumeAttached = new WeakSet<AudioContext>();
}
