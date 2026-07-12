export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface JointDefinition {
  id: string;
  parentIndex: number;
  restPosition: Vec3;
  restRotation: Quat;
  massHint?: number;
  responseWeight?: number;
  maxAngleRad?: number;
}

export interface SkeletonDefinition {
  joints: JointDefinition[];
}

/** 外界の作用を model space の impulse として表す。 */
export interface ForceEvent {
  point?: Vec3;
  direction: Vec3;
  magnitude: number;
  falloffRadius?: number;
  tag?: string;
}

export interface Pose {
  rotations: Quat[];
}

export interface CorrectionPose {
  rotationDeltas: Quat[];
  rootOffset?: Vec3;
}

/**
 * 感触の初期値は実機観察で調整する前提であり、互換性を保証する仕様値ではない。
 */
export interface BodyResponseParams {
  stiffness: number;
  damping: number;
  propagation: number;
  propagationDelay: number;
  recoveryTime: number;
  gain: number;
  energyDecay: number;
  maxDeltaTime: number;
  defaultMaxAngleRad: number;
}

export interface BodyResponseSimulator {
  applyImpulse(event: ForceEvent): void;
  step(targetPose: Pose, dt: number): CorrectionPose;
  setParams(params: Partial<BodyResponseParams>): void;
  reset(): void;
}

/** backend の置換時も producer と adapter の契約を維持する境界。 */
export interface ResponseBackend extends BodyResponseSimulator {}
