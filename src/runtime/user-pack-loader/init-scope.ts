/**
 * init.js の lifecycle scope と keyboard shortcut マッチング。
 *
 * init.js を hot reload するには、前回 run が仕掛けた listener / timer を確実に
 * 畳んでから次の run を活かす必要がある。`InitScope` はその「畳む単位」。
 * context helper（`onDispose` / `registerShortcut`）が登録した cleanup をまとめ、
 * reload 成功時に旧 scope を dispose、失敗時に staging scope を dispose する。
 *
 * `matchShortcut` は純粋関数なので DOM 無しで vitest 検証できる。
 *
 * Internal design-record: plans/2026-06-28-init-js-hot-reload-plan.md
 */

export interface InitDisposable {
  readonly dispose: () => void;
}

/**
 * init.js 1 回分の run が確保した cleanup をまとめる scope。
 *
 * - `add` / `addCleanup` で cleanup を積む。
 * - `dispose` は 1 回だけ実行され、登録の逆順で cleanup を呼ぶ（後勝ち resource
 *   が先に外れるよう LIFO）。1 つの cleanup が throw しても残りは必ず走らせる。
 * - dispose 済みの scope に後から add した cleanup は即時実行する（leak 防止）。
 */
export class InitScope {
  private cleanups: Array<() => void> = [];
  private disposed = false;

  add(disposable: InitDisposable): void {
    this.addCleanup(() => disposable.dispose());
  }

  addCleanup(cleanup: () => void): void {
    if (this.disposed) {
      cleanup();
      return;
    }
    this.cleanups.push(cleanup);
  }

  get size(): number {
    return this.cleanups.length;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const pending = this.cleanups.splice(0).reverse();
    for (const cleanup of pending) {
      try {
        cleanup();
      } catch {
        // cleanup の失敗は次の cleanup を妨げない。init.js は壊れても本体を
        // 道連れにしないという philosophy をここでも守る。
      }
    }
  }
}

/**
 * `ctx.registerShortcut` が受け取る宣言。
 *
 * - `code` は物理キー（`KeyF` / `F1`）向け、`key` は文字一致向け。両方指定すると
 *   両方一致が必要。
 * - modifier 各 field は **指定したものだけ** を制約する。`{ code: "KeyF", meta:
 *   true }` は ctrl/alt/shift を問わない。
 * - `repeat: false` は key repeat を無視する（押しっぱなし時の連射防止）。
 * - `preventDefault` / `stopPropagation` は既定 true。`capture` も既定 true で、
 *   xterm.js より先に拾う。
 */
export interface InitShortcutSpec {
  readonly code?: string;
  readonly key?: string;
  readonly meta?: boolean;
  readonly ctrl?: boolean;
  readonly alt?: boolean;
  readonly shift?: boolean;
  readonly repeat?: boolean;
  readonly preventDefault?: boolean;
  readonly stopPropagation?: boolean;
  readonly capture?: boolean;
}

/** KeyboardEvent のうち match に使う最小 shape。test で fake を渡しやすくする。 */
export interface ShortcutKeyEvent {
  readonly code?: string;
  readonly key?: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly repeat?: boolean;
}

/**
 * spec が event に一致するか。指定されていない field は制約しない。
 */
export function matchShortcut(spec: InitShortcutSpec, event: ShortcutKeyEvent): boolean {
  if (spec.code !== undefined && event.code !== spec.code) return false;
  if (spec.key !== undefined && event.key !== spec.key) return false;
  if (spec.meta !== undefined && Boolean(event.metaKey) !== spec.meta) return false;
  if (spec.ctrl !== undefined && Boolean(event.ctrlKey) !== spec.ctrl) return false;
  if (spec.alt !== undefined && Boolean(event.altKey) !== spec.alt) return false;
  if (spec.shift !== undefined && Boolean(event.shiftKey) !== spec.shift) return false;
  if (spec.repeat === false && event.repeat === true) return false;
  if (spec.repeat === true && event.repeat !== true) return false;
  return true;
}
