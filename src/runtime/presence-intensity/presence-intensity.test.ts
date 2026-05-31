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
    // デフォルトは available（既存テストの挙動を維持）。
    // el は applyPresenceLevel の実装では使われないため stub で十分。
    resolvePresence: () => ({ ok: true, el: {} as HTMLElement, target: "shell" }),
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

  it("default → closed: state が closed / mcp に更新される", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);

    const state = getPresenceState();
    expect(state.level).toBe("closed");
    expect(state.source).toBe("mcp");
    expect(state.levelSince).toBe(1000);
  });

  it("closed → default: state が default に復帰する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);
    applyPresenceLevel("default", "default", deps);

    const state = getPresenceState();
    expect(state.level).toBe("default");
    expect(state.source).toBe("default");
  });

  // -----------------------------------------------------------------------
  // Sidebar tween
  // -----------------------------------------------------------------------

  it("closed では sidebar を 0 に tween する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);

    expect(deps.tweenManager.start).toHaveBeenCalledWith(
      "presence.sidebar.width",
      0,
      expect.any(Number),
      deps.setSidebarWidth,
      { from: 280, easing: expect.any(Function) },
    );
  });

  it("default では sidebar を defaultWidth に tween する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);

    // default に戻す
    applyPresenceLevel("default", "default", deps);

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

  it("default では aura を enable する", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);
    applyPresenceLevel("default", "default", deps);

    expect(deps.ambientUiRegistry.enable).toHaveBeenCalledWith("attention-aura");
  });

  it("closed では tween 完了後に aura を disable する", async () => {
    const deps = createMockDeps();

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((r) => {
      resolveCompletion = r;
    });
    vi.mocked(deps.tweenManager.start).mockReturnValueOnce({
      cancel: vi.fn(),
      completion,
    });

    applyPresenceLevel("closed", "mcp", deps);

    expect(deps.ambientUiRegistry.disable).not.toHaveBeenCalled();
    resolveCompletion();
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.ambientUiRegistry.disable).toHaveBeenCalledWith("attention-aura");
  });

  // -----------------------------------------------------------------------
  // Render loop pause / resume
  // -----------------------------------------------------------------------

  it("default → closed: tween 完了後に render を pause する", async () => {
    const deps = createMockDeps();

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((r) => {
      resolveCompletion = r;
    });
    vi.mocked(deps.tweenManager.start).mockReturnValueOnce({
      cancel: vi.fn(),
      completion,
    });

    applyPresenceLevel("closed", "mcp", deps);

    expect(deps.setRenderPaused).not.toHaveBeenCalledWith(true);
    resolveCompletion();
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.setRenderPaused).toHaveBeenCalledWith(true);
  });

  it("closed → default: 即時に render を resume する（tween 開始前）", () => {
    const deps = createMockDeps();
    applyPresenceLevel("closed", "mcp", deps);
    vi.mocked(deps.setRenderPaused).mockClear();

    applyPresenceLevel("default", "default", deps);

    // tween より先に resume が呼ばれる
    expect(deps.setRenderPaused).toHaveBeenCalledWith(false);
    const calls = vi.mocked(deps.setRenderPaused).mock.calls;
    expect(calls[0]?.[0]).toBe(false);
  });

  it("closed → default の高速 toggle: completion 後に default なら pause しない", async () => {
    const deps = createMockDeps();

    let resolveCompletion!: () => void;
    const completion = new Promise<void>((r) => {
      resolveCompletion = r;
    });
    vi.mocked(deps.tweenManager.start).mockReturnValueOnce({
      cancel: vi.fn(),
      completion,
    });

    applyPresenceLevel("closed", "mcp", deps);
    // tween 完了前に default に戻す
    applyPresenceLevel("default", "default", deps);
    // completion を resolve
    resolveCompletion();
    await Promise.resolve();
    await Promise.resolve();

    const trueCalls = vi.mocked(deps.setRenderPaused).mock.calls.filter((c) => c[0] === true);
    expect(trueCalls).toHaveLength(0);
    expect(deps.ambientUiRegistry.disable).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // 同一レベル適用 — effect スキップ + source 更新
  // -----------------------------------------------------------------------

  it("同一レベルへの適用は effect をスキップするが source を更新する", () => {
    const deps = createMockDeps();
    // 初期は default / default
    applyPresenceLevel("default", "mcp", deps);

    const state = getPresenceState();
    expect(state.source).toBe("mcp");
    // tween は呼ばれない
    expect(deps.tweenManager.start).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // onUserPromptSubmit
  // -----------------------------------------------------------------------

  it("onUserPromptSubmit は previousLevel を保存して default に復帰する", () => {
    const deps = createMockDeps({ now: vi.fn(() => 2000) });
    applyPresenceLevel("closed", "mcp", deps);

    const deps2 = createMockDeps({ now: vi.fn(() => 3000) });
    onUserPromptSubmit(deps2);

    const state = getPresenceState();
    expect(state.level).toBe("default");
    expect(state.source).toBe("default");
    expect(state.previousLevel).toBe("closed");
    expect(state.previousLevelSince).toBe(2000);
  });

  it("onUserPromptSubmit で既に default の場合は source を default にリセットするだけ", () => {
    const deps = createMockDeps();
    applyPresenceLevel("default", "mcp", deps);

    const deps2 = createMockDeps();
    onUserPromptSubmit(deps2);

    const state = getPresenceState();
    expect(state.level).toBe("default");
    expect(state.source).toBe("default");
    expect(state.previousLevel).toBe("default");
    expect(deps2.tweenManager.start).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // getPresenceSnapshot
  // -----------------------------------------------------------------------

  it("getPresenceSnapshot は plain object のコピーを返す", () => {
    const deps = createMockDeps({ now: vi.fn(() => 5000) });
    applyPresenceLevel("closed", "mcp", deps);

    const snapshot = getPresenceSnapshot();
    expect(snapshot).toEqual({
      level: "closed",
      levelSince: 5000,
      previousLevel: null,
      previousLevelSince: null,
      source: "mcp",
    });

    // snapshot は state と独立していることを確認
    const state = getPresenceState();
    state.level = "default";
    expect(snapshot.level).toBe("closed");
  });

  // -----------------------------------------------------------------------
  // loud-unavailable（spec §4）— resolvePresence が失敗するとき
  // -----------------------------------------------------------------------

  it("presence unavailable のとき applyPresenceLevel は no-op + typed unavailable", () => {
    let sidebarCalls = 0;
    const deps = createMockDeps({
      setSidebarWidth: () => {
        sidebarCalls++;
      },
      resolvePresence: () => ({ ok: false, reason: "no presence target" }),
    });
    const result = applyPresenceLevel("closed", "mcp", deps);
    expect(result).toEqual({ unavailable: true, reason: "no presence target" });
    expect(sidebarCalls).toBe(0);
    expect(getPresenceState().level).toBe("default"); // state 不変
    expect(getPresenceState().source).toBe("default");
  });

  it("presence available のとき applyPresenceLevel は従来通り適用し { applied: true }", () => {
    const deps = createMockDeps({
      resolvePresence: () => ({ ok: true, el: {} as HTMLElement, target: "shell" }),
    });
    const result = applyPresenceLevel("closed", "mcp", deps);
    expect(result).toMatchObject({ applied: true });
    expect("completion" in result).toBe(true);
    expect(getPresenceState().level).toBe("closed");
  });
});
