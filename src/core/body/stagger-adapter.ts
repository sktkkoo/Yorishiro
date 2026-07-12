import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import {
  type BodyResponseParams,
  type BodyResponseSimulator,
  createSimulator,
  type ForceEvent,
  type Pose,
  type SkeletonDefinition,
} from "yoromeki";

const CONTROLLED_BONES = [
  "hips",
  "spine",
  "chest",
  "head",
  "leftUpperArm",
  "rightUpperArm",
] as const satisfies ReadonlyArray<VRMHumanBoneName>;

const PARENT_BONE: Partial<
  Record<(typeof CONTROLLED_BONES)[number], (typeof CONTROLLED_BONES)[number]>
> = {
  spine: "hips",
  chest: "spine",
  head: "chest",
  leftUpperArm: "chest",
  rightUpperArm: "chest",
};

const RESPONSE_WEIGHT: Partial<Record<(typeof CONTROLLED_BONES)[number], number>> = {
  hips: 0.45,
  spine: 0.8,
  chest: 1,
  head: 0.7,
  leftUpperArm: 0.55,
  rightUpperArm: 0.55,
};

interface Binding {
  readonly name: (typeof CONTROLLED_BONES)[number];
  readonly node: THREE.Object3D;
  readonly target: THREE.Quaternion;
}

export interface StaggerAdapterOptions {
  readonly createSimulator?: (skeleton: SkeletonDefinition) => BodyResponseSimulator;
  readonly teleportDistance?: number;
}

/** world-space の producer event を adapter の model-space 契約へ変換する。 */
export function worldToModelForceEvent(event: ForceEvent, modelRoot: THREE.Object3D): ForceEvent {
  modelRoot.updateWorldMatrix(true, false);
  const inverse = new THREE.Matrix4().copy(modelRoot.matrixWorld).invert();
  const direction = new THREE.Vector3(event.direction.x, event.direction.y, event.direction.z)
    .transformDirection(inverse)
    .normalize();
  const point = event.point
    ? new THREE.Vector3(event.point.x, event.point.y, event.point.z).applyMatrix4(inverse)
    : undefined;
  return {
    ...event,
    direction: { x: direction.x, y: direction.y, z: direction.z },
    point: point ? { x: point.x, y: point.y, z: point.z } : undefined,
  };
}

/** model-space の yoromeki simulator を包む薄い VRM/Three adapter。 */
export class StaggerAdapter {
  readonly #vrm: VRM;
  readonly #createSimulator: (skeleton: SkeletonDefinition) => BodyResponseSimulator;
  readonly #teleportDistance: number;
  #bindings: Binding[] = [];
  #simulator: BodyResponseSimulator;
  #hasAppliedCorrection = false;
  #enabled = true;
  #lastRootWorldPosition = new THREE.Vector3();
  #hasRootPosition = false;

  constructor(vrm: VRM, options: StaggerAdapterOptions = {}) {
    this.#vrm = vrm;
    this.#createSimulator = options.createSimulator ?? ((skeleton) => createSimulator(skeleton));
    this.#teleportDistance = options.teleportDistance ?? 0.5;
    const skeleton = this.#rebuildBindings();
    this.#simulator = this.#createSimulator(skeleton);
  }

  /** Body hook その 1: mixer が sample する前に、前 frame の加算補正を外す。 */
  restoreTargetPose(): void {
    this.#resetAfterTeleport();
    if (!this.#hasAppliedCorrection) return;
    for (const binding of this.#bindings) binding.node.quaternion.copy(binding.target);
    this.#hasAppliedCorrection = false;
  }

  /** Body hook その 2: 新 target を sample して step し、target * delta を一度だけ適用する。 */
  applyAfterAnimation(delta: number, suspended: boolean): void {
    const pose = this.#sampleTargetPose();
    if (suspended || !this.#enabled) {
      this.#simulator.reset();
      return;
    }
    const correction = this.#simulator.step(pose, delta);
    for (let index = 0; index < this.#bindings.length; index += 1) {
      const binding = this.#bindings[index];
      const rotation = correction.rotationDeltas[index];
      if (!rotation) continue;
      binding.node.quaternion
        .copy(binding.target)
        .multiply(new THREE.Quaternion(rotation.x, rotation.y, rotation.z, rotation.w))
        .normalize();
    }
    this.#hasAppliedCorrection = this.#bindings.length > 0;
  }

  injectForce(event: ForceEvent): void {
    this.#simulator.applyImpulse(event);
  }

  injectWorldForce(event: ForceEvent): void {
    this.injectForce(worldToModelForceEvent(event, this.#vrm.scene));
  }

  setParams(params: Partial<BodyResponseParams>): void {
    this.#simulator.setParams(params);
  }

  setEnabled(enabled: boolean): void {
    if (this.#enabled === enabled) return;
    this.#enabled = enabled;
    this.#simulator.reset();
  }

  /** 応答 state を破棄し、normalized humanoid の mapping を作り直す。 */
  reset(): void {
    this.restoreTargetPose();
    this.#simulator.reset();
    const skeleton = this.#rebuildBindings();
    this.#simulator = this.#createSimulator(skeleton);
    this.#hasAppliedCorrection = false;
  }

  #sampleTargetPose(): Pose {
    return {
      rotations: this.#bindings.map((binding) => {
        binding.target.copy(binding.node.quaternion);
        return {
          x: binding.target.x,
          y: binding.target.y,
          z: binding.target.z,
          w: binding.target.w,
        };
      }),
    };
  }

  #rebuildBindings(): SkeletonDefinition {
    this.#vrm.scene.updateWorldMatrix(true, true);
    const bindings: Binding[] = [];
    const indices = new Map<(typeof CONTROLLED_BONES)[number], number>();
    for (const name of CONTROLLED_BONES) {
      const node = this.#vrm.humanoid?.getNormalizedBoneNode(name);
      if (!node) continue;
      indices.set(name, bindings.length);
      bindings.push({ name, node, target: node.quaternion.clone() });
    }
    this.#bindings = bindings;
    return {
      joints: bindings.map((binding) => {
        let parentName = PARENT_BONE[binding.name];
        while (parentName && !indices.has(parentName)) parentName = PARENT_BONE[parentName];
        const worldPosition = binding.node.getWorldPosition(new THREE.Vector3());
        const parentBinding = parentName ? bindings[indices.get(parentName) ?? -1] : undefined;
        const restPosition = parentBinding
          ? parentBinding.node.worldToLocal(worldPosition.clone())
          : this.#vrm.scene.worldToLocal(worldPosition.clone());
        return {
          id: binding.name,
          parentIndex: parentName ? (indices.get(parentName) ?? -1) : -1,
          restPosition: {
            x: restPosition.x,
            y: restPosition.y,
            z: restPosition.z,
          },
          restRotation: {
            x: binding.node.quaternion.x,
            y: binding.node.quaternion.y,
            z: binding.node.quaternion.z,
            w: binding.node.quaternion.w,
          },
          responseWeight: RESPONSE_WEIGHT[binding.name],
        };
      }),
    };
  }

  #resetAfterTeleport(): void {
    this.#vrm.scene.updateWorldMatrix(true, false);
    const current = new THREE.Vector3().setFromMatrixPosition(this.#vrm.scene.matrixWorld);
    if (
      this.#hasRootPosition &&
      current.distanceTo(this.#lastRootWorldPosition) > this.#teleportDistance
    ) {
      if (this.#hasAppliedCorrection) {
        for (const binding of this.#bindings) binding.node.quaternion.copy(binding.target);
      }
      this.#simulator.reset();
      const skeleton = this.#rebuildBindings();
      this.#simulator = this.#createSimulator(skeleton);
      this.#hasAppliedCorrection = false;
    }
    this.#lastRootWorldPosition.copy(current);
    this.#hasRootPosition = true;
  }
}
