/**
 * Session tab の state 管理。tab の並び順・active・open/close・auto-respawn を扱う。
 * React 側は useSyncExternalStore で subscribe する想定。
 */

import { Channel } from "@tauri-apps/api/core";
import { type SpawnSpec, sessionDestroy, sessionSpawn } from "../../bindings/tauri-commands";
import type { SessionId } from "../sessions/types";
import { disposeTerminalRuntime, getTerminalRuntime } from "../terminal-runtime";
import type { SessionTabListener, SessionTabState } from "./types";

/** 短命 exit の連続回数上限。これを超えると respawn しない。 */
const RESPAWN_MAX = 3;

/** この ms 以上生きていれば「長命」とみなし、respawnCount をリセットする。 */
const RESPAWN_LIFETIME_THRESHOLD_MS = 5_000;

/** 短命 exit 時の backoff（index = respawnCount - 1）。 */
const RESPAWN_BACKOFF_MS = [0, 2_000, 4_000];

/** 新規 shell spawn 時のデフォルト spec。 */
const SHELL_SPEC: SpawnSpec = { kind: "shell", integration: true };

export class SessionTabManager {
  private state: SessionTabState;
  private listeners = new Set<SessionTabListener>();
  private counter = 0;
  private respawnCount = 0;
  private spawnTime = Date.now();

  constructor(mainSessionId: SessionId) {
    this.state = {
      sessions: [mainSessionId],
      activeSessionId: mainSessionId,
      mainSessionId,
    };
  }

  /** 現在の immutable state を返す。 */
  getState(): SessionTabState {
    return this.state;
  }

  /** state 変更を subscribe する。戻り値は unsubscribe 関数。 */
  subscribe(listener: SessionTabListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 新しい shell session を開き、active にする。 */
  async openShell(cwd: string | null): Promise<SessionId> {
    this.counter++;
    const sessionId: SessionId = `shell-${this.counter}`;
    getTerminalRuntime(sessionId);

    try {
      await sessionSpawn({
        sessionId,
        spec: SHELL_SPEC,
        cols: 80,
        rows: 24,
        cwd,
        onOutput: new Channel<ArrayBuffer>(),
      });
    } catch {
      disposeTerminalRuntime(sessionId);
      throw new Error(`shell session ${sessionId} の起動に失敗`);
    }

    this.setState({
      ...this.state,
      sessions: [...this.state.sessions, sessionId],
      activeSessionId: sessionId,
    });
    return sessionId;
  }

  /** session を閉じる。main session は閉じられない。 */
  close(sessionId: SessionId): void {
    if (sessionId === this.state.mainSessionId) return;
    if (!this.state.sessions.includes(sessionId)) return;

    void sessionDestroy({ sessionId });
    disposeTerminalRuntime(sessionId);

    const remaining = this.state.sessions.filter((id) => id !== sessionId);
    let nextActive = this.state.activeSessionId;
    if (nextActive === sessionId) {
      const closedIndex = this.state.sessions.indexOf(sessionId);
      const fallbackIndex = Math.min(closedIndex, remaining.length - 1);
      nextActive = remaining[fallbackIndex] ?? this.state.mainSessionId;
    }
    this.setState({
      ...this.state,
      sessions: remaining,
      activeSessionId: nextActive,
    });
  }

  /** 指定 session に切り替える。存在しない id は no-op。 */
  switchTo(sessionId: SessionId): void {
    if (!this.state.sessions.includes(sessionId)) return;
    if (this.state.activeSessionId === sessionId) return;
    this.setState({ ...this.state, activeSessionId: sessionId });
  }

  /** 次のタブに循環切替。 */
  switchNext(): void {
    const { sessions, activeSessionId } = this.state;
    if (sessions.length <= 1) return;
    const idx = sessions.indexOf(activeSessionId);
    this.switchTo(sessions[(idx + 1) % sessions.length]);
  }

  /** 前のタブに循環切替。 */
  switchPrev(): void {
    const { sessions, activeSessionId } = this.state;
    if (sessions.length <= 1) return;
    const idx = sessions.indexOf(activeSessionId);
    this.switchTo(sessions[(idx - 1 + sessions.length) % sessions.length]);
  }

  /** 0-indexed で指定した位置の session に切替。範囲外は no-op。 */
  switchToIndex(n: number): void {
    if (n < 0 || n >= this.state.sessions.length) return;
    this.switchTo(this.state.sessions[n]);
  }

  /**
   * PTY exit event のハンドラ。非 main なら close、main なら auto-respawn logic。
   */
  handleSessionExit(sessionId: SessionId, _exitCode: number): void {
    if (sessionId !== this.state.mainSessionId) {
      this.close(sessionId);
      return;
    }

    const lifetime = Date.now() - this.spawnTime;
    if (lifetime > RESPAWN_LIFETIME_THRESHOLD_MS) {
      // 長命 → count リセットして respawn
      this.respawnCount = 0;
      this.respawnMain();
      return;
    }

    // 短命 exit
    this.respawnCount++;
    if (this.respawnCount >= RESPAWN_MAX) {
      // 上限到達 → respawn しない
      return;
    }

    const delay = RESPAWN_BACKOFF_MS[this.respawnCount - 1] ?? 0;
    if (delay === 0) {
      this.respawnMain();
    } else {
      setTimeout(() => this.respawnMain(), delay);
    }
  }

  /** 手動リスタート。respawnCount をリセットして respawn する。 */
  restartMain(): void {
    this.respawnCount = 0;
    this.respawnMain();
  }

  /** main session の respawn 実行。spawnTime を更新する。 */
  private respawnMain(): void {
    this.spawnTime = Date.now();
  }

  /** state を更新し、全 listener に通知する。 */
  private setState(next: SessionTabState): void {
    this.state = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  // ── テスト用ヘルパー ─────────────────────────────────────────

  /** テスト用: spawnTime を外部から設定する。 */
  _setSpawnTimeForTest(time: number): void {
    this.spawnTime = time;
  }

  /** テスト用: 現在の respawnCount を取得する。 */
  _getRespawnCountForTest(): number {
    return this.respawnCount;
  }
}
