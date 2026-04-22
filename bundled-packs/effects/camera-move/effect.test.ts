import type { EffectContext } from "@charminal/sdk";
import { describe, expect, it, vi } from "vitest";
import cameraMove from "./effect";

interface CameraMoveOptions {
  readonly offset?: { readonly x?: number; readonly y?: number; readonly z?: number };
  readonly fovOffset?: number;
  readonly durationMs?: number;
  readonly holdMs?: number;
  readonly restoreMs?: number;
}

function createMockCtx(overrides?: {
  after?: () => Promise<void>;
  addCameraMove?: ReturnType<typeof vi.fn>;
}) {
  const dispose = vi.fn();
  const addCameraMove = overrides?.addCameraMove ?? vi.fn(() => ({ dispose }));
  const after = vi.fn(overrides?.after ?? (() => Promise.resolve()));
  const ctx = {
    options: {},
    time: { after },
    signal: new AbortController().signal,
    renderer: {
      addShakeFilter: vi.fn(),
      addCssFilter: vi.fn(),
      addCameraMove,
      addDomLayer: vi.fn(),
      addParticles: vi.fn(),
      drawOnCanvas: vi.fn(),
      queryTerminalCells: vi.fn(),
    },
    audio: { play: vi.fn(async () => {}) },
  } as unknown as EffectContext<CameraMoveOptions>;
  return { ctx, addCameraMove, after, dispose };
}

describe("camera-move effect", () => {
  it("EffectDefinition の shape を満たす", () => {
    expect(cameraMove.id).toBe("camera-move");
    expect(cameraMove.type).toBe("effect");
    expect(cameraMove.singleton).toBe(true);
  });

  it("default zoom-out camera move を追加する", async () => {
    const { ctx, addCameraMove } = createMockCtx();

    await cameraMove.run(ctx, {});

    expect(addCameraMove).toHaveBeenCalledWith({
      durationMs: 180,
      holdMs: 260,
      restoreMs: 620,
      offset: { z: 0.28 },
      fovOffset: 3,
      lookAt: undefined,
    });
  });

  it("options を addCameraMove に渡し、合計時間だけ待つ", async () => {
    const { ctx, addCameraMove, after } = createMockCtx();

    await cameraMove.run(ctx, {
      offset: { z: 0.4 },
      fovOffset: 5,
      durationMs: 100,
      holdMs: 200,
      restoreMs: 300,
    });

    expect(addCameraMove).toHaveBeenCalledWith({
      durationMs: 100,
      holdMs: 200,
      restoreMs: 300,
      offset: { z: 0.4 },
      fovOffset: 5,
      lookAt: undefined,
    });
    expect(after).toHaveBeenCalledWith(600);
  });

  it("完了時に camera move handle を dispose する", async () => {
    const { ctx, dispose } = createMockCtx();

    await cameraMove.run(ctx, {});

    expect(dispose).toHaveBeenCalledOnce();
  });
});
