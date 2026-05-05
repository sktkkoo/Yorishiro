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
    tweenManager: { start: vi.fn(), cancel: vi.fn() } as unknown as TweenManager,
    ambientUiRegistry: {
      enable: vi.fn(),
      disable: vi.fn(),
    } as unknown as AmbientUiPackRegistry,
    setCharacterVisible: vi.fn(),
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

  it("full → closed: state が closed に更新される", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);

    const state = getPresenceState();
    expect(state.level).toBe("closed");
    expect(state.source).toBe("mcp");
  });

  it("closed → full: state が full に復帰する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);
    applyPresenceLevel("full", "default", deps);

    const state = getPresenceState();
    expect(state.level).toBe("full");
    expect(state.source).toBe("default");
  });

  // -----------------------------------------------------------------------
  // Sidebar tween
  // -----------------------------------------------------------------------

  it("aura-only / closed では sidebar を 0 に tween する", () => {
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
    applyPresenceLevel("closed", "mcp", deps);

    // full に戻す
    applyPresenceLevel("full", "default", deps);

    // 最後の呼び出しを確認
    const calls = (deps.tweenManager.start as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toBe("presence.sidebar.width");
    expect(lastCall?.[1]).toBe(280); // defaultWidth
  });

  // -----------------------------------------------------------------------
  // VRM visibility
  // -----------------------------------------------------------------------

  it("aura-only / closed では VRM を非表示にする", () => {
    const deps = createMockDeps();
    applyPresenceLevel("aura-only", "mcp", deps);

    expect(deps.setCharacterVisible).toHaveBeenCalledWith(false);
  });

  it("full では VRM を表示する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);
    applyPresenceLevel("full", "default", deps);

    const calls = (deps.setCharacterVisible as ReturnType<typeof vi.fn>).mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall?.[0]).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Aura
  // -----------------------------------------------------------------------

  it("full / aura-only では aura を enable する", () => {
    const deps = createMockDeps();
    // full → aura-only
    applyPresenceLevel("aura-only", "mcp", deps);

    expect(deps.ambientUiRegistry.enable).toHaveBeenCalledWith("attention-aura");
  });

  it("closed では aura を disable する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);

    expect(deps.ambientUiRegistry.disable).toHaveBeenCalledWith("attention-aura");
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
    expect(deps.setCharacterVisible).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 直接遷移（中間状態不要）
  // -----------------------------------------------------------------------

  it("full → closed の直接遷移が中間状態なしで動作する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);

    expect(getPresenceState().level).toBe("closed");
    expect(deps.tweenManager.start).toHaveBeenCalledTimes(1);
    expect(deps.setCharacterVisible).toHaveBeenCalledWith(false);
    expect(deps.ambientUiRegistry.disable).toHaveBeenCalledWith("attention-aura");
  });

  it("closed → aura-only の直接遷移が動作する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);

    vi.mocked(deps.tweenManager.start).mockClear();
    vi.mocked(deps.setCharacterVisible).mockClear();

    applyPresenceLevel("aura-only", "mcp", deps);

    expect(getPresenceState().level).toBe("aura-only");
    // aura-only: sidebar は 0 のまま
    expect(deps.tweenManager.start).toHaveBeenCalledWith(
      "presence.sidebar.width",
      0,
      expect.any(Number),
      deps.setSidebarWidth,
      { from: 280 },
    );
    // VRM は非表示のまま
    expect(deps.setCharacterVisible).toHaveBeenCalledWith(false);
    // aura は有効化
    expect(deps.ambientUiRegistry.enable).toHaveBeenCalledWith("attention-aura");
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
    expect(deps2.setCharacterVisible).not.toHaveBeenCalled();
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
    state.level = "closed";
    expect(snapshot.level).toBe("aura-only");
  });
});
