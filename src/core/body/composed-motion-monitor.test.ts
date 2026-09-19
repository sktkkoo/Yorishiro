import type { VRM, VRMHumanBoneName } from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { ComposedMotionMonitor, createComposedMotionContext } from "./composed-motion-monitor";

function fixture(options?: ConstructorParameters<typeof ComposedMotionMonitor>[1]) {
  const scene = new THREE.Object3D();
  const hips = new THREE.Object3D();
  const head = new THREE.Object3D();
  const hand = new THREE.Object3D();
  hips.position.y = 1;
  head.position.y = 0.5;
  hand.position.x = 0.5;
  scene.add(hips);
  hips.add(head);
  head.add(hand);
  const bones: Partial<Record<VRMHumanBoneName, THREE.Object3D>> = { hips, head, leftHand: hand };
  const vrm = {
    scene,
    humanoid: { getNormalizedBoneNode: (name: VRMHumanBoneName) => bones[name] ?? null },
  } as VRM;
  const monitor = new ComposedMotionMonitor(vrm, options);
  const context = createComposedMotionContext();
  return { scene, hips, head, hand, monitor, context };
}

describe("final composed motion diagnostics", () => {
  it.each([
    30, 60, 120,
  ])("accepts smooth fast motion and quaternion sign changes at %s Hz", (hz) => {
    const { scene, hips, head, monitor, context } = fixture();
    for (let frame = 0; frame < hz * 2; frame++) {
      hips.position.x = frame / hz;
      head.rotation.z = (frame / hz) * 10;
      if (frame % 2)
        head.quaternion.set(
          -head.quaternion.x,
          -head.quaternion.y,
          -head.quaternion.z,
          -head.quaternion.w,
        );
      // Moving/scaling the avatar in the scene must not create skeletal faults.
      scene.position.x = frame % 2 ? 10 : -10;
      scene.scale.setScalar(frame % 2 ? 0.8 : 1.2);
      monitor.update(1 / hz, context);
    }
    expect(monitor.getSnapshot().events).toEqual([]);
  });

  it.each([
    30, 60, 120,
  ])("captures an upper pose spike and hips jump with phase provenance at %s Hz", (hz) => {
    const { hips, head, monitor, context } = fixture();
    context.recordedUnit = "standing";
    for (let frame = 0; frame < 4; frame++) {
      context.recordedPhaseSec = frame / hz;
      monitor.update(1 / hz, context);
    }
    context.performanceAnimation = "new-motion";
    context.performancePhaseSec = 0.1;
    head.rotation.z = 0.3;
    hips.position.x += 0.1;
    monitor.update(1 / hz, context);
    const snapshot = monitor.getSnapshot(true);
    expect(snapshot.poseCandidateCount).toBe(1);
    expect(snapshot.events[0]).toMatchObject({
      kind: "pose-discontinuity-candidate",
      context: { performanceAnimation: "new-motion", performancePhaseSec: 0.1 },
      previousContext: { performanceAnimation: null, recordedPhaseSec: 3 / hz },
    });
    expect(snapshot.events[0].joints.map((joint) => joint.bone)).toEqual(
      expect.arrayContaining(["head", "hips"]),
    );
    expect(snapshot.frames?.[snapshot.frames.length - 1]?.pose.length).toBe(
      snapshot.bones.length * 7,
    );
  });

  it("uses each interval's duration for uneven frame cadence", () => {
    const { head, hips, monitor, context } = fixture();
    let time = 0;
    for (let frame = 0; frame < 100; frame++) {
      const dt = [1 / 30, 1 / 60, 1 / 120][frame % 3];
      time += dt;
      head.rotation.x = time * 8;
      hips.position.z = time * 2;
      monitor.update(dt, context);
    }
    expect(monitor.getSnapshot().poseCandidateCount).toBe(0);
  });

  it("reports a frame stall separately and resets velocity on resume", () => {
    const { head, monitor, context } = fixture();
    for (let frame = 0; frame < 3; frame++) monitor.update(1 / 60, context);
    head.rotation.x = 1;
    monitor.update(0.4, context);
    monitor.update(1 / 60, context);
    monitor.update(1 / 60, context);
    expect(monitor.getSnapshot()).toMatchObject({ frameStallCount: 1, poseCandidateCount: 0 });
    expect(monitor.getSnapshot().events[0].kind).toBe("frame-stall");
  });

  it("handles initialization, zero time, explicit reset, paused intensity and invalid samples", () => {
    const { head, monitor, context } = fixture();
    head.rotation.x = 1;
    monitor.update(1 / 60, context);
    monitor.update(0, context);
    head.rotation.x = -1;
    monitor.update(1 / 60, context);
    monitor.reset();
    head.rotation.x = 1;
    monitor.update(1 / 60, context);
    context.paused = true;
    head.rotation.x = -1;
    monitor.update(1 / 60, context);
    context.paused = false;
    head.rotation.x = 1;
    monitor.update(1 / 60, context);
    head.quaternion.set(Number.NaN, 0, 0, 1);
    monitor.update(1 / 60, context);
    head.quaternion.identity();
    monitor.update(1 / 60, context);
    monitor.update(1 / 60, context);
    expect(monitor.getSnapshot()).toMatchObject({
      poseCandidateCount: 0,
      frameStallCount: 0,
      invalidSampleCount: 1,
    });
  });

  it("bounds rings and returns isolated snapshots only on export", () => {
    const { head, monitor, context } = fixture({ frameCapacity: 5, eventCapacity: 3 });
    for (let frame = 0; frame < 25; frame++) {
      head.rotation.x = frame % 2 ? 0.5 : -0.5;
      monitor.update(1 / 60, context);
    }
    const snapshot = monitor.getSnapshot(true);
    expect(snapshot.frames).toHaveLength(5);
    expect(snapshot.events).toHaveLength(3);
    expect(snapshot.frames?.map((frame) => frame.sequence)).toEqual([21, 22, 23, 24, 25]);
    snapshot.events[0].context.activity = "modified";
    snapshot.events[0].joints[0].angularPredictionErrorRad = 999;
    if (snapshot.frames) snapshot.frames[0].pose[0] = 999;
    expect(monitor.getSnapshot().events[0].context.activity).toBe("idle");
    expect(monitor.getSnapshot().events[0].joints[0].angularPredictionErrorRad).toBeCloseTo(2, 6);
    expect(monitor.getSnapshot(true).frames?.[0].pose[0]).not.toBe(999);
    expect(monitor.getSnapshot().frames).toBeUndefined();
  });

  it("never writes back to the observed skeleton", () => {
    const { head, monitor, context } = fixture();
    head.quaternion.set(0.01, 0.02, 0.03, 0.9);
    const before = head.quaternion.clone();
    monitor.update(1 / 60, context);
    expect(head.quaternion.toArray()).toEqual(before.toArray());
  });
});
