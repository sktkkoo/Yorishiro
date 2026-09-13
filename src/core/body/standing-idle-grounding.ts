import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";

const LOWER_BONES: VRMHumanBoneName[] = [
  "hips",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
];
const CONTACT_BONES: VRMHumanBoneName[] = ["leftFoot", "leftToes", "rightFoot", "rightToes"];
const SAMPLE_HZ = 60;
const MAX_DURATION_SEC = 20;
const MAX_CORRECTION_METERS = 0.03;
const MAX_CONTACT_RESIDUAL_METERS = 0.01;

/**
 * Transfer only the reviewed Idle recording's small, correlated rotation
 * changes onto the target's standing rest pose. Its absolute source stance is
 * different enough to move Yori's feet 10–16 cm during a fade from rest. This
 * reference-relative calibration keeps t=0 at rest without discarding any
 * recorded hip, leg, ankle, or toe rotation changes.
 */
export function calibrateStandingIdleClip(
  clip: THREE.AnimationClip,
  vrm: VRM,
): THREE.AnimationClip {
  if (
    !Number.isFinite(clip.duration) ||
    clip.duration <= 0 ||
    clip.duration > MAX_DURATION_SEC ||
    clip.tracks.length === 0 ||
    clip.tracks.length > LOWER_BONES.length
  ) {
    return clip;
  }
  try {
    const references = new Map<string, THREE.Quaternion>();
    for (const name of LOWER_BONES) {
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      const rest = vrm.humanoid.normalizedRestPose[name]?.rotation;
      if (!bone || !rest?.every(Number.isFinite)) return clip;
      const reference = new THREE.Quaternion().fromArray(rest);
      if (reference.lengthSq() < 1e-10) return clip;
      references.set(`${bone.uuid}.quaternion`, reference.normalize());
      if (bone.name) references.set(`${bone.name}.quaternion`, reference);
    }
    const tracks: THREE.KeyframeTrack[] = [];
    for (const track of clip.tracks) {
      const rest = references.get(track.name);
      if (
        !rest ||
        track.ValueTypeName !== "quaternion" ||
        track.getValueSize() !== 4 ||
        track.times.length < 2 ||
        track.times.length > 10_000 ||
        !track.validate() ||
        !track.times.every(Number.isFinite) ||
        !track.values.every(Number.isFinite)
      ) {
        return clip;
      }
      const first = new THREE.Quaternion().fromArray(track.values);
      if (first.lengthSq() < 1e-10) return clip;
      first.normalize();
      const transform = rest.clone().multiply(first.clone().invert());
      const rotation = new THREE.Quaternion();
      const values = new Float32Array(track.values.length);
      for (let index = 0; index < values.length; index += 4) {
        rotation.fromArray(track.values, index);
        if (rotation.lengthSq() < 1e-10) return clip;
        rotation.normalize();
        // This preparation is for a quiet planted-foot recording, never for
        // locomotion or an arbitrary performance with large stance changes.
        if (rotation.angleTo(first) > 0.1) return clip;
        rotation.premultiply(transform).normalize().toArray(values, index);
      }
      const calibrated = track.clone();
      calibrated.values = values;
      tracks.push(calibrated);
    }
    return new THREE.AnimationClip(`${clip.name}:standing`, clip.duration, tracks, clip.blendMode);
  } catch {
    return clip;
  }
}

/**
 * Recover the small shared foot displacement lost when root translation was
 * stripped from the reviewed, two-foot standing Idle recording. Call only on
 * its lower-body clip, after loop conditioning. This does not infer contacts,
 * replace recorded rotations, perform IK, or lock feet during a stance change.
 *
 * The curve is measured on a private normalized rest skeleton, in the hips
 * parent's coordinate system. Consequently avatar placement/rotation/scale and
 * the current live pose cannot leak into the cached clip. The already-retargeted
 * quaternion tracks retain the SDK's VRM 0/1 conversion unchanged.
 *
 * At full weight, the mean of the two ankles and toes stays at its initial
 * recorded location. Partial mixer weights approximate this correction; fading
 * from a different leg stance still moves the feet. Invalid or unsuitable input
 * returns the original clip without touching the avatar.
 */
export function groundStandingIdleClip(clip: THREE.AnimationClip, vrm: VRM): THREE.AnimationClip {
  if (
    !Number.isFinite(clip.duration) ||
    clip.duration <= 0 ||
    clip.duration > MAX_DURATION_SEC ||
    clip.tracks.length === 0 ||
    clip.tracks.length > LOWER_BONES.length
  ) {
    return clip;
  }

  try {
    const humanoid = vrm.humanoid;
    const liveRoot = humanoid.normalizedHumanBonesRoot;
    const copies = new Map<THREE.Object3D, THREE.Object3D>();
    // Only clone transforms on the nine lower-body paths, never meshes, raw
    // bones, userData, or the avatar scene (Object3D.clone can copy those).
    const copyPath = (live: THREE.Object3D): THREE.Object3D => {
      const existing = copies.get(live);
      if (existing) return existing;
      if (copies.size >= 32) throw new Error("Unexpected normalized hierarchy");
      const copy = new THREE.Object3D();
      copies.set(live, copy);
      copy.position.copy(live.position);
      copy.quaternion.copy(live.quaternion);
      copy.scale.copy(live.scale);
      if (live !== liveRoot) {
        if (!live.parent) throw new Error("Detached normalized bone");
        copyPath(live.parent).add(copy);
      }
      return copy;
    };
    const bones = new Map<VRMHumanBoneName, THREE.Object3D>();
    const trackNodes = new Map<string, THREE.Object3D>();
    for (const name of LOWER_BONES) {
      const live = humanoid.getNormalizedBoneNode(name);
      const rest = humanoid.normalizedRestPose[name];
      if (!live || !rest?.position || !rest.rotation) return clip;
      const copy = copyPath(live);
      copy.position.fromArray(rest.position);
      copy.quaternion.fromArray(rest.rotation);
      bones.set(name, copy);
      trackNodes.set(`${live.uuid}.quaternion`, copy);
      if (live.name) trackNodes.set(`${live.name}.quaternion`, copy);
    }
    const root = copies.get(liveRoot);
    const hips = bones.get("hips");
    const liveHips = humanoid.getNormalizedBoneNode("hips");
    if (!root || !hips?.parent || !liveHips) return clip;
    for (const copy of copies.values()) {
      if (
        ![...copy.position, ...copy.quaternion, ...copy.scale].every(Number.isFinite) ||
        copy.quaternion.lengthSq() < 1e-10 ||
        Math.min(...copy.scale.toArray().map(Math.abs)) < 1e-8
      ) {
        return clip;
      }
    }
    const seenNodes = new Set<THREE.Object3D>();
    const channels = [];
    for (const track of clip.tracks) {
      const node = trackNodes.get(track.name);
      if (
        !node ||
        seenNodes.has(node) ||
        track.getValueSize() !== 4 ||
        track.ValueTypeName !== "quaternion" ||
        track.times.length < 2 ||
        track.times.length > 10_000 ||
        !track.validate() ||
        !track.times.every(Number.isFinite) ||
        !track.values.every(Number.isFinite)
      ) {
        return clip;
      }
      for (let index = 0; index < track.values.length; index += 4) {
        if (Math.hypot(...track.values.slice(index, index + 4)) < 1e-8) return clip;
      }
      seenNodes.add(node);
      const interpolant = (
        track as THREE.KeyframeTrack & {
          createInterpolant: (result: Float32Array) => THREE.Interpolant;
        }
      ).createInterpolant(new Float32Array(4));
      channels.push({ node, interpolant });
    }
    if (!seenNodes.has(hips)) return clip;

    const feet = CONTACT_BONES.map((name) => bones.get(name) as THREE.Object3D);
    const restHips = hips.position.clone();
    const steps = Math.ceil(clip.duration * SAMPLE_HZ);
    const times = new Float32Array(steps + 1);
    const positions = new Float32Array((steps + 1) * 3);
    const anchor = feet.map(() => new THREE.Vector3());
    const current = feet.map(() => new THREE.Vector3());
    const correction = new THREE.Vector3();
    const parentInverse = new THREE.Matrix4();
    const residual = new THREE.Vector3();
    for (let frame = 0; frame <= steps; frame++) {
      const time = (frame * clip.duration) / steps;
      for (const channel of channels) {
        channel.node.quaternion.fromArray(channel.interpolant.evaluate(time)).normalize();
      }
      root.updateMatrixWorld(true);
      parentInverse.copy(hips.parent.matrixWorld).invert();
      correction.set(0, 0, 0);
      for (let index = 0; index < feet.length; index++) {
        current[index].setFromMatrixPosition(feet[index].matrixWorld).applyMatrix4(parentInverse);
        if (frame === 0) anchor[index].copy(current[index]);
        correction.add(anchor[index]).sub(current[index]);
      }
      correction.multiplyScalar(1 / feet.length);
      if (!correction.toArray().every(Number.isFinite)) return clip;
      if (correction.length() > MAX_CORRECTION_METERS) return clip;
      for (let index = 0; index < feet.length; index++) {
        residual.copy(current[index]).add(correction).sub(anchor[index]);
        if (residual.length() > MAX_CONTACT_RESIDUAL_METERS) return clip;
      }
      times[frame] = time;
      correction.add(restHips).toArray(positions, frame * 3);
    }
    // Reviewed Idle is periodic. Refuse an open translation seam instead of
    // forcing an arbitrary recording's displaced stance back to its beginning.
    const last = new THREE.Vector3().fromArray(positions, steps * 3);
    if (last.distanceTo(restHips) > 0.001) return clip;
    positions.set(positions.subarray(0, 3), steps * 3);
    return new THREE.AnimationClip(
      `${clip.name}:grounded`,
      clip.duration,
      [
        ...clip.tracks,
        new THREE.VectorKeyframeTrack(
          `${liveHips.name || liveHips.uuid}.position`,
          times,
          positions,
        ),
      ],
      clip.blendMode,
    );
  } catch {
    return clip;
  }
}
