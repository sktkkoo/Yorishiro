type RuntimeAudioContextState = AudioContextState | "interrupted";

let sharedCtx: AudioContext | null = null;
let gestureResumeCleanups = new WeakMap<AudioContext, () => void>();

/** 24 kHz の共有 AudioContext を返す。ブラウザの autoplay policy 対策込み。 */
export function getAudioContext(): AudioContext {
  if (sharedCtx && getRuntimeState(sharedCtx) === "closed") {
    releaseAudioContext(sharedCtx);
  }
  if (!sharedCtx) {
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

    switch (state) {
      case "running":
        return ctx;
      case "closed":
        releaseAudioContext(ctx);
        continue;
      case "suspended":
      case "interrupted":
        try {
          await ctx.resume();
        } catch (error) {
          if (getRuntimeState(ctx) === "closed") {
            releaseAudioContext(ctx);
            continue;
          }
          throw error;
        }

        {
          const resumedState = getRuntimeState(ctx);
          if (resumedState === "running") return ctx;
          if (resumedState === "closed") {
            releaseAudioContext(ctx);
            continue;
          }
          throw new Error(`AudioContext is not running after resume (state: ${resumedState})`);
        }
    }
  }

  throw new Error("AudioContext could not be recreated");
}

function releaseAudioContext(ctx: AudioContext): void {
  detachGestureResume(ctx);
  if (sharedCtx === ctx) sharedCtx = null;
}

function createAudioContext(): AudioContext {
  return new AudioContext({ sampleRate: 24000 });
}

function getRuntimeState(ctx: AudioContext): RuntimeAudioContextState {
  return ctx.state as RuntimeAudioContextState;
}

function attachGestureResume(ctx: AudioContext): void {
  if (gestureResumeCleanups.has(ctx) || typeof window === "undefined") return;

  let attached = true;
  const detach = () => {
    if (!attached) return;
    attached = false;
    window.removeEventListener("keydown", resume);
    window.removeEventListener("mousedown", resume);
    window.removeEventListener("touchstart", resume);
    gestureResumeCleanups.delete(ctx);
  };

  const resume = () => {
    try {
      const state = getRuntimeState(ctx);
      if (state === "suspended" || state === "interrupted") void ctx.resume();
    } finally {
      detach();
    }
  };

  gestureResumeCleanups.set(ctx, detach);
  window.addEventListener("keydown", resume, { once: true });
  window.addEventListener("mousedown", resume, { once: true });
  window.addEventListener("touchstart", resume, { once: true });
}

function detachGestureResume(ctx: AudioContext): void {
  gestureResumeCleanups.get(ctx)?.();
}

/** テスト用: シングルトンをリセットする */
export function _resetAudioContext(): void {
  if (sharedCtx) detachGestureResume(sharedCtx);
  sharedCtx = null;
  gestureResumeCleanups = new WeakMap<AudioContext, () => void>();
}
