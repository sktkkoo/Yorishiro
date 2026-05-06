import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SessionId } from "../sessions/types";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: vi.fn(),
}));

vi.mock("../../bindings/tauri-commands", () => ({
  sessionSpawn: vi.fn().mockResolvedValue(undefined),
  sessionDestroy: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../terminal-runtime", () => ({
  getTerminalRuntime: vi.fn().mockReturnValue({
    attachTo: vi.fn(),
    detachContainer: vi.fn(),
    updatePtyParams: vi.fn(),
    dispose: vi.fn(),
    setPerception: vi.fn(),
    writePlainText: vi.fn(),
  }),
  disposeTerminalRuntime: vi.fn(),
}));

// dynamic import で mock が先に適用されることを保証
const { SessionTabManager } = await import("./session-tab-manager");
const { sessionSpawn, sessionDestroy } = await import("../../bindings/tauri-commands");
const { getTerminalRuntime, disposeTerminalRuntime } = await import("../terminal-runtime");

const MAIN: SessionId = "default-session";

describe("SessionTabManager", () => {
  let manager: InstanceType<typeof SessionTabManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionTabManager(MAIN);
  });

  // ── 初期状態 ──────────────────────────────────────────────────

  describe("初期状態", () => {
    it("main session のみで active = main", () => {
      const state = manager.getState();
      expect(state.sessions).toEqual([MAIN]);
      expect(state.activeSessionId).toBe(MAIN);
      expect(state.mainSessionId).toBe(MAIN);
    });
  });

  // ── openShell ─────────────────────────────────────────────────

  describe("openShell", () => {
    it("新 session が追加され active が移動する", async () => {
      const id = await manager.openShell(null);
      const state = manager.getState();
      expect(state.sessions).toContain(id);
      expect(state.activeSessionId).toBe(id);
      expect(state.sessions.length).toBe(2);
    });

    it("sessionSpawn が呼ばれる", async () => {
      await manager.openShell("/tmp");
      expect(sessionSpawn).toHaveBeenCalledTimes(1);
    });

    it("getTerminalRuntime が新 session id で呼ばれる", async () => {
      const id = await manager.openShell(null);
      expect(getTerminalRuntime).toHaveBeenCalledWith(id);
    });

    it("連続呼び出しで id が衝突しない", async () => {
      const id1 = await manager.openShell(null);
      const id2 = await manager.openShell(null);
      expect(id1).not.toBe(id2);
      expect(manager.getState().sessions.length).toBe(3);
    });

    it("spawn 失敗時に disposeTerminalRuntime が呼ばれエラーが throw される", async () => {
      (sessionSpawn as Mock).mockRejectedValueOnce(new Error("spawn failed"));
      await expect(manager.openShell(null)).rejects.toThrow("起動に失敗");
      expect(disposeTerminalRuntime).toHaveBeenCalled();
    });
  });

  // ── close ─────────────────────────────────────────────────────

  describe("close", () => {
    it("shell を閉じると隣の session に active が移動する", async () => {
      const id = await manager.openShell(null);
      expect(manager.getState().activeSessionId).toBe(id);
      manager.close(id);
      expect(manager.getState().activeSessionId).toBe(MAIN);
      expect(manager.getState().sessions).not.toContain(id);
    });

    it("main session は close できない", () => {
      manager.close(MAIN);
      expect(manager.getState().sessions).toContain(MAIN);
    });

    it("存在しない id は no-op", () => {
      const before = manager.getState();
      manager.close("nonexistent");
      expect(manager.getState()).toBe(before);
    });

    it("active でない session を閉じても active は変わらない", async () => {
      const id1 = await manager.openShell(null);
      const id2 = await manager.openShell(null);
      // active は id2
      expect(manager.getState().activeSessionId).toBe(id2);
      manager.close(id1);
      expect(manager.getState().activeSessionId).toBe(id2);
      expect(manager.getState().sessions).not.toContain(id1);
    });

    it("sessionDestroy と disposeTerminalRuntime が呼ばれる", async () => {
      const id = await manager.openShell(null);
      manager.close(id);
      expect(sessionDestroy).toHaveBeenCalledWith({ sessionId: id });
      expect(disposeTerminalRuntime).toHaveBeenCalledWith(id);
    });
  });

  // ── switchTo ──────────────────────────────────────────────────

  describe("switchTo", () => {
    it("指定 session に切り替わる", async () => {
      await manager.openShell(null);
      manager.switchTo(MAIN);
      expect(manager.getState().activeSessionId).toBe(MAIN);
    });

    it("存在しない id は no-op", async () => {
      await manager.openShell(null);
      const before = manager.getState();
      manager.switchTo("nonexistent");
      expect(manager.getState()).toBe(before);
    });
  });

  // ── switchNext / switchPrev ───────────────────────────────────

  describe("switchNext / switchPrev", () => {
    it("switchNext で次のタブに循環する", async () => {
      const id1 = await manager.openShell(null);
      const id2 = await manager.openShell(null);
      // active = id2 (末尾)
      manager.switchNext();
      // 循環して先頭 = MAIN
      expect(manager.getState().activeSessionId).toBe(MAIN);
      manager.switchNext();
      expect(manager.getState().activeSessionId).toBe(id1);
      manager.switchNext();
      expect(manager.getState().activeSessionId).toBe(id2);
    });

    it("switchPrev で前のタブに循環する", async () => {
      const id1 = await manager.openShell(null);
      await manager.openShell(null);
      // active = id2 (末尾) → prev = id1
      manager.switchPrev();
      expect(manager.getState().activeSessionId).toBe(id1);
      manager.switchPrev();
      expect(manager.getState().activeSessionId).toBe(MAIN);
      // MAIN → prev = 末尾に循環
      manager.switchPrev();
      const state = manager.getState();
      expect(state.activeSessionId).toBe(state.sessions[state.sessions.length - 1]);
    });

    it("session が 1 つだけのとき switchNext/switchPrev は no-op", () => {
      manager.switchNext();
      expect(manager.getState().activeSessionId).toBe(MAIN);
      manager.switchPrev();
      expect(manager.getState().activeSessionId).toBe(MAIN);
    });
  });

  // ── switchToIndex ─────────────────────────────────────────────

  describe("switchToIndex", () => {
    it("0-indexed で指定した位置の session に切り替わる", async () => {
      const id1 = await manager.openShell(null);
      await manager.openShell(null);
      manager.switchToIndex(0);
      expect(manager.getState().activeSessionId).toBe(MAIN);
      manager.switchToIndex(1);
      expect(manager.getState().activeSessionId).toBe(id1);
    });

    it("範囲外の index は no-op", async () => {
      await manager.openShell(null);
      const before = manager.getState();
      manager.switchToIndex(-1);
      expect(manager.getState()).toBe(before);
      manager.switchToIndex(99);
      expect(manager.getState()).toBe(before);
    });
  });

  // ── subscribe ─────────────────────────────────────────────────

  describe("subscribe", () => {
    it("state 変更で listener が呼ばれる", async () => {
      const listener = vi.fn();
      manager.subscribe(listener);
      await manager.openShell(null);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(manager.getState());
    });

    it("unsubscribe 後は呼ばれない", async () => {
      const listener = vi.fn();
      const unsub = manager.subscribe(listener);
      unsub();
      await manager.openShell(null);
      expect(listener).not.toHaveBeenCalled();
    });

    it("複数 listener を登録できる", async () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      manager.subscribe(l1);
      manager.subscribe(l2);
      await manager.openShell(null);
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    });
  });

  // ── auto-respawn ──────────────────────────────────────────────

  describe("handleSessionExit / auto-respawn", () => {
    it("非 main session の exit は close として扱う", async () => {
      const id = await manager.openShell(null);
      manager.handleSessionExit(id, 0);
      expect(manager.getState().sessions).not.toContain(id);
    });

    it("main exit で lifetime > 5s なら count リセット + respawn", () => {
      // spawnTime を 10 秒前に設定
      manager._setSpawnTimeForTest(Date.now() - 10_000);
      manager.handleSessionExit(MAIN, 0);
      // respawnCount はリセットされている
      expect(manager._getRespawnCountForTest()).toBe(0);
    });

    it("main exit で短命が 3 回連続すると停止する", () => {
      // 1 回目: 短命
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(1);

      // 2 回目: 短命
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(2);

      // 3 回目: 短命 → RESPAWN_MAX 到達で停止
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(3);
    });

    it("restartMain で respawnCount がリセットされる", () => {
      // 短命 exit を 2 回
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(2);

      manager.restartMain();
      expect(manager._getRespawnCountForTest()).toBe(0);
    });
  });
});
