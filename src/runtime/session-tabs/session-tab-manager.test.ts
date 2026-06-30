import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDescriptor, SessionId } from "../sessions/types";
import type { SessionTabState } from "./types";

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

function descriptor(overrides: Partial<SessionDescriptor> & { id: string }): SessionDescriptor {
  return {
    profileId: overrides.id === MAIN ? "claude" : "shell",
    kind: overrides.id === MAIN ? "agent" : "shell",
    label: overrides.id,
    cwd: null,
    startedAt: 1,
    ...overrides,
  };
}

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
      expect(manager.getSessionCwd(MAIN)).toBeUndefined();
      expect(manager.shouldAttachExistingSession(MAIN)).toBe(false);
    });
  });

  // ── openShell ─────────────────────────────────────────────────

  describe("openShell", () => {
    it("新 session が追加され active が移動する", () => {
      const id = manager.openShell("/tmp/work");
      const state = manager.getState();
      expect(state.sessions).toContain(id);
      expect(state.activeSessionId).toBe(id);
      expect(state.sessions.length).toBe(2);
      expect(manager.getSessionCwd(id)).toBe("/tmp/work");
    });

    it("連続呼び出しで id が衝突しない", () => {
      const id1 = manager.openShell(null);
      const id2 = manager.openShell(null);
      expect(id1).not.toBe(id2);
      expect(manager.getState().sessions.length).toBe(3);
    });
  });

  // ── restoreSessions ─────────────────────────────────────────

  describe("restoreSessions", () => {
    it("Rust registry の session 一覧から tab state と cwd を復元する", () => {
      manager.restoreSessions(
        [
          descriptor({ id: MAIN, cwd: "/work/main" }),
          descriptor({ id: "shell-1", cwd: "/work/a" }),
          descriptor({ id: "shell-2", cwd: null }),
        ],
        "shell-2",
      );

      expect(manager.getState()).toMatchObject({
        sessions: [MAIN, "shell-1", "shell-2"],
        activeSessionId: "shell-2",
        mainSessionId: MAIN,
      });
      expect(manager.getSessionCwd(MAIN)).toBe("/work/main");
      expect(manager.getSessionCwd("shell-1")).toBe("/work/a");
      expect(manager.getSessionCwd("shell-2")).toBeNull();
      expect(manager.shouldAttachExistingSession(MAIN)).toBe(true);
      expect(manager.shouldAttachExistingSession("shell-1")).toBe(true);
    });

    it("preferred active が存在しない場合は現在 active を維持し、無理なら main に戻す", () => {
      const shell = manager.openShell("/work/a");
      manager.restoreSessions([descriptor({ id: MAIN }), descriptor({ id: shell })], "missing");
      expect(manager.getState().activeSessionId).toBe(shell);

      manager.restoreSessions([descriptor({ id: MAIN })], shell);
      expect(manager.getState().activeSessionId).toBe(MAIN);
    });

    it("restore 後の openShell は既存 shell-N と衝突しない", () => {
      manager.restoreSessions([descriptor({ id: MAIN }), descriptor({ id: "shell-3" })], "shell-3");
      expect(manager.openShell(null)).toBe("shell-4");
    });
  });

  describe("updateSessionCwd", () => {
    it("updates cwd and emits state to refresh labels", () => {
      const shell = manager.openShell("/work/a");
      const states: SessionTabState[] = [];
      manager.subscribe((state) => states.push(state));
      const beforeSessions = manager.getState().sessions;

      manager.updateSessionCwd(shell, "/work/b");

      expect(manager.getSessionCwd(shell)).toBe("/work/b");
      expect(states).toHaveLength(1);
      expect(states[0].sessions).toEqual([MAIN, shell]);
      expect(states[0].sessions).not.toBe(beforeSessions);
    });

    it("ignores unchanged and unknown cwd updates", () => {
      const shell = manager.openShell("/work/a");
      const states: SessionTabState[] = [];
      manager.subscribe((state) => states.push(state));

      manager.updateSessionCwd(shell, "/work/a");
      manager.updateSessionCwd("missing", "/work/b");

      expect(states).toEqual([]);
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
      expect(manager.getSessionCwd(id)).toBeUndefined();
      expect(manager.shouldAttachExistingSession(id)).toBe(false);
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
    it("非 main session の exit は tab を残して通知する", () => {
      const events: Array<{ name: string; payload: Record<string, unknown> }> = [];
      manager = new SessionTabManager(MAIN, {
        onEvent: (name, payload) => events.push({ name, payload }),
      });
      const id = manager.openShell(null);
      manager.handleSessionExit(id, 2);
      expect(manager.getState().sessions).toContain(id);
      expect(events).toContainEqual({
        name: "session-exited",
        payload: { sessionId: id, exitCode: 2 },
      });
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
});
