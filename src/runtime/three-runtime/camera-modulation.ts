import type { Disposable, Vec3 } from "../../sdk/context";

export type PositionEvaluator = (elapsed: number, delta: number, out: Vec3) => Vec3 | undefined;
export type FovEvaluator = (elapsed: number, delta: number) => number;

/**
 * Scene pack が登録する camera modulation の registry。
 * 毎フレーム evaluate し、position/fov の additive offset を返す。
 */
export class CameraModulationRegistry {
  private readonly positionMods = new Map<string, PositionEvaluator>();
  private readonly fovMods = new Map<string, FovEvaluator>();
  private readonly evaluatorScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly resultScratch: Vec3 = { x: 0, y: 0, z: 0 };
  private _enabled = true;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(v: boolean) {
    this._enabled = v;
  }

  addPositionModulation(key: string, evaluate: PositionEvaluator): Disposable {
    this.positionMods.set(key, evaluate);
    return {
      dispose: () => {
        if (this.positionMods.get(key) === evaluate) {
          this.positionMods.delete(key);
        }
      },
    };
  }

  addFovModulation(key: string, evaluate: FovEvaluator): Disposable {
    this.fovMods.set(key, evaluate);
    return {
      dispose: () => {
        if (this.fovMods.get(key) === evaluate) {
          this.fovMods.delete(key);
        }
      },
    };
  }

  /** 全 modulation offset の合算を返す */
  evaluatePosition(elapsed: number, delta: number, out: Vec3 = this.resultScratch): Vec3 {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const evaluate of this.positionMods.values()) {
      const scratch = this.evaluatorScratch;
      scratch.x = 0;
      scratch.y = 0;
      scratch.z = 0;
      const v = evaluate(elapsed, delta, scratch) ?? scratch;
      x += v.x;
      y += v.y;
      z += v.z;
    }
    out.x = x;
    out.y = y;
    out.z = z;
    return out;
  }

  /** 全 FOV offset の合算を返す */
  evaluateFov(elapsed: number, delta: number): number {
    let total = 0;
    for (const evaluate of this.fovMods.values()) {
      total += evaluate(elapsed, delta);
    }
    return total;
  }

  clearAll(): void {
    this.positionMods.clear();
    this.fovMods.clear();
  }

  get activeKeys(): readonly string[] {
    return [...this.positionMods.keys(), ...this.fovMods.keys()];
  }
}
