/**
 * camera-move — Three.js camera を短く動かして元に戻す bundled Effect Pack。
 *
 * Effect は `RendererAPI.addCameraMove` に委譲し、camera claim / restore は
 * renderer 側で扱う。persona handler からは `ctx.space.injectEffect` で
 * passive に発火するだけにする。
 */

import type { EffectContext, EffectDefinition, Vec3 } from "@charminal/sdk";

interface CameraMoveOptions {
  readonly offset?: Partial<Vec3>;
  readonly fovOffset?: number;
  readonly durationMs?: number;
  readonly holdMs?: number;
  readonly restoreMs?: number;
  readonly lookAt?: Vec3;
}

const DEFAULT_OFFSET = { z: 0.28 } as const;
const DEFAULT_FOV_OFFSET = 3;
const DEFAULT_DURATION_MS = 180;
const DEFAULT_HOLD_MS = 260;
const DEFAULT_RESTORE_MS = 620;

export default {
  id: "camera-move",
  type: "effect",
  singleton: true,
  run: async (ctx: EffectContext<CameraMoveOptions>, options: CameraMoveOptions): Promise<void> => {
    const durationMs = options.durationMs ?? DEFAULT_DURATION_MS;
    const holdMs = options.holdMs ?? DEFAULT_HOLD_MS;
    const restoreMs = options.restoreMs ?? DEFAULT_RESTORE_MS;
    const handle = ctx.renderer.addCameraMove({
      durationMs,
      holdMs,
      restoreMs,
      offset: options.offset ?? DEFAULT_OFFSET,
      fovOffset: options.fovOffset ?? DEFAULT_FOV_OFFSET,
      lookAt: options.lookAt,
    });

    const cleanup = (): void => handle.dispose();
    ctx.signal.addEventListener("abort", cleanup, { once: true });

    try {
      await ctx.time.after(durationMs + holdMs + restoreMs);
    } finally {
      ctx.signal.removeEventListener("abort", cleanup);
      cleanup();
    }
  },
} satisfies EffectDefinition<CameraMoveOptions>;
