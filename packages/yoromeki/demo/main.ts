import * as THREE from "three";
import { createSimulator, type Pose, type Quat, type SkeletonDefinition } from "../src";
import {
  type Capsule,
  type Contact,
  capsuleCapsuleContact,
  contactToForceEvent,
  type Sphere,
  sphereCapsuleContact,
  sweptCapsuleCapsuleContact,
  sweptSphereCapsuleContact,
} from "../src/collision";
import "./style.css";

const IDENTITY: Quat = { x: 0, y: 0, z: 0, w: 1 };
const SKELETON: SkeletonDefinition = {
  joints: [
    { id: "hips", parentIndex: -1, restPosition: { x: 0, y: 0.85, z: 0 }, restRotation: IDENTITY },
    { id: "spine", parentIndex: 0, restPosition: { x: 0, y: 0.38, z: 0 }, restRotation: IDENTITY },
    { id: "chest", parentIndex: 1, restPosition: { x: 0, y: 0.4, z: 0 }, restRotation: IDENTITY },
    { id: "head", parentIndex: 2, restPosition: { x: 0, y: 0.48, z: 0 }, restRotation: IDENTITY },
    {
      id: "leftUpperArm",
      parentIndex: 2,
      restPosition: { x: 0.36, y: 0.22, z: 0 },
      restRotation: IDENTITY,
      responseWeight: 0.75,
    },
    {
      id: "rightUpperArm",
      parentIndex: 2,
      restPosition: { x: -0.36, y: 0.22, z: 0 },
      restRotation: IDENTITY,
      responseWeight: 0.75,
    },
  ],
};

interface FallingObject {
  kind: "sphere" | "capsule";
  mesh: THREE.Mesh;
  previousY: number;
  velocityY: number;
  collided: boolean;
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x11151d);
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.1, 100);
camera.position.set(3.6, 2.8, 5.2);
camera.lookAt(0, 1.45, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
document.body.append(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xbad4ff, 0x242938, 2.4));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);

const floor = new THREE.Mesh(
  new THREE.CircleGeometry(3, 64),
  new THREE.MeshStandardMaterial({ color: 0x273140, roughness: 0.9 }),
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);
scene.add(new THREE.GridHelper(6, 12, 0x4e6078, 0x344153));

const jointNodes: THREE.Object3D[] = [];
for (const joint of SKELETON.joints) {
  const node = new THREE.Object3D();
  node.position.set(joint.restPosition.x, joint.restPosition.y, joint.restPosition.z);
  if (joint.parentIndex >= 0) jointNodes[joint.parentIndex]?.add(node);
  else scene.add(node);
  const marker = new THREE.Mesh(
    new THREE.SphereGeometry(joint.id === "head" ? 0.18 : 0.09, 20, 12),
    new THREE.MeshStandardMaterial({ color: joint.id === "head" ? 0xffd6a0 : 0x77bdfb }),
  );
  node.add(marker);
  jointNodes.push(node);
}

const boneMaterial = new THREE.MeshStandardMaterial({ color: 0x8fd3ff });
const boneMeshes = SKELETON.joints.map((joint) => {
  if (joint.parentIndex < 0) return undefined;
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.06, 1, 10), boneMaterial);
  scene.add(mesh);
  return mesh;
});

const simulator = createSimulator(SKELETON, { gain: 0.32, defaultMaxAngleRad: 0.38 });
const fallingObjects: FallingObject[] = [];
const worldPositions = jointNodes.map(() => new THREE.Vector3());
let previousBody: Capsule | undefined;
let previousHead: Capsule | undefined;
let alternateKind: FallingObject["kind"] = "sphere";

function updateBoneMeshes(): void {
  scene.updateMatrixWorld(true);
  for (let index = 0; index < jointNodes.length; index += 1) {
    jointNodes[index].getWorldPosition(worldPositions[index]);
    const parentIndex = SKELETON.joints[index].parentIndex;
    const mesh = boneMeshes[index];
    if (parentIndex < 0 || !mesh) continue;
    const start = worldPositions[parentIndex];
    const end = worldPositions[index];
    mesh.position.copy(start).add(end).multiplyScalar(0.5);
    mesh.scale.set(1, start.distanceTo(end), 1);
    mesh.quaternion.setFromUnitVectors(
      new THREE.Vector3(0, 1, 0),
      end.clone().sub(start).normalize(),
    );
  }
}

function spawn(kind: FallingObject["kind"]): void {
  const material = new THREE.MeshStandardMaterial({
    color: kind === "sphere" ? 0xff6b70 : 0xffc857,
  });
  const geometry =
    kind === "sphere"
      ? new THREE.SphereGeometry(0.22, 24, 16)
      : new THREE.CapsuleGeometry(0.16, 0.6, 8, 16);
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(Math.random() < 0.5 ? -0.24 : 0.24, 4, 0);
  scene.add(mesh);
  fallingObjects.push({ kind, mesh, previousY: mesh.position.y, velocityY: -0.4, collided: false });
}

function asSphere(object: FallingObject, y: number): Sphere {
  return { center: { x: object.mesh.position.x, y, z: object.mesh.position.z }, radius: 0.22 };
}

function asCapsule(object: FallingObject, y: number): Capsule {
  return {
    start: { x: object.mesh.position.x, y: y - 0.3, z: object.mesh.position.z },
    end: { x: object.mesh.position.x, y: y + 0.3, z: object.mesh.position.z },
    radius: 0.16,
  };
}

function detectContact(object: FallingObject, body: Capsule, head: Capsule): Contact | undefined {
  if (object.kind === "sphere") {
    const previous = asSphere(object, object.previousY);
    const current = asSphere(object, object.mesh.position.y);
    return (
      (previousBody && sweptSphereCapsuleContact(previous, current, previousBody, body)) ??
      (previousHead && sweptSphereCapsuleContact(previous, current, previousHead, head)) ??
      sphereCapsuleContact(current, body) ??
      sphereCapsuleContact(current, head)
    );
  }
  const previous = asCapsule(object, object.previousY);
  const current = asCapsule(object, object.mesh.position.y);
  return (
    (previousBody && sweptCapsuleCapsuleContact(previous, current, previousBody, body)) ??
    (previousHead && sweptCapsuleCapsuleContact(previous, current, previousHead, head)) ??
    capsuleCapsuleContact(current, body) ??
    capsuleCapsuleContact(current, head)
  );
}

function targetPose(time: number): Pose {
  const breath = Math.sin(time * 1.35) * 0.035;
  return {
    rotations: SKELETON.joints.map((joint) => {
      if (joint.id === "spine") return { x: breath, y: 0, z: 0, w: Math.sqrt(1 - breath * breath) };
      if (joint.id === "leftUpperArm" || joint.id === "rightUpperArm") {
        const sign = joint.id === "leftUpperArm" ? 1 : -1;
        return { x: 0, y: 0, z: sign * breath * 0.6, w: Math.sqrt(1 - breath * breath * 0.36) };
      }
      return IDENTITY;
    }),
  };
}

const clock = new THREE.Clock();
function animate(): void {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 1 / 30);
  const time = clock.elapsedTime;
  const target = targetPose(time);
  const correction = simulator.step(target, dt);
  for (let index = 0; index < jointNodes.length; index += 1) {
    const targetRotation = target.rotations[index];
    const delta = correction.rotationDeltas[index];
    jointNodes[index].quaternion
      .set(targetRotation.x, targetRotation.y, targetRotation.z, targetRotation.w)
      .multiply(new THREE.Quaternion(delta.x, delta.y, delta.z, delta.w));
  }
  updateBoneMeshes();

  const body: Capsule = {
    start: { ...worldPositions[0] },
    end: { ...worldPositions[2] },
    radius: 0.24,
  };
  const head: Capsule = {
    start: { ...worldPositions[3] },
    end: { ...worldPositions[3] },
    radius: 0.2,
  };
  for (let index = fallingObjects.length - 1; index >= 0; index -= 1) {
    const object = fallingObjects[index];
    object.previousY = object.mesh.position.y;
    object.velocityY -= 9.8 * dt;
    object.mesh.position.y += object.velocityY * dt;
    if (!object.collided) {
      const contact = detectContact(object, body, head);
      if (contact) {
        simulator.applyImpulse(
          contactToForceEvent(
            { ...contact, relativeVelocity: { x: 0, y: object.velocityY, z: 0 } },
            { overall: 2.4 },
            `demo-${object.kind}`,
          ),
        );
        object.collided = true;
      }
    }
    if (object.mesh.position.y < -0.6) {
      scene.remove(object.mesh);
      object.mesh.geometry.dispose();
      (object.mesh.material as THREE.Material).dispose();
      fallingObjects.splice(index, 1);
    }
  }
  previousBody = body;
  previousHead = head;
  renderer.render(scene, camera);
}

window.addEventListener("keydown", (event) => {
  if (event.code === "KeyS") spawn("sphere");
  if (event.code === "KeyC") spawn("capsule");
  if (event.code === "Space") {
    event.preventDefault();
    spawn(alternateKind);
    alternateKind = alternateKind === "sphere" ? "capsule" : "sphere";
  }
});
renderer.domElement.addEventListener("pointerdown", () => {
  spawn(alternateKind);
  alternateKind = alternateKind === "sphere" ? "capsule" : "sphere";
});
window.addEventListener("resize", () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

updateBoneMeshes();
animate();
