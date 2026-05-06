/**
 * Session tab の state 管理。tab の並び順・active・open/close・auto-respawn を扱う。
 * React 側は useSyncExternalStore で subscribe する想定。
 */

import { sessionDestroy } from "../../bindings/tauri-commands";
import type { SessionDescriptor, SessionId } from "../sessions/types";
import { disposeTerminalRuntime, getTerminalRuntime } from "../terminal-runtime";
import type { SessionTabListener, SessionTabState } from "./types";

/** 短命 exit の連続回数上限。これを超えると respawn しない。 */
const RESPAWN_MAX = 3;

/** この ms 以上生きていれば「長命」とみなし、respawnCount をリセットする。 */
const RESPAWN_LIFETIME_THRESHOLD_MS = 5_000;

/** 短命 exit 時の backoff（index = respawnCount - 1）。 */
const RESPAWN_BACKOFF_MS = [0, 2_000, 4_000];

/** ICI 連携用の event callback。EventBus との結合を避けるため callback 形式で注入する。 */
export interface SessionTabManagerDeps {
  readonly onEvent?: (name: string, payload: Record<string, unknown>) => void;
}

export class SessionTabManager {
  private state: SessionTabState;
  private readonly sessionCwds = new Map<SessionId, string | null>();
  private listeners = new Set<SessionTabListener>();
  private counter = 0;
  private respawnCount = 0;
  private spawnTime = Date.now();
  private readonly onEvent: ((name: string, payload: Record<string, unknown>) => void) | null;

  constructor(mainSessionId: SessionId, deps?: SessionTabManagerDeps) {
    this.state = {
      sessions: [mainSessionId],
      activeSessionId: mainSessionId,
      mainSessionId,
    };
    this.onEvent = deps?.onEvent ?? null;
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

  /** session 操作時に ICI 向けの event を emit する。 */
  private emitEvent(name: string, payload: Record<string, unknown>): void {
    this.onEvent?.(name, payload);
  }

  /**
   * 新しい shell session を開き、active にする。
   * spawn 自体は行わない — state に session を追加すると React が Terminal
   * コンポーネントを mount し、updatePtyParams 経由で sessionSpawn が走る。
   */
  openShell(cwd: string | null): SessionId {
    this.counter++;
    const sessionId: SessionId = `shell-${this.counter}`;
    this.sessionCwds.set(sessionId, cwd);

    this.setState({
      ...this.state,
      sessions: [...this.state.sessions, sessionId],
      activeSessionId: sessionId,
    });
    this.emitEvent("session-opened", { sessionId, kind: "shell" });

    return sessionId;
  }

  /**
   * Rust registry に残っている session descriptor から tab state を復元する。
   * WebView reload では PTY は Rust 側に残るため、JS の tab state だけ復元する。
   */
  restoreSessions(
    descriptors: ReadonlyArray<SessionDescriptor>,
    preferredActiveSessionId: SessionId | null,
  ): void {
    const ordered = descriptors.map((descriptor) => descriptor.id);
    const sessions = [
      this.state.mainSessionId,
      ...ordered.filter((id) => id !== this.state.mainSessionId),
    ];
    const uniqueSessions = [...new Set(sessions)];
    if (uniqueSessions.length === 0) return;

    this.sessionCwds.clear();
    for (const descriptor of descriptors) {
      this.sessionCwds.set(descriptor.id, descriptor.cwd);
    }

    let maxShellIndex = this.counter;
    for (const id of uniqueSessions) {
      const match = /^shell-(\d+)$/.exec(id);
      if (match) maxShellIndex = Math.max(maxShellIndex, Number(match[1]));
    }
    this.counter = maxShellIndex;

    const currentActive = this.state.activeSessionId;
    const activeSessionId =
      preferredActiveSessionId && uniqueSessions.includes(preferredActiveSessionId)
        ? preferredActiveSessionId
        : uniqueSessions.includes(currentActive)
          ? currentActive
          : this.state.mainSessionId;

    this.setState({
      ...this.state,
      sessions: uniqueSessions,
      activeSessionId,
    });
  }

  getSessionCwd(sessionId: SessionId): string | null | undefined {
    return this.sessionCwds.get(sessionId);
  }

  /** session を閉じる。main session は閉じられない。 */
  close(sessionId: SessionId): void {
    if (sessionId === this.state.mainSessionId) return;
    if (!this.state.sessions.includes(sessionId)) return;

    void sessionDestroy({ sessionId });
    disposeTerminalRuntime(sessionId);
    this.sessionCwds.delete(sessionId);

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
    this.emitEvent("session-closed", { sessionId });
  }

  /** 指定 session に切り替える。存在しない id は no-op。 */
  switchTo(sessionId: SessionId): void {
    if (!this.state.sessions.includes(sessionId)) return;
    if (this.state.activeSessionId === sessionId) return;
    const prevActive = this.state.activeSessionId;
    this.setState({ ...this.state, activeSessionId: sessionId });
    this.emitEvent("session-switched", {
      from: prevActive,
      to: sessionId,
      toKind: sessionId === this.state.mainSessionId ? "agent" : "shell",
    });
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
      this.emitEvent("session-respawn-failed", { sessionId: this.state.mainSessionId });
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

  /** main session の respawn 実行。PTY を再起動し spawnTime を更新する。 */
  private respawnMain(): void {
    this.spawnTime = Date.now();
    const runtime = getTerminalRuntime(this.state.mainSessionId);
    runtime.forceRespawn();
    this.emitEvent("session-respawned", {
      sessionId: this.state.mainSessionId,
      attempt: this.respawnCount,
    });
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
