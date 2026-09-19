import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";

/** Provisional engineering filters, not perceptual scores or biomechanical limits. */
export const COMPOSED_MOTION_THRESHOLDS = {
  frameStallSec: 0.1,
  angularPredictionErrorRad: 0.05,
  angularAccelerationRadSec2: 120,
  positionPredictionErrorM: 0.015,
  linearAccelerationMSec2: 25,
} as const;

const BONES: readonly VRMHumanBoneName[] = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
];
const POSE_STRIDE = 7;

/** Caller-owned scratch; every field is a primitive so ring copies remain allocation-free. */
export interface ComposedMotionContext {
  activity: string;
  conversation: string;
  configuredIntensity: number;
  effectiveIntensity: number;
  animationClaimed: boolean;
  paused: boolean;
  performanceAnimation: string | null;
  performancePhaseSec: number | null;
  performanceWeight: number;
  performanceCount: number;
  recordedUnit: string | null;
  recordedAnimation: string | null;
  recordedPhaseSec: number | null;
  recordedHeld: boolean;
  recordedPaused: boolean;
  recordedUpperStrength: number;
}

export function createComposedMotionContext(): ComposedMotionContext {
  return {
    activity: "idle",
    conversation: "idle",
    configuredIntensity: 1,
    effectiveIntensity: 1,
    animationClaimed: false,
    paused: false,
    performanceAnimation: null,
    performancePhaseSec: null,
    performanceWeight: 0,
    performanceCount: 0,
    recordedUnit: null,
    recordedAnimation: null,
    recordedPhaseSec: null,
    recordedHeld: false,
    recordedPaused: false,
    recordedUpperStrength: 0,
  };
}

interface Frame {
  sequence: number;
  timeSec: number;
  deltaSec: number;
  derivativeBaseline: boolean;
  context: ComposedMotionContext;
  pose: Float32Array;
}

export interface SuspectJoint {
  bone: VRMHumanBoneName;
  angularPredictionErrorRad: number;
  angularAccelerationRadSec2: number;
  positionPredictionErrorM: number;
  linearAccelerationMSec2: number;
}

export interface ComposedMotionEvent {
  sequence: number;
  timeSec: number;
  deltaSec: number;
  kind: "pose-discontinuity-candidate" | "frame-stall" | "invalid-sample";
  context: ComposedMotionContext;
  previousContext: ComposedMotionContext | null;
  /** Strongest six joints at most; a fast intentional gesture may also appear. */
  joints: SuspectJoint[];
  suspectJointCount: number;
}

/**
 * Observes the composed normalized skeleton without writing a pose or smoothing it.
 * Angular/translation prediction uses parent-space shortest-arc velocity and
 * local offsets (normalized VRM metre scale). Avatar-space origins are retained
 * for replay. Local offsets avoid labelling the circular path of a smooth fast
 * limb rotation as a position discontinuity. A constant
 * high speed alone is not suspicious: error from the preceding velocity must
 * exceed both displacement and dt-aware acceleration filters.
 *
 * Fixed numeric/context rings allocate at construction. Only suspects and explicit
 * snapshot exports allocate. Fingers/eyes and skin/mesh collisions are not measured.
 */
export class ComposedMotionMonitor {
  private readonly joints: { name: VRMHumanBoneName; node: THREE.Object3D }[];
  private readonly frames: Frame[];
  private readonly events: (ComposedMotionEvent | undefined)[];
  private readonly previous: Float64Array;
  private readonly velocity: Float64Array;
  private readonly current: Float64Array;
  private readonly localPositions: Float64Array;
  private readonly previousLocalPositions: Float64Array;
  private readonly rotation = new THREE.Quaternion();
  private readonly before = new THREE.Quaternion();
  private readonly difference = new THREE.Quaternion();
  private readonly predicted = new THREE.Quaternion();
  private readonly axis = new THREE.Vector3();
  private readonly position = new THREE.Vector3();
  private readonly avatarInverse = new THREE.Matrix4();
  private frameCursor = 0;
  private frameCount = 0;
  private eventCursor = 0;
  private eventCount = 0;
  private sequence = 0;
  private timeSec = 0;
  private previousDelta = 0;
  private samplesSinceReset = 0;
  private previousPaused = false;
  private readonly previousContext = createComposedMotionContext();
  private poseCandidateCount = 0;
  private frameStallCount = 0;
  private invalidSampleCount = 0;

  constructor(
    private readonly vrm: Pick<VRM, "scene" | "humanoid">,
    options: { frameCapacity?: number; eventCapacity?: number } = {},
  ) {
    this.joints = BONES.flatMap((name) => {
      const node = vrm.humanoid?.getNormalizedBoneNode(name);
      return node ? [{ name, node }] : [];
    });
    const poseSize = this.joints.length * POSE_STRIDE;
    this.previous = new Float64Array(poseSize);
    this.current = new Float64Array(poseSize);
    this.localPositions = new Float64Array(this.joints.length * 3);
    this.previousLocalPositions = new Float64Array(this.joints.length * 3);
    this.velocity = new Float64Array(this.joints.length * 6);
    this.frames = Array.from({ length: capacity(options.frameCapacity, 120, 240) }, () => ({
      sequence: 0,
      timeSec: 0,
      deltaSec: 0,
      derivativeBaseline: false,
      context: createComposedMotionContext(),
      pose: new Float32Array(poseSize),
    }));
    this.events = new Array(capacity(options.eventCapacity, 32, 64));
  }

  /** Reset derivative history after an explicit teleport/reinitialization. Retain diagnostics. */
  reset(): void {
    this.samplesSinceReset = 0;
    this.previousDelta = 0;
  }

  update(deltaSec: number, context: Readonly<ComposedMotionContext>): void {
    this.sequence++;
    if (!Number.isFinite(deltaSec) || deltaSec <= 0) {
      // Zero-time evaluations are legal (bootstrap/paused render), not stalls.
      if (!Number.isFinite(deltaSec) || deltaSec < 0) {
        this.invalidSampleCount++;
        this.recordEvent("invalid-sample", Number.isFinite(deltaSec) ? deltaSec : 0, context);
      }
      this.reset();
      return;
    }
    this.timeSec += deltaSec;
    if (deltaSec >= COMPOSED_MOTION_THRESHOLDS.frameStallSec) {
      this.frameStallCount++;
      this.recordEvent("frame-stall", deltaSec, context);
      this.reset();
    }
    if (context.paused !== this.previousPaused || context.paused) this.reset();
    this.previousPaused = context.paused;
    if (!this.readPose()) {
      this.invalidSampleCount++;
      this.recordEvent("invalid-sample", deltaSec, context);
      this.reset();
      return;
    }

    const frame = this.frames[this.frameCursor];
    frame.sequence = this.sequence;
    frame.timeSec = this.timeSec;
    frame.deltaSec = deltaSec;
    frame.derivativeBaseline = this.samplesSinceReset < 2;
    Object.assign(frame.context, context);
    frame.pose.set(this.current);
    this.frameCursor = (this.frameCursor + 1) % this.frames.length;
    this.frameCount = Math.min(this.frames.length, this.frameCount + 1);

    let event: ComposedMotionEvent | undefined;
    if (this.samplesSinceReset > 0) {
      const accelerationDt = (deltaSec + this.previousDelta) / 2;
      for (let index = 0; index < this.joints.length; index++) {
        const p = index * POSE_STRIDE,
          v = index * 6,
          l = index * 3;
        this.before.fromArray(this.previous, p);
        this.rotation.fromArray(this.current, p);
        this.difference.copy(this.before).invert().premultiply(this.rotation).normalize();
        if (this.difference.w < 0)
          this.difference.set(
            -this.difference.x,
            -this.difference.y,
            -this.difference.z,
            -this.difference.w,
          );
        const sinHalf = Math.hypot(this.difference.x, this.difference.y, this.difference.z);
        const factor =
          sinHalf > 1e-10 ? (2 * Math.atan2(sinHalf, this.difference.w)) / (sinHalf * deltaSec) : 0;
        const wx = this.difference.x * factor,
          wy = this.difference.y * factor,
          wz = this.difference.z * factor;
        const vx = (this.localPositions[l] - this.previousLocalPositions[l]) / deltaSec;
        const vy = (this.localPositions[l + 1] - this.previousLocalPositions[l + 1]) / deltaSec;
        const vz = (this.localPositions[l + 2] - this.previousLocalPositions[l + 2]) / deltaSec;
        if (this.samplesSinceReset > 1) {
          const angularAcceleration =
            Math.hypot(
              wx - this.velocity[v],
              wy - this.velocity[v + 1],
              wz - this.velocity[v + 2],
            ) / accelerationDt;
          const linearAcceleration =
            Math.hypot(
              vx - this.velocity[v + 3],
              vy - this.velocity[v + 4],
              vz - this.velocity[v + 5],
            ) / accelerationDt;
          this.axis.fromArray(this.velocity, v);
          const angularSpeed = this.axis.length();
          if (angularSpeed > 1e-10)
            this.predicted.setFromAxisAngle(
              this.axis.multiplyScalar(1 / angularSpeed),
              angularSpeed * deltaSec,
            );
          else this.predicted.identity();
          this.predicted.multiply(this.before).normalize();
          const angularError = this.predicted.angleTo(this.rotation);
          const positionError = Math.hypot(
            this.localPositions[l] -
              this.previousLocalPositions[l] -
              this.velocity[v + 3] * deltaSec,
            this.localPositions[l + 1] -
              this.previousLocalPositions[l + 1] -
              this.velocity[v + 4] * deltaSec,
            this.localPositions[l + 2] -
              this.previousLocalPositions[l + 2] -
              this.velocity[v + 5] * deltaSec,
          );
          if (
            (angularError > COMPOSED_MOTION_THRESHOLDS.angularPredictionErrorRad &&
              angularAcceleration > COMPOSED_MOTION_THRESHOLDS.angularAccelerationRadSec2) ||
            (positionError > COMPOSED_MOTION_THRESHOLDS.positionPredictionErrorM &&
              linearAcceleration > COMPOSED_MOTION_THRESHOLDS.linearAccelerationMSec2)
          ) {
            if (!event) {
              this.poseCandidateCount++;
              event = this.recordEvent("pose-discontinuity-candidate", deltaSec, context);
            }
            event.suspectJointCount++;
            event.joints.push({
              bone: this.joints[index].name,
              angularPredictionErrorRad: angularError,
              angularAccelerationRadSec2: angularAcceleration,
              positionPredictionErrorM: positionError,
              linearAccelerationMSec2: linearAcceleration,
            });
            event.joints.sort(compareSuspects);
            if (event.joints.length > 6) event.joints.pop();
          }
        }
        this.velocity[v] = wx;
        this.velocity[v + 1] = wy;
        this.velocity[v + 2] = wz;
        this.velocity[v + 3] = vx;
        this.velocity[v + 4] = vy;
        this.velocity[v + 5] = vz;
      }
    }
    this.previous.set(this.current);
    this.previousLocalPositions.set(this.localPositions);
    this.previousDelta = deltaSec;
    this.samplesSinceReset++;
    Object.assign(this.previousContext, context);
  }

  /** Export only on demand. Detailed frames are intentionally omitted from routine state_get. */
  getSnapshot(includeFrames = false) {
    return {
      schemaVersion: 1,
      classification: "suspect candidates; no automatic correction" as const,
      samplingStage:
        "final composed normalized skeleton; local rotations and avatar-space joint origins" as const,
      predictionSpace: "parent-space normalized rotations/translations" as const,
      limitations:
        "Provisional filters; fast intentional changes may be candidates. Excludes fingers, eyes, mesh collisions and avatar scene placement. Performance context identifies the latest real action; count includes overlapping fades." as const,
      thresholds: { ...COMPOSED_MOTION_THRESHOLDS },
      bones: this.joints.map((joint) => joint.name),
      sampleCount: this.sequence,
      poseCandidateCount: this.poseCandidateCount,
      frameStallCount: this.frameStallCount,
      invalidSampleCount: this.invalidSampleCount,
      frameCapacity: this.frames.length,
      eventCapacity: this.events.length,
      events: Array.from({ length: this.eventCount }, (_, index) => {
        const event =
          this.events[
            (this.eventCursor - this.eventCount + index + this.events.length) % this.events.length
          ];
        if (!event) throw new Error("Missing motion diagnostic event");
        return {
          ...event,
          context: { ...event.context },
          previousContext: event.previousContext ? { ...event.previousContext } : null,
          joints: event.joints.map((joint) => ({ ...joint })),
        };
      }),
      ...(includeFrames
        ? {
            poseLayout:
              "per bone: local quaternion xyzw, avatar-space position xyz (metres)" as const,
            frames: Array.from({ length: this.frameCount }, (_, index) => {
              const frame =
                this.frames[
                  (this.frameCursor - this.frameCount + index + this.frames.length) %
                    this.frames.length
                ];
              return { ...frame, context: { ...frame.context }, pose: Array.from(frame.pose) };
            }),
          }
        : {}),
    };
  }

  private readPose(): boolean {
    this.vrm.scene.updateWorldMatrix(true, false);
    const determinant = this.vrm.scene.matrixWorld.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return false;
    this.avatarInverse.copy(this.vrm.scene.matrixWorld).invert();
    for (let index = 0; index < this.joints.length; index++) {
      const node = this.joints[index].node;
      const p = index * POSE_STRIDE;
      this.rotation.copy(node.quaternion);
      const length = this.rotation.lengthSq();
      if (!Number.isFinite(length) || length < 1e-12) return false;
      this.rotation.normalize();
      if (
        this.samplesSinceReset > 0 &&
        this.rotation.dot(this.before.fromArray(this.previous, p)) < 0
      )
        this.rotation.set(-this.rotation.x, -this.rotation.y, -this.rotation.z, -this.rotation.w);
      this.rotation.toArray(this.current, p);
      node.getWorldPosition(this.position).applyMatrix4(this.avatarInverse);
      if (
        !Number.isFinite(this.position.x) ||
        !Number.isFinite(this.position.y) ||
        !Number.isFinite(this.position.z)
      )
        return false;
      this.position.toArray(this.current, p + 4);
      node.position.toArray(this.localPositions, index * 3);
    }
    return true;
  }

  private recordEvent(
    kind: ComposedMotionEvent["kind"],
    deltaSec: number,
    context: Readonly<ComposedMotionContext>,
  ): ComposedMotionEvent {
    const event: ComposedMotionEvent = {
      sequence: this.sequence,
      timeSec: this.timeSec,
      deltaSec,
      kind,
      context: { ...context },
      previousContext: this.samplesSinceReset > 0 ? { ...this.previousContext } : null,
      joints: [],
      suspectJointCount: 0,
    };
    this.events[this.eventCursor] = event;
    this.eventCursor = (this.eventCursor + 1) % this.events.length;
    this.eventCount = Math.min(this.events.length, this.eventCount + 1);
    return event;
  }
}

function compareSuspects(a: SuspectJoint, b: SuspectJoint): number {
  return (
    Math.max(
      b.angularPredictionErrorRad / COMPOSED_MOTION_THRESHOLDS.angularPredictionErrorRad,
      b.positionPredictionErrorM / COMPOSED_MOTION_THRESHOLDS.positionPredictionErrorM,
    ) -
    Math.max(
      a.angularPredictionErrorRad / COMPOSED_MOTION_THRESHOLDS.angularPredictionErrorRad,
      a.positionPredictionErrorM / COMPOSED_MOTION_THRESHOLDS.positionPredictionErrorM,
    )
  );
}

function capacity(value: number | undefined, fallback: number, maximum: number): number {
  return value !== undefined && Number.isFinite(value)
    ? Math.max(3, Math.min(maximum, Math.floor(value)))
    : fallback;
}
