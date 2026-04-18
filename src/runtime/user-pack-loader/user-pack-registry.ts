/**
 * UserPackRegistry — hot reload 用の idempotency 層。
 *
 * Phase 1-a では loader が register 結果の Disposable を捨てていた——静的 load
 * 1 回きりの想定だったため。Phase 1-b でファイル変更ごとに再 register する場合、
 * 前の登録を dispose せずに重ねると：
 *
 *   - EffectPackRunner は listener Set に accumulate（pitfall #9）
 *   - PersonaRegistry は duplicate id で throw（pitfall #8）
 *
 * 両者を吸収する隔壁がここ。id + kind の compound key で last-wins、再 register
 * 時には必ず旧 Disposable を dispose してから格納する。
 *
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-b」Section B2
 */

import type { SubsystemLog } from "../../core/dev-log";

export interface Disposable {
  readonly dispose: () => void;
}

const keyFor = (id: string, kind: string): string => `${kind}:${id}`;

const safeDispose = (entry: Disposable, log?: SubsystemLog, context?: string): void => {
  try {
    entry.dispose();
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log?.write({
      phase: "dispose",
      note: `dispose threw${context ? ` during ${context}` : ""}`,
      data: { error },
    });
  }
};

export class UserPackRegistry {
  private readonly entries = new Map<string, Disposable>();
  private readonly log?: SubsystemLog;

  constructor(opts: { readonly log?: SubsystemLog } = {}) {
    this.log = opts.log;
  }

  register(id: string, kind: string, disposable: Disposable): void {
    const key = keyFor(id, kind);
    const prev = this.entries.get(key);
    if (prev !== undefined) {
      safeDispose(prev, this.log, `replace ${kind} '${id}'`);
    }
    this.entries.set(key, disposable);
  }

  dispose(id: string, kind: string): void {
    const key = keyFor(id, kind);
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    safeDispose(entry, this.log, `dispose ${kind} '${id}'`);
  }

  disposeAll(): void {
    const snapshot = Array.from(this.entries.entries());
    this.entries.clear();
    for (const [key, entry] of snapshot) {
      safeDispose(entry, this.log, `disposeAll ${key}`);
    }
  }

  has(id: string, kind: string): boolean {
    return this.entries.has(keyFor(id, kind));
  }
}
