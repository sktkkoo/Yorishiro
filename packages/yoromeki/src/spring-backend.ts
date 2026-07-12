import { TENTATIVE_RESPONSE_DEFAULTS } from "./default-params";
import {
  add,
  cross,
  finiteVec,
  length,
  normalize,
  rotationVectorToQuat,
  scale,
  subtract,
  ZERO,
} from "./math";
import type {
  BodyResponseParams,
  CorrectionPose,
  ForceEvent,
  Pose,
  ResponseBackend,
  SkeletonDefinition,
  Vec3,
} from "./types";

interface JointState {
  offset: Vec3;
  velocity: Vec3;
  history: Vec3[];
}

const INTERNAL_STEP = 1 / 120;

function sanitizeParams(params: Partial<BodyResponseParams>): BodyResponseParams {
  const merged = { ...TENTATIVE_RESPONSE_DEFAULTS, ...params };
  return {
    stiffness: Math.max(0, Number.isFinite(merged.stiffness) ? merged.stiffness : 0),
    damping: Math.max(0, Number.isFinite(merged.damping) ? merged.damping : 0),
    propagation: Math.max(
      0,
      Math.min(1, Number.isFinite(merged.propagation) ? merged.propagation : 0),
    ),
    propagationDelay: Math.max(
      0,
      Number.isFinite(merged.propagationDelay) ? merged.propagationDelay : 0,
    ),
    recoveryTime: Math.max(1e-3, Number.isFinite(merged.recoveryTime) ? merged.recoveryTime : 1),
    gain: Math.max(0, Number.isFinite(merged.gain) ? merged.gain : 0),
    energyDecay: Math.max(0, Number.isFinite(merged.energyDecay) ? merged.energyDecay : 0),
    maxDeltaTime: Math.max(0, Number.isFinite(merged.maxDeltaTime) ? merged.maxDeltaTime : 0),
    defaultMaxAngleRad: Math.max(
      0,
      Number.isFinite(merged.defaultMaxAngleRad) ? merged.defaultMaxAngleRad : 0,
    ),
  };
}

/** target pose 相対の回転差だけを保持する spring-damper backend。 */
export class SpringBackend implements ResponseBackend {
  readonly #skeleton: SkeletonDefinition;
  readonly #positions: Vec3[];
  readonly #states: JointState[];
  #params: BodyResponseParams;

  constructor(skeleton: SkeletonDefinition, params: Partial<BodyResponseParams> = {}) {
    this.#skeleton = skeleton;
    this.#params = sanitizeParams(params);
    this.#positions = [];
    for (let index = 0; index < skeleton.joints.length; index += 1) {
      const joint = skeleton.joints[index];
      const parent = joint.parentIndex;
      this.#positions.push(
        parent >= 0 && parent < index
          ? add(this.#positions[parent], joint.restPosition)
          : { ...joint.restPosition },
      );
    }
    this.#states = skeleton.joints.map(() => ({
      offset: { ...ZERO },
      velocity: { ...ZERO },
      history: [],
    }));
  }

  applyImpulse(event: ForceEvent): void {
    const direction = normalize(event.direction);
    if (!direction || !Number.isFinite(event.magnitude) || event.magnitude === 0) return;
    const point = event.point && finiteVec(event.point) ? event.point : { x: 0, y: 1, z: 0 };
    const radius = Number.isFinite(event.falloffRadius) ? Math.max(0, event.falloffRadius ?? 0) : 0;

    for (let index = 0; index < this.#states.length; index += 1) {
      const joint = this.#skeleton.joints[index];
      const arm = subtract(point, this.#positions[index]);
      const distance = length(arm);
      const falloff = radius > 0 ? Math.max(0, 1 - distance / radius) : 1;
      const weight = Math.max(0, Math.min(1, joint.responseWeight ?? 1));
      const mass = Math.max(1e-3, Number.isFinite(joint.massHint) ? (joint.massHint ?? 1) : 1);
      let axis = cross(arm, direction);
      if (length(axis) <= 1e-9) axis = cross({ x: 0, y: 1, z: 0 }, direction);
      const impulse = scale(axis, (event.magnitude * this.#params.gain * weight * falloff) / mass);
      if (finiteVec(impulse))
        this.#states[index].velocity = add(this.#states[index].velocity, impulse);
    }
  }

  step(_targetPose: Pose, dt: number): CorrectionPose {
    const elapsed = Number.isFinite(dt) ? Math.max(0, Math.min(dt, this.#params.maxDeltaTime)) : 0;
    let remaining = elapsed;
    while (remaining > 1e-9) {
      const slice = Math.min(INTERNAL_STEP, remaining);
      this.#integrate(slice);
      remaining -= slice;
    }
    return { rotationDeltas: this.#states.map((state) => rotationVectorToQuat(state.offset)) };
  }

  setParams(params: Partial<BodyResponseParams>): void {
    this.#params = sanitizeParams({ ...this.#params, ...params });
  }

  reset(): void {
    for (const state of this.#states) {
      state.offset = { ...ZERO };
      state.velocity = { ...ZERO };
      state.history.length = 0;
    }
  }

  #integrate(dt: number): void {
    const historyLength = Math.max(1, Math.ceil(this.#params.propagationDelay / INTERNAL_STEP));
    const previousOffsets = this.#states.map((state) => state.offset);
    for (let index = 0; index < this.#states.length; index += 1) {
      const state = this.#states[index];
      const parentIndex = this.#skeleton.joints[index].parentIndex;
      const parent = parentIndex >= 0 ? this.#states[parentIndex] : undefined;
      const delayedParent = parent?.history[0] ?? ZERO;
      const target = scale(delayedParent, this.#params.propagation);
      const spring = scale(subtract(target, state.offset), this.#params.stiffness);
      const damping = scale(state.velocity, -this.#params.damping);
      state.velocity = add(state.velocity, scale(add(spring, damping), dt));
      const decay = Math.exp((-this.#params.energyDecay * dt) / this.#params.recoveryTime);
      state.velocity = scale(state.velocity, decay);
      state.offset = add(state.offset, scale(state.velocity, dt));

      const limit = Math.max(
        0,
        this.#skeleton.joints[index].maxAngleRad ?? this.#params.defaultMaxAngleRad,
      );
      const angle = length(state.offset);
      if (!finiteVec(state.offset) || !finiteVec(state.velocity)) {
        state.offset = { ...ZERO };
        state.velocity = { ...ZERO };
      } else if (angle > limit && angle > 0) {
        state.offset = scale(state.offset, limit / angle);
        const outwardSpeed =
          state.velocity.x * state.offset.x +
          state.velocity.y * state.offset.y +
          state.velocity.z * state.offset.z;
        if (outwardSpeed > 0) state.velocity = scale(state.velocity, 0.5);
      }
    }
    for (let index = 0; index < this.#states.length; index += 1) {
      const history = this.#states[index].history;
      history.push(previousOffsets[index]);
      while (history.length > historyLength) history.shift();
    }
  }
}
