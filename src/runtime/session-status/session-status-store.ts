/**
 * SessionStatusStore — 各 session の「いま何が起きているか」を UI 向けに集約する
 * webview-lifetime singleton。
 *
 * 位置づけ（terminal release foundation Phase 1）:
 *   - Rust `SessionRegistry` が権威を持つ lifecycle / activity を、TS 側の
 *     表示・反射層が読める形に畳む purely-derived な観察 store。
 *   - PTY へ書かない・session を spawn/switch/close しない（observation only,
 *     docs/philosophy/PHILOSOPHY.ja.md「観察の境界」）。本 store は「気づく」
 *     ための材料を持つだけで、環境を変える経路を一切持たない。
 *
 * 設計:
 *   - Perception と同じく Tauri API を直接 import しない（test 可能性のため）。
 *     外部（App / Rust event bridge）が setLifecycle / setActivity /
 *     markOutput / markActive / recordExit / remove を呼ぶ。
 *   - unread は「非 active session に出力が来た」ことを表す UI 用フラグで、
 *     lifecycle / activity とは直交する（active 化で解除）。
 */

import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { SessionActivity, SessionId, SessionLifecycle } from "../sessions/types";

/**
 * 1 session 分の観察状態。Rust 由来の lifecycle / activity に、UI 用の
 * 派生情報（unread / exitCode / lastActivityAt）を足した read model。
 */
export interface SessionStatus {
  readonly sessionId: SessionId;
  readonly lifecycle: SessionLifecycle;
  readonly activity: SessionActivity;
  /** process 終了時の exit code。未終了 / 不明なら null。 */
  readonly exitCode: number | null;
  /** agent / shell が OSC notification 等で発した最新の注意要求。未検出なら null。 */
  readonly attention: SessionAttention | null;
  /** 直近で何らかの観察 signal が更新された時刻（epoch ms）。 */
  readonly lastActivityAt: number;
  /** 非 active 中に出力が来た = 未読。active 化で false に戻る。 */
  readonly unread: boolean;
}

/** session がユーザーの注意を求めたことを表す terminal-native notification。 */
export interface SessionAttention {
  readonly title: string | null;
  readonly body: string;
  readonly receivedAt: number;
  readonly source: "hook" | "osc" | "screen" | "loop";
}

/**
 * TabIndicator など UI が出し分けに使う、単一の表示用 badge。
 * lifecycle / activity を 1 つの優先順位付き enum に畳む（純粋関数で導出）。
 */
export type SessionStatusBadge =
  | "starting"
  | "idle"
  | "running"
  | "awaiting-input"
  | "exited-ok"
  | "exited-fail"
  | "exited-unknown";

export interface SessionStatusStoreOptions {
  /** 時刻ソース。test で差し替え可能にするため注入式（既定 Date.now）。 */
  readonly now?: () => number;
  /** clear 直後に遅れて来た hook/OSC 通知を古い signal と見なして無視する時間。 */
  readonly lateAttentionSuppressMs?: number;
}

type Listener = () => void;

interface ClearedAttention {
  readonly title: string | null;
  readonly body: string;
  readonly source: SessionAttention["source"];
  readonly clearedAt: number;
}

/**
 * lifecycle / activity / exitCode から単一の表示 badge を導出する純粋関数。
 *
 * 優先順位（高い方が勝つ）:
 *   1. exited        — process が死んでいる事実が最優先
 *   2. awaiting-input — ユーザー / 許可待ち（最も「気づいてほしい」状態）
 *   3. running        — command 実行中
 *   4. starting       — spawn 直後で running 信号がまだ無い
 *   5. idle           — 既定
 */
export function deriveSessionStatusBadge(status: SessionStatus): SessionStatusBadge {
  if (status.lifecycle === "exited") {
    if (status.exitCode === null) return "exited-unknown";
    return status.exitCode === 0 ? "exited-ok" : "exited-fail";
  }
  if (status.activity === "awaiting-input") return "awaiting-input";
  if (status.activity === "running-command") return "running";
  if (status.lifecycle === "starting") return "starting";
  return "idle";
}

/** badge が「ユーザーの注意を要する」種類か（赤系強調 / 通知の判定に使う）。 */
export function isNoteworthyBadge(badge: SessionStatusBadge): boolean {
  return badge === "awaiting-input" || badge === "exited-fail";
}

/**
 * その PTY 入力を「許可待ちへの応答」と見なして attention を解除してよいか。
 *
 * agent の TUI はマウストラッキング / focus reporting を有効にするため、
 * マウス移動・focus 変化・矢印キー・bracketed paste などが ESC で始まる制御
 * sequence として `term.onData` に流れてくる。これらは「まだ応答していない」
 * ナビゲーション / 環境イベントなので解除しない。Enter や文字・数字など、
 * 実際に選択を確定する入力でのみ解除する。
 */
export function isAttentionClearingInput(data: string): boolean {
  if (data.length === 0) return false;
  // ESC 始まり = 矢印 / function / mouse report / focus report / bracketed paste。
  if (data.charCodeAt(0) === 0x1b) return false;
  return true;
}

const DEFAULT_STATUS: Omit<SessionStatus, "sessionId" | "lastActivityAt"> = {
  lifecycle: "starting",
  activity: "idle",
  exitCode: null,
  attention: null,
  unread: false,
};

/**
 * 全 session の SessionStatus を保持し、変化を listener に通知する store。
 * React 側は useSyncExternalStore で subscribe する想定。
 */
export class SessionStatusStore {
  private readonly statuses = new Map<SessionId, SessionStatus>();
  private readonly listeners = new Set<Listener>();
  private readonly now: () => number;
  private readonly lateAttentionSuppressMs: number;
  /** active session は unread を持たない。markOutput 時の判定に使う。 */
  private activeSessionId: SessionId | null = null;
  private readonly lastAttentionCleared = new Map<SessionId, ClearedAttention>();

  constructor(options: SessionStatusStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.lateAttentionSuppressMs = options.lateAttentionSuppressMs ?? 10000;
  }

  /** session を store に登録する。既存なら no-op。 */
  register(sessionId: SessionId): void {
    if (this.statuses.has(sessionId)) return;
    this.statuses.set(sessionId, this.defaultStatus(sessionId));
    this.notify();
  }

  /** 既存 status を取得（無ければ未登録の既定値を返す）。 */
  private ensure(sessionId: SessionId): SessionStatus {
    const existing = this.statuses.get(sessionId);
    if (existing) return existing;
    return this.defaultStatus(sessionId);
  }

  private defaultStatus(sessionId: SessionId): SessionStatus {
    return {
      sessionId,
      lastActivityAt: this.now(),
      ...DEFAULT_STATUS,
    };
  }

  /**
   * 値を差し替える。UI 上の意味が変わったときだけ notify する。
   *
   * `lastActivityAt` は観察時刻として更新するが、これだけの差分では
   * React 側を再描画しない。PTY チャンクごとに timestamp だけで notify すると、
   * streaming output 中に App 全体が再レンダリングされるため。
   */
  private commit(next: SessionStatus): void {
    const prev = this.statuses.get(next.sessionId);
    if (prev && shallowEqualStatus(prev, next)) return;
    this.statuses.set(next.sessionId, next);
    if (prev && shallowEqualRenderableStatus(prev, next)) return;
    this.notify();
  }

  /** Rust lifecycle 変化を反映する。 */
  setLifecycle(sessionId: SessionId, lifecycle: SessionLifecycle): void {
    const current = this.ensure(sessionId);
    this.commit({
      ...current,
      lifecycle,
      activity: lifecycle === "starting" ? "idle" : current.activity,
      exitCode: lifecycle === "exited" ? current.exitCode : null,
      lastActivityAt: this.now(),
    });
  }

  /** Rust activity 変化（OSC 133 由来の running-command / idle など）を反映する。 */
  setActivity(sessionId: SessionId, activity: SessionActivity): void {
    const current = this.ensure(sessionId);
    this.commit({ ...current, activity, lastActivityAt: this.now() });
  }

  /**
   * 出力が来たことを記録する。session が active でなければ unread を立てる。
   * active session の出力では unread を立てない（見えているから）。
   */
  markOutput(sessionId: SessionId): void {
    const current = this.ensure(sessionId);
    const unread = sessionId !== this.activeSessionId;
    this.commit({
      ...current,
      lifecycle: current.lifecycle === "starting" ? "running" : current.lifecycle,
      // awaiting-input（OSC notification 由来の許可待ち）は sticky。agent の TUI が
      // 待機中も画面を再描画し続けるので、その出力で許可待ちを消さない。実際に
      // 応答したと見なせるユーザー入力（clearAttention）でのみ解除する。
      activity:
        current.lifecycle === "exited"
          ? current.activity
          : current.activity === "awaiting-input"
            ? "awaiting-input"
            : "running-command",
      unread: current.unread || unread,
      lastActivityAt: this.now(),
    });
  }

  /**
   * PTY output burst が静まった時に呼ぶ。`markOutput` が立てた
   * transient running-command だけを idle に戻す。
   *
   * OSC notification などで `awaiting-input` へ遷移した後に、古い idle timer が
   * その状態を消してしまわないよう、running-command 以外は触らない。
   */
  settleOutput(sessionId: SessionId): void {
    const current = this.statuses.get(sessionId);
    if (!current || current.activity !== "running-command") return;
    this.commit({ ...current, activity: "idle", lastActivityAt: this.now() });
  }

  /**
   * OSC 9/99/777 などの terminal-native notification を記録する。
   * active session でなければ unread も立てる。本文が空の通知は無視する。
   */
  markAttentionRequest(
    sessionId: SessionId,
    notification: {
      readonly title: string | null;
      readonly body: string;
      readonly source?: SessionAttention["source"];
    },
  ): void {
    const body = notification.body.trim();
    if (body.length === 0) return;
    const title = notification.title?.trim() ?? "";
    const source = notification.source ?? "osc";
    const current = this.ensure(sessionId);
    const receivedAt = this.now();
    const normalizedTitle = title.length > 0 ? title : null;
    const lastCleared = this.lastAttentionCleared.get(sessionId);
    if (current.attention === null && source !== "loop" && lastCleared !== undefined) {
      const sinceCleared = receivedAt - lastCleared.clearedAt;
      const inSuppressionWindow = sinceCleared >= 0 && sinceCleared < this.lateAttentionSuppressMs;
      const sameScreenPrompt =
        source === "screen" &&
        lastCleared.source === "screen" &&
        lastCleared.title === normalizedTitle &&
        lastCleared.body === body;
      if (inSuppressionWindow && (source !== "screen" || sameScreenPrompt)) return;
    }

    if (
      current.activity === "awaiting-input" &&
      current.attention?.source === "screen" &&
      source !== "loop" &&
      source !== "screen"
    ) {
      return;
    }

    if (
      current.activity === "awaiting-input" &&
      current.attention !== null &&
      source === "screen" &&
      current.attention.source !== "screen" &&
      current.attention.source !== "loop"
    ) {
      const unread = sessionId !== this.activeSessionId;
      this.commit({
        ...current,
        attention: {
          title: normalizedTitle,
          body,
          receivedAt: current.attention.receivedAt,
          source,
        },
        unread: current.unread || unread,
        lastActivityAt: receivedAt,
      });
      return;
    }

    if (
      current.activity === "awaiting-input" &&
      current.attention?.title === normalizedTitle &&
      current.attention.body === body &&
      current.attention.source === source
    ) {
      return;
    }

    const unread = sessionId !== this.activeSessionId;
    this.commit({
      ...current,
      activity: "awaiting-input",
      attention: {
        title: normalizedTitle,
        body,
        receivedAt,
        source,
      },
      unread: current.unread || unread,
      lastActivityAt: receivedAt,
    });
  }

  /**
   * 画面末尾に許可待ち prompt が見えていることを fast path として記録する。
   * 同じ screen prompt を output chunk ごとに再通知しないよう body/title で冪等化する。
   */
  markScreenAttentionRequest(
    sessionId: SessionId,
    notification: { readonly title: string | null; readonly body: string },
  ): void {
    this.markAttentionRequest(sessionId, { ...notification, source: "screen" });
  }

  /**
   * screen fast path が「もう prompt が画面にない」と判断したときだけ screen 由来の
   * attention を解除する。hook/OSC 由来は screen scan では解除しない。
   */
  clearScreenAttention(sessionId: SessionId): void {
    const current = this.statuses.get(sessionId);
    if (!current || current.attention?.source !== "screen") return;
    this.clearAttention(sessionId);
  }

  /** loop lifecycle が進行/終了したとき、loop 由来の sticky attention だけを解除する。 */
  clearLoopAttention(sessionId: SessionId): void {
    const current = this.statuses.get(sessionId);
    if (!current || current.attention?.source !== "loop") return;
    this.commit({
      ...current,
      activity: current.activity === "awaiting-input" ? "idle" : current.activity,
      attention: null,
      unread: false,
      lastActivityAt: this.now(),
    });
  }

  /** active session を切り替える。新 active の unread は解除する。 */
  markActive(sessionId: SessionId): void {
    const previousActiveSessionId = this.activeSessionId;
    this.activeSessionId = sessionId;
    const current = this.statuses.get(sessionId);
    if (!current) {
      this.register(sessionId);
      return;
    }
    if (!current.unread) {
      if (previousActiveSessionId !== sessionId) this.notify();
      return;
    }
    this.commit({
      ...current,
      unread: false,
      lastActivityAt: this.now(),
    });
  }

  /** ユーザー入力など、実際に注意要求へ応答したと見なせる操作で明示解除する。 */
  clearAttention(sessionId: SessionId): void {
    const current = this.statuses.get(sessionId);
    if (!current || current.attention === null) return;
    const previousAttention = current.attention;
    const clearedAt = this.now();
    this.lastAttentionCleared.set(sessionId, {
      title: previousAttention.title,
      body: previousAttention.body,
      source: previousAttention.source,
      clearedAt,
    });
    this.commit({
      ...current,
      activity: current.activity === "awaiting-input" ? "idle" : current.activity,
      attention: null,
      unread: false,
      lastActivityAt: clearedAt,
    });
  }

  /**
   * hook signal が「許可待ちは解消した」と示したときの解除経路。
   * loop lifecycle 由来の sticky attention は loop lifecycle 側でだけ解除する。
   */
  clearNonLoopAttention(sessionId: SessionId): void {
    const current = this.statuses.get(sessionId);
    if (!current || current.attention?.source === "loop") return;
    this.clearAttention(sessionId);
  }

  /** process 終了を記録する（lifecycle=exited + exitCode）。 */
  recordExit(sessionId: SessionId, exitCode: number | null): void {
    const current = this.ensure(sessionId);
    this.commit({
      ...current,
      lifecycle: "exited",
      activity: "idle",
      exitCode,
      lastActivityAt: this.now(),
    });
  }

  /** session を store から外す（close / dispose 時）。 */
  remove(sessionId: SessionId): void {
    if (!this.statuses.delete(sessionId)) return;
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
    this.notify();
  }

  get(sessionId: SessionId): SessionStatus | null {
    return this.statuses.get(sessionId) ?? null;
  }

  /** 登録順は保証しない snapshot（呼び出し側は sessionId で並べ替える）。 */
  list(): ReadonlyArray<SessionStatus> {
    return Array.from(this.statuses.values());
  }

  getActiveSessionId(): SessionId | null {
    return this.activeSessionId;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) {
      try {
        listener();
      } catch (err) {
        // 1 listener の例外で他 listener を倒さない。
        console.error("[SessionStatusStore] listener threw:", err);
      }
    }
  }
}

function shallowEqualStatus(a: SessionStatus, b: SessionStatus): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.lifecycle === b.lifecycle &&
    a.activity === b.activity &&
    a.exitCode === b.exitCode &&
    equalAttention(a.attention, b.attention) &&
    a.unread === b.unread &&
    a.lastActivityAt === b.lastActivityAt
  );
}

function shallowEqualRenderableStatus(a: SessionStatus, b: SessionStatus): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.lifecycle === b.lifecycle &&
    a.activity === b.activity &&
    a.exitCode === b.exitCode &&
    equalAttention(a.attention, b.attention) &&
    a.unread === b.unread
  );
}

function equalAttention(a: SessionAttention | null, b: SessionAttention | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.receivedAt === b.receivedAt &&
    a.source === b.source
  );
}

/** webview-lifetime singleton accessor（HMR 越しに同一 instance）。 */
export function getSessionStatusStore(): SessionStatusStore {
  return getOrInit(KEYS.SESSION_STATUS_STORE, () => new SessionStatusStore());
}
