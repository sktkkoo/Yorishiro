import { type VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";

export interface RecordedAxialStrength {
  readonly torso: number;
  readonly head: number;
}

const AXIAL_ROLES = new Map<VRMHumanBoneName, keyof RecordedAxialStrength>([
  ["spine", "torso"],
  ["chest", "torso"],
  ["upperChest", "torso"],
  ["neck", "head"],
  ["head", "head"],
]);

interface Joint {
  readonly parent: number;
  readonly role?: keyof RecordedAxialStrength;
  readonly track?: THREE.KeyframeTrack;
  readonly interpolant?: THREE.Interpolant;
  readonly rest: THREE.Quaternion;
  readonly reference: THREE.Quaternion;
  readonly source: THREE.Quaternion;
  readonly desired: THREE.Quaternion;
  readonly output: Float32Array;
}

/** Source-clock axial attenuation before Three's normal action blending.
 * The reference is one fixed authored frame in the clip's hips-parent space.
 * Arms, fingers, hips and legs keep their original local tracks. Compensating
 * inherited hips rotation at the spine reduces head/torso rotation without
 * changing the pelvis trajectory or the supporting pose.
 */
export class RecordedAxialMotion {
  private readonly joints: Joint[] = [];
  private readonly channels = new Map<string, Joint>();
  private readonly local = new THREE.Quaternion();
  private readonly inverseParent = new THREE.Quaternion();
  private lastTime = Number.NaN;
  private lastTorso = Number.NaN;
  private lastHead = Number.NaN;

  constructor(vrm: VRM, clip: THREE.AnimationClip, referenceTimeSec = 0) {
    if (
      !Number.isFinite(referenceTimeSec) ||
      referenceTimeSec < 0 ||
      referenceTimeSec > clip.duration
    )
      throw new Error("Invalid recorded axial reference time");
    const humanoid = vrm.humanoid;
    const hips = humanoid.getNormalizedBoneNode("hips");
    if (!hips) return;
    const tracks = new Map(clip.tracks.map((track) => [track.name, track]));
    const names = new Map<THREE.Object3D, VRMHumanBoneName>();
    for (const name of Object.values(VRMHumanBoneName)) {
      const bone = humanoid.getNormalizedBoneNode(name);
      if (bone) names.set(bone, name);
    }
    const indices = new Map<THREE.Object3D, number>();
    const add = (node: THREE.Object3D): number => {
      const existing = indices.get(node);
      if (existing !== undefined) return existing;
      if (indices.size >= 16 || (node !== hips && !node.parent))
        throw new Error("Unsupported recorded axial hierarchy");
      const parent = node === hips ? -1 : add(node.parent as THREE.Object3D);
      const name = names.get(node);
      const track = tracks.get(`${node.name}.quaternion`) ?? tracks.get(`${node.uuid}.quaternion`);
      const role = track && name ? AXIAL_ROLES.get(name) : undefined;
      const rotation = name ? humanoid.normalizedRestPose[name]?.rotation : undefined;
      const joint: Joint = {
        parent,
        role,
        track,
        interpolant: track ? interpolant(track) : undefined,
        rest: rotation ? new THREE.Quaternion().fromArray(rotation) : node.quaternion.clone(),
        reference: new THREE.Quaternion(),
        source: new THREE.Quaternion(),
        desired: new THREE.Quaternion(),
        output: new Float32Array(4),
      };
      const index = this.joints.length;
      this.joints.push(joint);
      indices.set(node, index);
      if (role && track) this.channels.set(track.name, joint);
      return index;
    };
    for (const name of AXIAL_ROLES.keys()) {
      const node = humanoid.getNormalizedBoneNode(name);
      if (node) add(node);
    }
    this.sampleSource(referenceTimeSec);
    for (const joint of this.joints) joint.reference.copy(joint.source);
  }

  /** Only five axial track wrappers change; all other immutable track objects survive. */
  tracks(
    source: readonly THREE.KeyframeTrack[],
    strength: () => RecordedAxialStrength,
  ): THREE.KeyframeTrack[] {
    return source.map((track) => {
      if (!this.channels.has(track.name)) return track;
      const clone = track.clone() as THREE.KeyframeTrack & {
        createInterpolant(result?: Float32Array | null): THREE.Interpolant;
      };
      clone.createInterpolant = (result) => {
        const sampler = new THREE.QuaternionLinearInterpolant(
          track.times,
          track.values,
          4,
          result ?? new Float32Array(4),
        );
        const evaluateSource = sampler.evaluate.bind(sampler);
        sampler.evaluate = (time) => {
          const gain = strength();
          // Preserve Three's exact interpolation and buffer precision at full strength.
          if (gain.torso === 1 && gain.head === 1) return evaluateSource(time);
          const values = this.sample(track.name, time, gain);
          // AnimationAction replaces resultBuffer with the PropertyMixer buffer.
          // Write that live destination, not a captured constructor-time array.
          if (values)
            for (let axis = 0; axis < 4; axis++) sampler.resultBuffer[axis] = values[axis];
          return sampler.resultBuffer;
        };
        return sampler;
      };
      return clone;
    });
  }

  sample(name: string, time: number, strength: RecordedAxialStrength): Float32Array | undefined {
    const channel = this.channels.get(name);
    if (!channel) return undefined;
    if (
      time !== this.lastTime ||
      strength.torso !== this.lastTorso ||
      strength.head !== this.lastHead
    ) {
      this.sampleSource(time);
      for (const joint of this.joints) {
        if (joint.role) {
          const gain = strength[joint.role];
          joint.desired.copy(joint.reference).slerp(joint.source, gain);
          if (strength.torso === 1 && strength.head === 1) {
            // Full source richness is an exact pass-through of the sampled local keys.
            if (joint.interpolant) joint.output.set(joint.interpolant.resultBuffer);
          } else {
            if (joint.parent < 0) this.local.copy(joint.desired);
            else
              this.local.multiplyQuaternions(
                this.inverseParent.copy(this.joints[joint.parent].desired).invert(),
                joint.desired,
              );
            this.local.normalize().toArray(joint.output);
          }
        } else {
          if (joint.interpolant) this.local.fromArray(joint.interpolant.resultBuffer);
          else this.local.copy(joint.rest);
          if (joint.parent < 0) joint.desired.copy(this.local);
          else joint.desired.multiplyQuaternions(this.joints[joint.parent].desired, this.local);
        }
      }
      this.lastTime = time;
      this.lastTorso = strength.torso;
      this.lastHead = strength.head;
    }
    return channel.output;
  }

  private sampleSource(time: number): void {
    for (const joint of this.joints) {
      if (joint.interpolant) this.local.fromArray(joint.interpolant.evaluate(time));
      else this.local.copy(joint.rest);
      if (joint.parent < 0) joint.source.copy(this.local);
      else joint.source.multiplyQuaternions(this.joints[joint.parent].source, this.local);
      joint.source.normalize();
    }
  }
}

function interpolant(track: THREE.KeyframeTrack): THREE.Interpolant {
  return (
    track as THREE.KeyframeTrack & { createInterpolant(result: Float32Array): THREE.Interpolant }
  ).createInterpolant(new Float32Array(4));
}
