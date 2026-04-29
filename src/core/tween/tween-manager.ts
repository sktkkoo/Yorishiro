import { numberLerp, vec3Lerp } from "./lerp";

/** アクティブな tween のスナップショット情報。 */
export interface TweenEntry {
  readonly key: string;
  readonly progress: number;
  readonly remainingMs: number;
}

/** tween の制御ハンドル。cancel と完了通知を提供する。 */
export interface TweenHandle {
  cancel(): void;
  readonly completion: Promise<void>;
}

/** 内部で管理するアクティブ tween の状態。 */
interface ActiveTween {
  readonly key: string;
  startTime: number;
  readonly durationMs: number;
  readonly lerp: (a: unknown, b: unknown, t: number) => unknown;
  readonly from: unknown;
  readonly to: unknown;
  readonly apply: (v: unknown) => void;
  readonly resolve: () => void;
}

/**
 * per-frame パラメータ補間を管理するクラス。
 * THREE.js 非依存の純粋 TypeScript 実装。
 * tick(now) を毎フレーム呼ぶことで補間を進める。
 */
export class TweenManager {
  private readonly active = new Map<string, ActiveTween>();

  /**
   * 数値の tween を開始する。同一 key が存在する場合は上書きされる（last-write-wins）。
   * @param key - tween の識別子
   * @param to - 補間先の値
   * @param durationMs - 補間にかける時間（ミリ秒）
   * @param apply - 補間値を受け取るコールバック
   * @param options.from - 補間元の値。省略時は to と同じ値を使用（変化なし）。
   */
  start(
    key: string,
    to: number,
    durationMs: number,
    apply: (value: number) => void,
    options?: { from?: number },
  ): TweenHandle {
    return this._register(key, options?.from ?? to, to, durationMs, numberLerp, apply);
  }

  /**
   * [x, y, z] ベクトルの tween を開始する。同一 key が存在する場合は上書きされる。
   * @param key - tween の識別子
   * @param to - 補間先のベクトル
   * @param durationMs - 補間にかける時間（ミリ秒）
   * @param apply - 補間値を受け取るコールバック
   * @param options.from - 補間元のベクトル（省略時は to と同じ値）
   */
  startVec3(
    key: string,
    to: readonly [number, number, number],
    durationMs: number,
    apply: (value: [number, number, number]) => void,
    options?: { from?: readonly [number, number, number] },
  ): TweenHandle {
    const fromVal: [number, number, number] = options?.from
      ? [options.from[0], options.from[1], options.from[2]]
      : [to[0], to[1], to[2]];
    const toVal: [number, number, number] = [to[0], to[1], to[2]];
    return this._register(key, fromVal, toVal, durationMs, vec3Lerp, apply);
  }

  /** 指定 key の tween を停止する。completion は resolve される（reject ではない）。 */
  cancel(key: string): void {
    const entry = this.active.get(key);
    if (entry) {
      this.active.delete(key);
      entry.resolve();
    }
  }

  /** prefix に前方一致する全 key の tween を停止する。 */
  cancelByPrefix(prefix: string): void {
    for (const [key, entry] of this.active) {
      if (key.startsWith(prefix)) {
        this.active.delete(key);
        entry.resolve();
      }
    }
  }

  /** 指定 key の tween がアクティブかどうかを返す。 */
  isActive(key: string): boolean {
    return this.active.has(key);
  }

  /** アクティブな tween の数を返す。 */
  get activeCount(): number {
    return this.active.size;
  }

  /**
   * フレーム更新。now（ミリ秒）を渡して全アクティブ tween を進める。
   * 完了した tween は自動的に削除される。
   */
  tick(now: number): void {
    for (const [key, entry] of this.active) {
      if (entry.startTime < 0) entry.startTime = now;
      const t = Math.min((now - entry.startTime) / entry.durationMs, 1);
      entry.apply(entry.lerp(entry.from, entry.to, t));
      if (t >= 1) {
        this.active.delete(key);
        entry.resolve();
      }
    }
  }

  /** 現在アクティブな tween の進捗スナップショットを返す。 */
  getActive(): ReadonlyArray<TweenEntry> {
    const now = performance.now();
    return [...this.active.values()].map((e) => {
      const elapsed = e.startTime < 0 ? 0 : now - e.startTime;
      return {
        key: e.key,
        progress: Math.min(elapsed / e.durationMs, 1),
        remainingMs: Math.max(e.durationMs - elapsed, 0),
      };
    });
  }

  /** tween を登録する共通実装。型パラメータで数値・ベクトル両方に対応。 */
  private _register<T>(
    key: string,
    from: T,
    to: T,
    durationMs: number,
    lerp: (a: T, b: T, t: number) => T,
    apply: (v: T) => void,
  ): TweenHandle {
    // durationMs=0 の場合は即時 apply して resolve（division-by-zero / zombie tween 防止）
    if (durationMs <= 0) {
      const old = this.active.get(key);
      if (old) {
        this.active.delete(key);
        old.resolve();
      }
      apply(to);
      let resolve!: () => void;
      const completion = new Promise<void>((r) => {
        resolve = r;
      });
      resolve();
      return { cancel: () => {}, completion };
    }

    // 同一 key が存在する場合は古いエントリを resolve して置換（last-write-wins）
    const old = this.active.get(key);
    if (old) old.resolve();

    let resolve!: () => void;
    const completion = new Promise<void>((r) => {
      resolve = r;
    });

    const entry: ActiveTween = {
      key,
      startTime: -1,
      durationMs,
      lerp: lerp as (a: unknown, b: unknown, t: number) => unknown,
      from,
      to,
      apply: apply as (v: unknown) => void,
      resolve,
    };
    this.active.set(key, entry);
    return {
      cancel: () => {
        if (this.active.get(key) === entry) {
          this.active.delete(key);
          resolve();
        }
      },
      completion,
    };
  }
}
