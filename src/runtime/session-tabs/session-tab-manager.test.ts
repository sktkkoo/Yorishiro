import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionId } from "../sessions/types";

vi.mock("../../bindings/tauri-commands", () => ({
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
    focus: vi.fn(),
    forceRespawn: vi.fn(),
  }),
  disposeTerminalRuntime: vi.fn(),
}));

const { SessionTabManager } = await import("./session-tab-manager");
const { sessionDestroy } = await import("../../bindings/tauri-commands");
const { disposeTerminalRuntime } = await import("../terminal-runtime");

const MAIN: SessionId = "default-session";

describe("SessionTabManager", () => {
  let manager: InstanceType<typeof SessionTabManager>;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new SessionTabManager(MAIN);
    // テストでは grace period を無効化して pty-exit を即座に処理可能にする
    manager._setSpawnTimeForTest(Date.now() - 10_000);
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
    it("新 session が追加され active が移動する", () => {
      const id = manager.openShell(null);
      const state = manager.getState();
      expect(state.sessions).toContain(id);
      expect(state.activeSessionId).toBe(id);
      expect(state.sessions.length).toBe(2);
    });

    it("連続呼び出しで id が衝突しない", () => {
      const id1 = manager.openShell(null);
      const id2 = manager.openShell(null);
      expect(id1).not.toBe(id2);
      expect(manager.getState().sessions.length).toBe(3);
    });
  });

  // ── close ─────────────────────────────────────────────────────

  describe("close", () => {
    it("shell を閉じると隣の session に active が移動する", () => {
      const id = manager.openShell(null);
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

    it("active でない session を閉じても active は変わらない", () => {
      const id1 = manager.openShell(null);
      const id2 = manager.openShell(null);
      expect(manager.getState().activeSessionId).toBe(id2);
      manager.close(id1);
      expect(manager.getState().activeSessionId).toBe(id2);
      expect(manager.getState().sessions).not.toContain(id1);
    });

    it("sessionDestroy と disposeTerminalRuntime が呼ばれる", () => {
      const id = manager.openShell(null);
      manager.close(id);
      expect(sessionDestroy).toHaveBeenCalledWith({ sessionId: id });
      expect(disposeTerminalRuntime).toHaveBeenCalledWith(id);
    });
  });

  // ── switchTo ──────────────────────────────────────────────────

  describe("switchTo", () => {
    it("指定 session に切り替わる", () => {
      manager.openShell(null);
      manager.switchTo(MAIN);
      expect(manager.getState().activeSessionId).toBe(MAIN);
    });

    it("存在しない id は no-op", () => {
      manager.openShell(null);
      const before = manager.getState();
      manager.switchTo("nonexistent");
      expect(manager.getState()).toBe(before);
    });
  });

  // ── switchNext / switchPrev ───────────────────────────────────

  describe("switchNext / switchPrev", () => {
    it("switchNext で次のタブに循環する", () => {
      const id1 = manager.openShell(null);
      const id2 = manager.openShell(null);
      manager.switchNext();
      expect(manager.getState().activeSessionId).toBe(MAIN);
      manager.switchNext();
      expect(manager.getState().activeSessionId).toBe(id1);
      manager.switchNext();
      expect(manager.getState().activeSessionId).toBe(id2);
    });

    it("switchPrev で前のタブに循環する", () => {
      const id1 = manager.openShell(null);
      manager.openShell(null);
      manager.switchPrev();
      expect(manager.getState().activeSessionId).toBe(id1);
      manager.switchPrev();
      expect(manager.getState().activeSessionId).toBe(MAIN);
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
    it("0-indexed で指定した位置の session に切り替わる", () => {
      const id1 = manager.openShell(null);
      manager.openShell(null);
      manager.switchToIndex(0);
      expect(manager.getState().activeSessionId).toBe(MAIN);
      manager.switchToIndex(1);
      expect(manager.getState().activeSessionId).toBe(id1);
    });

    it("範囲外の index は no-op", () => {
      manager.openShell(null);
      const before = manager.getState();
      manager.switchToIndex(-1);
      expect(manager.getState()).toBe(before);
      manager.switchToIndex(99);
      expect(manager.getState()).toBe(before);
    });
  });

  // ── subscribe ─────────────────────────────────────────────────

  describe("subscribe", () => {
    it("state 変更で listener が呼ばれる", () => {
      const listener = vi.fn();
      manager.subscribe(listener);
      manager.openShell(null);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(manager.getState());
    });

    it("unsubscribe 後は呼ばれない", () => {
      const listener = vi.fn();
      const unsub = manager.subscribe(listener);
      unsub();
      manager.openShell(null);
      expect(listener).not.toHaveBeenCalled();
    });

    it("複数 listener を登録できる", () => {
      const l1 = vi.fn();
      const l2 = vi.fn();
      manager.subscribe(l1);
      manager.subscribe(l2);
      manager.openShell(null);
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    });
  });

  // ── auto-respawn ──────────────────────────────────────────────

  describe("handleSessionExit / auto-respawn", () => {
    it("非 main session の exit は close として扱う", () => {
      const id = manager.openShell(null);
      manager.handleSessionExit(id, 0);
      expect(manager.getState().sessions).not.toContain(id);
    });

    it("main exit で lifetime > 5s なら count リセット + respawn", () => {
      manager._setSpawnTimeForTest(Date.now() - 10_000);
      manager.handleSessionExit(MAIN, 0);
      expect(manager._getRespawnCountForTest()).toBe(0);
    });

    it("main exit で短命が 3 回連続すると停止する", () => {
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(1);

      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(2);

      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(3);
    });

    it("restartMain で respawnCount がリセットされる", () => {
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(2);

      manager.restartMain();
      expect(manager._getRespawnCountForTest()).toBe(0);
    });
  });

  // ── ignoreNextMainExit ────────────────────────────────────────

  describe("ignoreNextMainExit（旧 session kill の pty-exit 無視）", () => {
    it("constructor 直後の最初の main exit は無視される", () => {
      const fresh = new SessionTabManager(MAIN);
      fresh.handleSessionExit(MAIN, 0);
      // ignore されたので respawnCount は 0 のまま
      expect(fresh._getRespawnCountForTest()).toBe(0);
    });

    it("ignore 後の 2 回目の main exit は正常に処理される", () => {
      const fresh = new SessionTabManager(MAIN);
      // 1 回目: ignore（旧 session kill）
      fresh.handleSessionExit(MAIN, 0);
      expect(fresh._getRespawnCountForTest()).toBe(0);
      // 2 回目: 新 process が即死 → 正常に respawn logic が走る
      fresh._setSpawnTimeForTest(Date.now());
      fresh.handleSessionExit(MAIN, 1);
      expect(fresh._getRespawnCountForTest()).toBe(1);
    });

    it("ignore は非 main session には適用されない", () => {
      const fresh = new SessionTabManager(MAIN);
      const shellId = fresh.openShell(null);
      // 非 main の exit は ignore フラグに関係なく close される
      fresh.handleSessionExit(shellId, 0);
      expect(fresh.getState().sessions).not.toContain(shellId);
    });

    it("respawnMain 後も 1 回だけ ignore される", () => {
      // ignore を消費
      manager.handleSessionExit(MAIN, 0);
      // 本物の exit → respawn 発火 → ignoreNextMainExit が再設定される
      manager._setSpawnTimeForTest(Date.now() - 10_000);
      manager.handleSessionExit(MAIN, 0);
      // respawnMain が走ったので再び ignore が有効
      // 旧 session kill 分の exit を無視
      manager.handleSessionExit(MAIN, 0);
      // ignore 消費後の exit は処理される
      manager._setSpawnTimeForTest(Date.now());
      manager.handleSessionExit(MAIN, 1);
      expect(manager._getRespawnCountForTest()).toBe(1);
    });
  });
});
