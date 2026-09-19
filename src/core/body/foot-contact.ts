import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";

export type FootSide = "left" | "right";
const SIDES: readonly FootSide[] = ["left", "right"];

/** Source support annotations, not a request to pin both feet for an entire clip. */
export interface FootContactProfile {
  readonly sourceSha256: string;
  readonly durationSec: number;
  readonly left: readonly (readonly [number, number])[];
  readonly right: readonly (readonly [number, number])[];
}

export function isFootContactProfileValid(profile: FootContactProfile): boolean {
  if (
    !/^[a-f0-9]{64}$/.test(profile.sourceSha256) ||
    !Number.isFinite(profile.durationSec) ||
    profile.durationSec <= 0
  )
    return false;
  return SIDES.every((side) => {
    let previousEnd = -Infinity;
    return (
      Array.isArray(profile[side]) &&
      profile[side].every((interval) => {
        if (!Array.isArray(interval)) return false;
        const [start, end] = interval;
        const valid =
          interval.length === 2 &&
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start >= 0 &&
          start >= previousEnd &&
          end <= profile.durationSec &&
          end - start >= 2;
        previousEnd = end;
        return valid;
      })
    );
  });
}

export interface FootContactPlayback {
  readonly id: number;
  readonly phaseSec: number;
  readonly strength: number;
  readonly profile: FootContactProfile;
}

interface Leg {
  readonly nodes: readonly THREE.Object3D[];
  readonly upper: THREE.Object3D;
  readonly lower: THREE.Object3D;
  readonly foot: THREE.Object3D;
  readonly toe: THREE.Object3D;
  readonly floorCenter: THREE.Vector3;
  readonly anchor: THREE.Vector3;
  readonly original: THREE.Quaternion[];
  readonly footWorld: THREE.Quaternion;
  readonly center: THREE.Vector3;
  readonly ankle: THREE.Vector3;
  readonly desired: THREE.Vector3;
  episode: number;
  acquiredAt: number;
  weight: number;
}

const ENTER_SEC = 0.35;
const RELEASE_SEC = 0.35;
const MAX_PELVIS = 0.06;
const MAX_REACH = 0.012;
const MAX_INDEPENDENT = 0.06;
const MAX_ROTATION = (25 * Math.PI) / 180;
const ease = (x: number) => {
  const t = THREE.MathUtils.clamp(x, 0, 1);
  return t * t * t * (10 + t * (-15 + 6 * t));
};

/**
 * Contact correction after composition, before humanoid propagation. Only verified
 * source support episodes participate. An unsupported foot retains its local
 * rotations; authored ankle orientation and knee pole are retained by the solve.
 * Corrections are restored before the next mixer evaluation, never accumulated.
 */
export class FootContactController {
  private readonly hips: THREE.Object3D | null;
  private readonly legs: Partial<Record<FootSide, Leg>> = {};
  private readonly originalHips = new THREE.Vector3();
  private readonly pelvis = new THREE.Vector3();
  private readonly beforeReach = new THREE.Vector3();
  private readonly temporary = new THREE.Vector3();
  private readonly hipPosition = new THREE.Vector3();
  private readonly kneePosition = new THREE.Vector3();
  private readonly targetPosition = new THREE.Vector3();
  private readonly solver = {
    h: new THREE.Vector3(),
    k: new THREE.Vector3(),
    a: new THREE.Vector3(),
    direction: new THREE.Vector3(),
    pole: new THREE.Vector3(),
    knee: new THREE.Vector3(),
    currentKnee: new THREE.Vector3(),
    currentAnkle: new THREE.Vector3(),
    target: new THREE.Vector3(),
    upperWorld: new THREE.Quaternion(),
    lowerWorld: new THREE.Quaternion(),
    delta: new THREE.Quaternion(),
    parent: new THREE.Quaternion(),
  };
  private readonly rootScale = new THREE.Vector3();
  private readonly lastRoot = new THREE.Matrix4();
  private readonly rootPosition = new THREE.Vector3();
  private readonly rootRotation = new THREE.Quaternion();
  private readonly lastPosition = new THREE.Vector3();
  private readonly lastRotation = new THREE.Quaternion();
  private readonly lastScale = new THREE.Vector3();
  private corrected = false;
  private owner: number | null = null;
  private clock = 0;
  private hasRoot = false;
  private readonly diagnostic = {
    active: false,
    leftWeight: 0,
    rightWeight: 0,
    pelvisCorrectionMetres: 0,
    maxContactErrorMetres: 0,
    rejected: null as string | null,
  };

  constructor(private readonly vrm: VRM) {
    this.hips = vrm.humanoid?.getNormalizedBoneNode("hips") ?? null;
    vrm.scene.updateMatrixWorld(true);
    for (const side of SIDES) {
      const nodes = ["UpperLeg", "LowerLeg", "Foot", "Toes"].map((part) =>
        vrm.humanoid?.getNormalizedBoneNode(`${side}${part}` as VRMHumanBoneName),
      );
      const [upper, lower, foot, toe] = nodes;
      if (!upper || !lower || !foot || !toe) continue;
      const center = foot.getWorldPosition(new THREE.Vector3());
      center.add(toe.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
      this.legs[side] = {
        nodes: [upper, lower, foot],
        upper,
        lower,
        foot,
        toe,
        floorCenter: vrm.scene.worldToLocal(center.clone()),
        anchor: center.clone(),
        original: [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()],
        footWorld: new THREE.Quaternion(),
        center: new THREE.Vector3(),
        ankle: new THREE.Vector3(),
        desired: new THREE.Vector3(),
        episode: -1,
        acquiredAt: 0,
        weight: 0,
      };
    }
  }

  restore(): void {
    if (!this.corrected || !this.hips) return;
    this.hips.position.copy(this.originalHips);
    for (const side of SIDES) {
      const leg = this.legs[side];
      if (!leg) continue;
      for (let index = 0; index < leg.nodes.length; index++)
        leg.nodes[index].quaternion.copy(leg.original[index]);
    }
    this.corrected = false;
  }

  clear(): void {
    this.restore();
    this.owner = null;
    for (const side of SIDES) {
      const leg = this.legs[side];
      if (leg) {
        leg.episode = -1;
        leg.weight = 0;
      }
    }
    this.diagnostic.active = false;
    this.diagnostic.leftWeight = this.diagnostic.rightWeight = 0;
  }

  getSnapshot() {
    return { ...this.diagnostic };
  }

  update(delta: number, playback: FootContactPlayback | null): void {
    this.diagnostic.rejected = null;
    this.diagnostic.pelvisCorrectionMetres = this.diagnostic.maxContactErrorMetres = 0;
    if (!this.hips || !this.legs.left || !this.legs.right || !playback) {
      this.clear();
      return;
    }
    if (!Number.isFinite(delta) || delta < 0 || delta > 0.1) {
      this.clear();
      this.diagnostic.rejected = "unreliable-frame";
      return;
    }
    this.clock += delta;
    this.vrm.scene.updateMatrixWorld(true);
    this.vrm.scene.matrixWorld.decompose(this.rootPosition, this.rootRotation, this.rootScale);
    if (
      !Number.isFinite(this.rootScale.x + this.rootScale.y + this.rootScale.z) ||
      Math.min(this.rootScale.x, this.rootScale.y, this.rootScale.z) <= 0 ||
      Math.max(this.rootScale.x, this.rootScale.y, this.rootScale.z) -
        Math.min(this.rootScale.x, this.rootScale.y, this.rootScale.z) >
        1e-5
    ) {
      this.clear();
      this.diagnostic.rejected = "unsupported-scale";
      return;
    }
    const scale = this.rootScale.x;
    if (this.hasRoot) {
      this.lastRoot.decompose(this.lastPosition, this.lastRotation, this.lastScale);
      if (
        this.rootPosition.distanceTo(this.lastPosition) > 0.05 * scale ||
        this.rootRotation.angleTo(this.lastRotation) > 0.1 ||
        this.rootScale.distanceTo(this.lastScale) > 1e-5
      )
        this.clear();
    }
    this.lastRoot.copy(this.vrm.scene.matrixWorld);
    this.hasRoot = true;
    if (this.owner !== playback.id) {
      this.clear();
      this.owner = playback.id;
    }
    this.originalHips.copy(this.hips.position);
    this.pelvis.set(0, 0, 0);
    let total = 0;
    for (const side of SIDES) {
      const leg = this.legs[side];
      if (!leg) continue;
      for (let index = 0; index < leg.nodes.length; index++)
        leg.original[index].copy(leg.nodes[index].quaternion);
      leg.foot.getWorldPosition(leg.ankle);
      leg.toe.getWorldPosition(leg.center).add(leg.ankle).multiplyScalar(0.5);
      leg.foot.getWorldQuaternion(leg.footWorld);
      let episode = -1;
      const intervals = playback.profile[side];
      for (let index = 0; index < intervals.length; index++) {
        if (playback.phaseSec >= intervals[index][0] && playback.phaseSec <= intervals[index][1]) {
          episode = index;
          break;
        }
      }
      // A new stance remains authored throughout its entry crossfade. Only lock
      // its settled placement, rather than pulling it into the preceding stance.
      if (leg.episode === -1 && playback.strength < 0.999) episode = -1;
      if (episode !== leg.episode) {
        leg.episode = episode;
        leg.acquiredAt = this.clock;
        leg.anchor.copy(leg.center);
        // The standing reference defines sole height on this avatar; preserve
        // current horizontal placement, never drag a new stance into the old one.
        const floor = this.vrm.scene.localToWorld(this.temporary.copy(leg.floorCenter));
        leg.anchor.y = floor.y;
      }
      const interval = playback.profile[side][episode];
      leg.weight = interval
        ? ease((this.clock - leg.acquiredAt) / ENTER_SEC) *
          ease((playback.phaseSec - interval[0]) / ENTER_SEC) *
          ease((interval[1] - playback.phaseSec) / RELEASE_SEC) *
          THREE.MathUtils.clamp(playback.strength, 0, 1)
        : 0;
      leg.desired.copy(leg.anchor).sub(leg.center);
      if (leg.weight > 0 && leg.desired.length() > MAX_INDEPENDENT * scale) {
        // Displacement beyond the bounded standing solve is a step/reposition,
        // not a license to stretch a leg. Re-acquire smoothly at the new stance.
        leg.anchor.copy(leg.center);
        leg.anchor.y = this.vrm.scene.localToWorld(this.temporary.copy(leg.floorCenter)).y;
        leg.acquiredAt = this.clock;
        leg.weight = 0;
        this.diagnostic.rejected = "contact-displacement";
      }
      this.pelvis.addScaledVector(leg.desired, leg.weight);
      total += leg.weight;
    }
    this.pelvis.divideScalar(Math.max(1, total));
    this.beforeReach.copy(this.pelvis);
    // Keep the ankle target reachable without changing the authored knee plane.
    for (let iteration = 0; iteration < 8; iteration++) {
      let moved = false;
      for (const side of SIDES) {
        const leg = this.legs[side];
        if (!leg || leg.weight < 1e-6) continue;
        const hip = leg.upper.getWorldPosition(this.hipPosition);
        const knee = leg.lower.getWorldPosition(this.kneePosition);
        const maximum = hip.distanceTo(knee) + knee.distanceTo(leg.ankle) - 0.00002 * scale;
        const target = this.targetPosition
          .copy(leg.ankle)
          .sub(hip)
          .addScaledVector(this.temporary.copy(leg.desired).sub(this.pelvis), leg.weight);
        const distance = target.length();
        if (distance > maximum) {
          this.pelvis.addScaledVector(target.normalize(), (distance - maximum) / leg.weight);
          moved = true;
        }
      }
      if (!moved) break;
    }
    if (
      this.pelvis.length() > MAX_PELVIS * scale ||
      this.pelvis.distanceTo(this.beforeReach) > MAX_REACH * scale
    ) {
      this.diagnostic.rejected = "pelvis-budget";
      this.clear();
      return;
    }
    this.corrected = true;
    const hipTarget = this.hips.getWorldPosition(this.hipPosition).add(this.pelvis);
    this.hips.position.copy(this.hips.parent?.worldToLocal(hipTarget) ?? hipTarget);
    this.hips.updateWorldMatrix(true, true);
    for (const side of SIDES) {
      const leg = this.legs[side];
      if (!leg || leg.weight < 1e-6) continue;
      const target = this.targetPosition
        .copy(leg.ankle)
        .add(this.pelvis)
        .addScaledVector(this.temporary.copy(leg.desired).sub(this.pelvis), leg.weight);
      if (!solveLeg(leg, target, scale, this.solver)) {
        this.diagnostic.rejected = "leg-budget-or-pole";
        this.clear();
        return;
      }
    }
    this.vrm.scene.updateMatrixWorld(true);
    this.diagnostic.active = total > 0;
    this.diagnostic.leftWeight = this.legs.left.weight;
    this.diagnostic.rightWeight = this.legs.right.weight;
    this.diagnostic.pelvisCorrectionMetres = this.pelvis.length();
    for (const side of SIDES) {
      const leg = this.legs[side];
      if (!leg || leg.weight < 0.999) continue;
      const center = leg.foot.getWorldPosition(this.temporary);
      center.add(leg.toe.getWorldPosition(this.targetPosition)).multiplyScalar(0.5);
      this.diagnostic.maxContactErrorMetres = Math.max(
        this.diagnostic.maxContactErrorMetres,
        center.distanceTo(leg.anchor),
      );
    }
  }
}

function setWorldQuaternion(
  node: THREE.Object3D,
  world: THREE.Quaternion,
  parent: THREE.Quaternion,
) {
  if (node.parent) node.parent.getWorldQuaternion(parent);
  else parent.identity();
  node.quaternion.copy(parent.invert().multiply(world)).normalize();
  node.updateWorldMatrix(false, true);
}

function solveLeg(
  leg: Leg,
  target: THREE.Vector3,
  scale: number,
  scratch: {
    h: THREE.Vector3;
    k: THREE.Vector3;
    a: THREE.Vector3;
    direction: THREE.Vector3;
    pole: THREE.Vector3;
    knee: THREE.Vector3;
    currentKnee: THREE.Vector3;
    currentAnkle: THREE.Vector3;
    target: THREE.Vector3;
    upperWorld: THREE.Quaternion;
    lowerWorld: THREE.Quaternion;
    delta: THREE.Quaternion;
    parent: THREE.Quaternion;
  },
): boolean {
  const h = leg.upper.getWorldPosition(scratch.h);
  const k = leg.lower.getWorldPosition(scratch.k);
  const a = leg.foot.getWorldPosition(scratch.a);
  const upperLength = h.distanceTo(k);
  const lowerLength = k.distanceTo(a);
  const direction = scratch.direction.copy(target).sub(h);
  const distance = direction.length();
  if (distance >= upperLength + lowerLength || distance <= Math.abs(upperLength - lowerLength))
    return false;
  direction.normalize();
  const pole = scratch.pole.copy(k).sub(h);
  pole.addScaledVector(direction, -pole.dot(direction));
  if (pole.length() < 1e-5 * scale) return false;
  pole.normalize();
  const x = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
  const knee = scratch.knee
    .copy(h)
    .addScaledVector(direction, x)
    .addScaledVector(pole, Math.sqrt(Math.max(0, upperLength ** 2 - x ** 2)));
  const upperWorld = leg.upper.getWorldQuaternion(scratch.upperWorld);
  const upperDelta = scratch.delta.setFromUnitVectors(
    scratch.currentKnee.copy(k).sub(h).normalize(),
    scratch.target.copy(knee).sub(h).normalize(),
  );
  setWorldQuaternion(leg.upper, upperDelta.multiply(upperWorld), scratch.parent);
  const currentKnee = leg.lower.getWorldPosition(scratch.currentKnee);
  const currentAnkle = leg.foot.getWorldPosition(scratch.currentAnkle);
  const lowerWorld = leg.lower.getWorldQuaternion(scratch.lowerWorld);
  const lowerDelta = scratch.delta.setFromUnitVectors(
    currentAnkle.sub(currentKnee).normalize(),
    scratch.target.copy(target).sub(currentKnee).normalize(),
  );
  setWorldQuaternion(leg.lower, lowerDelta.multiply(lowerWorld), scratch.parent);
  setWorldQuaternion(leg.foot, leg.footWorld, scratch.parent);
  for (let index = 0; index < leg.nodes.length; index++)
    if (leg.nodes[index].quaternion.angleTo(leg.original[index]) > MAX_ROTATION) return false;
  return true;
}
