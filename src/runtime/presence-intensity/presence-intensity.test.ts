import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TweenManager } from "../../core/tween/tween-manager";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry/types";
import type { PresenceIntensityDeps } from "./presence-intensity";
import {
  _resetForTest,
  applyPresenceLevel,
  getPresenceSnapshot,
  getPresenceState,
  onUserPromptSubmit,
} from "./presence-intensity";

function createMockDeps(overrides?: Partial<PresenceIntensityDeps>): PresenceIntensityDeps {
  return {
    setSidebarWidth: vi.fn(),
    getSidebarWidth: vi.fn(() => 280),
    getDefaultSidebarWidth: vi.fn(() => 280),
    tweenManager: {
      start: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
      cancel: vi.fn(),
    } as unknown as TweenManager,
    ambientUiRegistry: {
      enable: vi.fn(),
      disable: vi.fn(),
    } as unknown as AmbientUiPackRegistry,
    setRenderPaused: vi.fn(),
    now: vi.fn(() => 1000),
    ...overrides,
  };
}

describe("PresenceIntensity", () => {
  beforeEach(() => {
    _resetForTest();
  });

  // -----------------------------------------------------------------------
  // applyPresenceLevel — レベル遷移
  // -----------------------------------------------------------------------

  it("full → aura-only: state が aura-only / mcp に更新される", () => {
    const deps = createMockDeps();
    applyPresenceLevel("aura-only", "mcp", deps);

    const state = getPresenceState();
    expect(state.level).toBe("aura-only");
    expect(state.source).toBe("mcp");
    expect(state.levelSince).toBe(1000);
  });

  it("aura-only → full: state が full に復帰する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("aura-only", "mcp", deps);
    applyPresenceLevel("full", "default", deps);

    const state = getPresenceState();
    expect(state.level).toBe("full");
    expect(state.source).toBe("default");
  });

  // -----------------------------------------------------------------------
  // Sidebar tween
  // -----------------------------------------------------------------------

  it("aura-only では sidebar を 0 に tween する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("aura-only", "mcp", deps);

    expect(deps.tweenManager.start).toHaveBeenCalledWith(
      "presence.sidebar.width",
      0,
      expect.any(Number),
      deps.setSidebarWidth,
      { from: 280 },
    );
  });

  it("full では sidebar を defaultWidth に tween する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("aura-only", "mcp", deps);

    // full に戻す
    applyPresenceLevel("full", "default", deps);

    // 最後の呼び出しを確認
    const calls = (deps.tweenManager.start as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toBe("presence.sidebar.width");
    expect(lastCall?.[1]).toBe(280); // defaultWidth
  });

  // -----------------------------------------------------------------------
  // VRM visibility は sidebar の display:none に追従させるため、ここでの hook は持たない。
  // -----------------------------------------------------------------------

  // -----------------------------------------------------------------------
  // Aura
  // -----------------------------------------------------------------------

  it("full / aura-only では aura を enable する", () => {
    const deps = createMockDeps();
    // full → aura-only
    applyPresenceLevel("aura-only", "mcp", deps);

    expect(deps.ambientUiRegistry.enable).toHaveBeenCalledWith("attention-aura");
  });

  it("aura-only でも aura は enable のまま", () => {
    const deps = createMockDeps();
    applyPresenceLevel("aura-only", "mcp", deps);

    expect(deps.ambientUiRegistry.enable).toHaveBeenCalledWith("attention-aura");
    expect(deps.ambientUiRegistry.disable).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Render loop pause / resume
  // -----------------------------------------------------------------------

  it("full → aura-only: tween 完了後に render を pause する", async () => {
    const deps = createMockDeps();
    applyPresenceLevel("aura-only", "mcp", deps);

    await Promise.resolve();
    expect(deps.setRenderPaused).toHaveBeenCalledWith(true);
  });

  it("aura-only → full: 即時に render を resume する（tween 開始前）", () => {
    const deps = createMockDeps();
    applyPresenceLevel("aura-only", "mcp", deps);
    vi.mocked(deps.setRenderPaused).mockClear();

    applyPresenceLevel("full", "default", deps);

    // tween より先に resume が呼ばれる
    expect(deps.setRenderPaused).toHaveBeenCalledWith(false);
    const calls = vi.mocked(deps.setRenderPaused).mock.calls;
    expect(calls[0]?.[0]).toBe(false);
  });

  it("aura-only → full の高速 toggle: completion 後に full なら pause しない", async () => {
    const deps = createMockDeps();

    // completion を手動制御するため manual promise を返すようにする
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((r) => {
      resolveCompletion = r;
    });
    vi.mocked(deps.tweenManager.start).mockReturnValueOnce({
      cancel: vi.fn(),
      completion,
    });

    applyPresenceLevel("aura-only", "mcp", deps);
    // tween 完了前に full に戻す
    applyPresenceLevel("full", "default", deps);
    // completion を resolve
    resolveCompletion();
    await Promise.resolve();
    await Promise.resolve();

    // setRenderPaused(true) は呼ばれていないはず（full に戻っているため）
    const trueCalls = vi.mocked(deps.setRenderPaused).mock.calls.filter((c) => c[0] === true);
    expect(trueCalls).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 同一レベル適用 — effect スキップ + source 更新
  // -----------------------------------------------------------------------

  it("同一レベルへの適用は effect をスキップするが source を更新する", () => {
    const deps = createMockDeps();
    // 初期は full / default
    applyPresenceLevel("full", "mcp", deps);

    const state = getPresenceState();
    expect(state.source).toBe("mcp");
    // tween は呼ばれない
    expect(deps.tweenManager.start).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // onUserPromptSubmit
  // -----------------------------------------------------------------------

  it("onUserPromptSubmit は previousLevel を保存して full に復帰する", () => {
    const deps = createMockDeps({ now: vi.fn(() => 2000) });
    applyPresenceLevel("aura-only", "mcp", deps);

    const deps2 = createMockDeps({ now: vi.fn(() => 3000) });
    onUserPromptSubmit(deps2);

    const state = getPresenceState();
    expect(state.level).toBe("full");
    expect(state.source).toBe("default");
    expect(state.previousLevel).toBe("aura-only");
    expect(state.previousLevelSince).toBe(2000);
  });

  it("onUserPromptSubmit で既に full の場合は source を default にリセットするだけ", () => {
    const deps = createMockDeps();
    // 初期状態は full / default — source を mcp に変えてから試す
    applyPresenceLevel("full", "mcp", deps);

    const deps2 = createMockDeps();
    onUserPromptSubmit(deps2);

    const state = getPresenceState();
    expect(state.level).toBe("full");
    expect(state.source).toBe("default");
    expect(state.previousLevel).toBe("full");
    // full のまま — tween などは呼ばれない
    expect(deps2.tweenManager.start).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // getPresenceSnapshot
  // -----------------------------------------------------------------------

  it("getPresenceSnapshot は plain object のコピーを返す", () => {
    const deps = createMockDeps({ now: vi.fn(() => 5000) });
    applyPresenceLevel("aura-only", "mcp", deps);

    const snapshot = getPresenceSnapshot();
    expect(snapshot).toEqual({
      level: "aura-only",
      levelSince: 5000,
      previousLevel: null,
      previousLevelSince: null,
      source: "mcp",
    });

    // snapshot は state と独立していることを確認
    const state = getPresenceState();
    state.level = "full";
    expect(snapshot.level).toBe("aura-only");
  });
});
