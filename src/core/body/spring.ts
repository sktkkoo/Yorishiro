/**
 * Spring1D — 1 次元の減衰スプリング積分器。
 *
 * underdamped（zeta < 1）で overshoot を作り、follow-through（残し・行き過ぎ→戻り）
 * の本体になる。target が離散ジャンプするとき snap → overshoot → settle の
 * 速度コントラストが自然発生する。
 *
 * Pure data logic, no VRM dependency.
 */

const MAX_DT = 1 / 20;

export interface SpringParams {
  /** 固有角周波数（rad/s）。大きいほど剛性が高い＝snap が速い。 */
  readonly omega: number;
  /** 減衰比。< 1 で underdamped（overshoot あり）、= 1 で critically damped。 */
  readonly zeta: number;
  /** 初期位置。省略時 0。 */
  readonly initialPos?: number;
}

export class Spring1D {
  pos: number;
  vel = 0;
  private omega: number;
  private zeta: number;

  constructor(params: SpringParams) {
    this.omega = params.omega;
    this.zeta = params.zeta;
    this.pos = params.initialPos ?? 0;
  }

  /** パラメータを動的に変更。位置と速度は維持。 */
  setParams(omega: number, zeta: number): void {
    this.omega = omega;
    this.zeta = zeta;
  }

  /** 1 step 進める。target に向かって spring 追従し、現在位置を返す。 */
  update(dt: number, target: number): number {
    const clamped = Math.min(dt, MAX_DT);
    const o2 = this.omega * this.omega;
    const acc = o2 * (target - this.pos) - 2 * this.zeta * this.omega * this.vel;
    this.vel += acc * clamped;
    this.pos += this.vel * clamped;
    return this.pos;
  }
}
