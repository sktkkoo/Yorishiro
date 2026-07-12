import type {
  BodyResponseParams,
  CorrectionPose,
  ForceEvent,
  Pose,
  ResponseBackend,
  SkeletonDefinition,
} from "./types";

const IDENTITY = Object.freeze({ x: 0, y: 0, z: 0, w: 1 });

/** P1 の API 配線を検証するため、常に単位回転を返す backend。 */
export class NoopBackend implements ResponseBackend {
  readonly #jointCount: number;

  constructor(skeleton: SkeletonDefinition) {
    this.#jointCount = skeleton.joints.length;
  }

  applyImpulse(_event: ForceEvent): void {}

  step(_targetPose: Pose, _dt: number): CorrectionPose {
    return {
      rotationDeltas: Array.from({ length: this.#jointCount }, () => ({ ...IDENTITY })),
    };
  }

  setParams(_params: Partial<BodyResponseParams>): void {}

  reset(): void {}
}
