/**
 * SessionRegistry — 全 session の descriptor + lifecycle / activity 状態 +
 * event dispatch を一元管理する singleton。
 *
 * 寿命: webview lifetime（hot-data 経由で HMR 越しに同一 instance）。
 * 責務:
 *   - SessionDescriptor の add / remove / get / list（insertion order 保持）
 *   - lifecycle / activity の get / set
 *   - state 変化 event の subscribe / dispatch
 * 非責務:
 *   - PTY / xterm / wrapper rc の生成（spawn 側、Phase A-4 / Phase B）
 *   - cell 抽出 / 観察 logic（terminal-runtime 側）
 *   - PTY への write（observation only、追加禁止）
 *
 * Internal design-record: 2026-05-05-multi-pane-terminal.md.
 */

import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type {
  SessionActivity,
  SessionDescriptor,
  SessionEvent,
  SessionId,
  SessionLifecycle,
} from "./types";

type Listener = (event: SessionEvent) => void;

export class SessionRegistry {
  private readonly descriptors = new Map<SessionId, SessionDescriptor>();
  private readonly lifecycles = new Map<SessionId, SessionLifecycle>();
  private readonly activities = new Map<SessionId, SessionActivity>();
  private readonly listeners = new Set<Listener>();

  /**
   * 同 id の add は no-op（idempotent）。spawn race / HMR 再呼び出しで二重登録
   * しないため。
   */
  add(descriptor: SessionDescriptor): void {
    if (this.descriptors.has(descriptor.id)) return;
    this.descriptors.set(descriptor.id, descriptor);
    this.lifecycles.set(descriptor.id, "starting");
    this.activities.set(descriptor.id, "idle");
    this.emit({ type: "session-added", descriptor });
  }

  /**
   * 存在しない id の remove は no-op で false を返す（caller は side-effect の
   * 有無を区別できる）。
   */
  remove(id: SessionId): boolean {
    if (!this.descriptors.has(id)) return false;
    this.descriptors.delete(id);
    this.lifecycles.delete(id);
    this.activities.delete(id);
    this.emit({ type: "session-removed", id });
    return true;
  }

  get(id: SessionId): SessionDescriptor | null {
    return this.descriptors.get(id) ?? null;
  }

  /**
   * Insertion order を保つ snapshot。返り値は freeze していないが mutate
   * しない契約。
   */
  list(): ReadonlyArray<SessionDescriptor> {
    return Array.from(this.descriptors.values());
  }

  getLifecycle(id: SessionId): SessionLifecycle | null {
    return this.lifecycles.get(id) ?? null;
  }

  getActivity(id: SessionId): SessionActivity | null {
    return this.activities.get(id) ?? null;
  }

  /**
   * 未登録 id への set は no-op。値が変わらない set も no-op（noise event を
   * 出さない）。
   */
  setLifecycle(id: SessionId, lifecycle: SessionLifecycle): void {
    if (!this.descriptors.has(id)) return;
    if (this.lifecycles.get(id) === lifecycle) return;
    this.lifecycles.set(id, lifecycle);
    this.emit({ type: "session-lifecycle-changed", id, lifecycle });
  }

  setActivity(id: SessionId, activity: SessionActivity): void {
    if (!this.descriptors.has(id)) return;
    if (this.activities.get(id) === activity) return;
    this.activities.set(id, activity);
    this.emit({ type: "session-activity-changed", id, activity });
  }

  /**
   * 全 event を購読する。返値の関数を呼ぶと subscribe を解除する。
   */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: SessionEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // 1 listener の例外で他 listener や caller を倒さない
        console.error("[SessionRegistry] listener threw:", err);
      }
    }
  }
}

export function getSessionRegistry(): SessionRegistry {
  return getOrInit(KEYS.SESSION_REGISTRY, () => new SessionRegistry());
}
