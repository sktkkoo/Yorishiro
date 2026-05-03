import type { Disposable, Vec3 } from "../../sdk/context";

export type PositionEvaluator = (elapsed: number, delta: number) => Vec3;
export type FovEvaluator = (elapsed: number, delta: number) => number;

/**
 * Scene pack が登録する camera modulation の registry。
 * 毎フレーム evaluate し、position/fov の additive offset を返す。
 */
export class CameraModulationRegistry {
  private readonly positionMods = new Map<string, PositionEvaluator>();
  private readonly fovMods = new Map<string, FovEvaluator>();
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
  evaluatePosition(elapsed: number, delta: number): Vec3 {
    let x = 0;
    let y = 0;
    let z = 0;
    for (const evaluate of this.positionMods.values()) {
      const v = evaluate(elapsed, delta);
      x += v.x;
      y += v.y;
      z += v.z;
    }
    return { x, y, z };
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
