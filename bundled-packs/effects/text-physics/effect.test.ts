import type { EffectContext, TerminalCellData, Vec2 } from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import textPhysics from "./effect";

/**
 * text-physics effect pack の unit test。
 *
 * 物理演算の具体的な動き（速度・角度・バウンド位置など）は brittle になるため
 * test しない。肌触り parameter は帰納的に実装中で調整する
 * （CLAUDE.md「感触 parameter は帰納的に」方針）。
 *
 * ここで守るのは pack の「形」と lifecycle：
 *   1. pack が EffectDefinition の shape を満たすこと（id / type）
 *   2. `queryTerminalCells` が呼ばれること
 *   3. `addDomLayer` が 1 回だけ呼ばれること
 *   4. `queryTerminalCells` が null を返す場合に `addDomLayer` が呼ばれないこと
 *   5. 成功・失敗どちらの経路でも handle が dispose されること
 */

interface TextPhysicsOptions {
  readonly origin: Vec2;
  readonly force: number;
  readonly gravity?: number;
}

/** テスト用の最小 TerminalCellData fixture */
function createCellDataFixture(): TerminalCellData {
  const cells = [];
  // 2 行 x 3 列のミニ terminal
  for (let row = 0; row < 2; row++) {
    for (let col = 0; col < 3; col++) {
      cells.push({
        char: "A",
        x: col * 10,
        y: row * 20,
        row,
        col,
        fgColor: "#ffffff",
      });
    }
  }
  return {
    cells,
    cellWidth: 10,
    cellHeight: 20,
    terminalRect: { left: 0, top: 0, width: 30, height: 40 },
    cols: 3,
    rows: 2,
  };
}

/**
 * mock ctx を組み立てる helper。個々の test で必要なフィールドだけ override する。
 */
function createMockCtx(overrides: {
  after?: () => Promise<void>;
  addDomLayerReturn?: { dispose: ReturnType<typeof vi.fn> };
  addDomLayer?: ReturnType<typeof vi.fn>;
  queryTerminalCells?: ReturnType<typeof vi.fn>;
}) {
  const dispose = overrides.addDomLayerReturn?.dispose ?? vi.fn();
  const addDomLayer = overrides.addDomLayer ?? vi.fn(() => ({ dispose }));
  const queryTerminalCells = overrides.queryTerminalCells ?? vi.fn(() => createCellDataFixture());
  const after = vi.fn(overrides.after ?? (() => Promise.resolve()));
  const ctx = {
    options: { origin: { x: 0.5, y: 0.5 }, force: 100 },
    time: { after },
    signal: new AbortController().signal,
    renderer: {
      addDomLayer,
      queryTerminalCells,
      addShakeFilter: vi.fn(),
      addCssFilter: vi.fn(),
      addParticles: vi.fn(),
      drawOnCanvas: vi.fn(),
    },
    audio: { play: vi.fn(async () => {}) },
  } as unknown as EffectContext<TextPhysicsOptions>;
  return { ctx, dispose, addDomLayer, queryTerminalCells, after };
}

describe("text-physics effect", () => {
  it("EffectDefinition の shape を満たす（id: 'text-physics', type: 'effect'）", () => {
    expect(textPhysics.id).toBe("text-physics");
    expect(textPhysics.type).toBe("effect");
  });

  it("queryTerminalCells を呼ぶ", async () => {
    const { ctx, queryTerminalCells } = createMockCtx({});

    await textPhysics.run(ctx, {
      origin: { x: 0.5, y: 0.5 },
      force: 100,
    });

    expect(queryTerminalCells).toHaveBeenCalled();
  });

  it("addDomLayer を 1 回だけ呼ぶ", async () => {
    const { ctx, addDomLayer } = createMockCtx({});

    await textPhysics.run(ctx, {
      origin: { x: 0.5, y: 0.5 },
      force: 100,
    });

    expect(addDomLayer).toHaveBeenCalledOnce();
  });

  it("queryTerminalCells が null を返す場合、addDomLayer を呼ばない", async () => {
    const { ctx, addDomLayer } = createMockCtx({
      queryTerminalCells: vi.fn(() => null),
    });

    await textPhysics.run(ctx, {
      origin: { x: 0.5, y: 0.5 },
      force: 100,
    });

    expect(addDomLayer).not.toHaveBeenCalled();
  });

  it("正常完了後に handle を dispose する", async () => {
    const { ctx, dispose } = createMockCtx({});

    await textPhysics.run(ctx, {
      origin: { x: 0.5, y: 0.5 },
      force: 100,
    });

    expect(dispose).toHaveBeenCalledOnce();
  });

  it("time.after が reject しても handle を dispose する", async () => {
    const { ctx, dispose } = createMockCtx({
      after: () => Promise.reject(new Error("boom")),
    });

    await expect(
      textPhysics.run(ctx, {
        origin: { x: 0.5, y: 0.5 },
        force: 100,
      }),
    ).rejects.toThrow("boom");

    expect(dispose).toHaveBeenCalledOnce();
  });
});
