import { useFrame } from "@react-three/fiber";
import { button, folder, useControls } from "leva";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { type BodyResponseParams, TENTATIVE_RESPONSE_DEFAULTS } from "yoromeki";
import {
  type Capsule,
  capsuleCapsuleContact,
  contactToForceEvent,
  type Sphere,
  sphereCapsuleContact,
  sweptCapsuleCapsuleContact,
  sweptSphereCapsuleContact,
} from "yoromeki/collision";
import { getThreeRuntime } from "../../runtime/three-runtime";
import type { RuntimeLevaStore } from "../../runtime/three-runtime/runtime-leva-store";

const GRAVITY = -9.81;
const SPHERE_RADIUS = 0.11;
const CAPSULE_RADIUS = 0.08;
const CAPSULE_HALF_AXIS = 0.18;

type DropKind = "sphere" | "capsule";

interface Drop {
  readonly id: number;
  readonly kind: DropKind;
  readonly position: THREE.Vector3;
  readonly previousPosition: THREE.Vector3;
  readonly velocity: THREE.Vector3;
}

export interface StaggerDemoProps {
  readonly store?: RuntimeLevaStore;
}

export function StaggerDemo({ store }: StaggerDemoProps) {
  const runtime = getThreeRuntime();
  const [drops, setDrops] = useState<Drop[]>([]);
  const dropsRef = useRef(drops);
  const nextId = useRef(1);
  const spawnSphere = useRef<() => void>(() => undefined);
  const spawnCapsule = useRef<() => void>(() => undefined);

  const [controls] = useControls(
    () => ({
      yoromeki: folder({
        enabled: { value: true, label: "enabled" },
        "Sphere を落とす": button(() => spawnSphere.current()),
        "Capsule を落とす": button(() => spawnCapsule.current()),
        gain: { value: TENTATIVE_RESPONSE_DEFAULTS.gain, min: 0, max: 5, step: 0.05 },
        stiffness: {
          value: TENTATIVE_RESPONSE_DEFAULTS.stiffness,
          min: 0,
          max: 80,
          step: 0.5,
        },
        damping: {
          value: TENTATIVE_RESPONSE_DEFAULTS.damping,
          min: 0,
          max: 30,
          step: 0.25,
        },
        propagation: {
          value: TENTATIVE_RESPONSE_DEFAULTS.propagation,
          min: 0,
          max: 1,
          step: 0.01,
        },
        recovery: {
          value: TENTATIVE_RESPONSE_DEFAULTS.recoveryTime,
          min: 0.1,
          max: 5,
          step: 0.05,
        },
        maxAngle: {
          value: THREE.MathUtils.radToDeg(TENTATIVE_RESPONSE_DEFAULTS.defaultMaxAngleRad),
          min: 0,
          max: 45,
          step: 0.5,
          label: "max angle (deg)",
        },
      }),
    }),
    { store },
    [],
  );

  const params: Partial<BodyResponseParams> = {
    gain: controls.gain,
    stiffness: controls.stiffness,
    damping: controls.damping,
    propagation: controls.propagation,
    recoveryTime: controls.recovery,
    defaultMaxAngleRad: THREE.MathUtils.degToRad(controls.maxAngle),
  };
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    dropsRef.current = drops;
  }, [drops]);

  const spawn = useCallback(
    (kind: DropKind) => {
      const head = getWorldBonePosition(runtime.getVrm(), "head") ?? new THREE.Vector3(0, 1.6, 0);
      const position = head.add(new THREE.Vector3(kind === "sphere" ? -0.08 : 0.1, 1.1, 0));
      const drop: Drop = {
        id: nextId.current++,
        kind,
        position,
        previousPosition: position.clone(),
        velocity: new THREE.Vector3(0, 0, 0),
      };
      setDrops((current) => [...current, drop]);
    },
    [runtime],
  );
  spawnSphere.current = () => spawn("sphere");
  spawnCapsule.current = () => spawn("capsule");

  useFrame((_, delta) => {
    const body = runtime.getBody();
    body?.setStaggerParams(paramsRef.current);
    body?.setStaggerEnabled(controls.enabled);
    if (!controls.enabled || !body || dropsRef.current.length === 0) return;

    const vrm = runtime.getVrm();
    const bodyCapsules = getBodyCapsules(vrm);
    if (bodyCapsules.length === 0) return;
    const removed = new Set<number>();
    const dt = Math.min(Math.max(delta, 0), 1 / 20);
    for (const drop of dropsRef.current) {
      drop.previousPosition.copy(drop.position);
      drop.velocity.y += GRAVITY * dt;
      drop.position.addScaledVector(drop.velocity, dt);
      const contact = findContact(drop, bodyCapsules);
      if (contact) {
        body.injectWorldStaggerForce(contactToForceEvent(contact, {}, "demo"));
        removed.add(drop.id);
      } else if (drop.position.y < -1) {
        removed.add(drop.id);
      }
    }
    if (removed.size > 0) setDrops((current) => current.filter((drop) => !removed.has(drop.id)));
  });

  return (
    <>
      {drops.map((drop) =>
        drop.kind === "sphere" ? (
          <mesh key={drop.id} position={drop.position}>
            <sphereGeometry args={[SPHERE_RADIUS, 20, 14]} />
            <meshStandardMaterial color="#f5a45d" roughness={0.55} />
          </mesh>
        ) : (
          <group key={drop.id} position={drop.position}>
            <mesh>
              <capsuleGeometry args={[CAPSULE_RADIUS, CAPSULE_HALF_AXIS * 2, 8, 16]} />
              <meshStandardMaterial color="#66c7db" roughness={0.5} />
            </mesh>
          </group>
        ),
      )}
    </>
  );
}

function getWorldBonePosition(
  vrm: ReturnType<ReturnType<typeof getThreeRuntime>["getVrm"]> | null,
  name: "hips" | "chest" | "head",
): THREE.Vector3 | null {
  const node = vrm?.humanoid?.getNormalizedBoneNode(name);
  if (!node) return null;
  return node.getWorldPosition(new THREE.Vector3());
}

function getBodyCapsules(vrm: ReturnType<ReturnType<typeof getThreeRuntime>["getVrm"]>): Capsule[] {
  const hips = getWorldBonePosition(vrm, "hips");
  const chest = getWorldBonePosition(vrm, "chest");
  const head = getWorldBonePosition(vrm, "head");
  const capsules: Capsule[] = [];
  if (hips && chest) capsules.push({ start: hips, end: chest, radius: 0.17 });
  if (head) capsules.push({ start: head, end: head, radius: 0.14 });
  return capsules;
}

function findContact(drop: Drop, bodyCapsules: ReadonlyArray<Capsule>) {
  const velocity = {
    x: drop.velocity.x,
    y: drop.velocity.y,
    z: drop.velocity.z,
  };
  for (const bodyCapsule of bodyCapsules) {
    if (drop.kind === "sphere") {
      const previous: Sphere = { center: drop.previousPosition, radius: SPHERE_RADIUS };
      const current: Sphere = { center: drop.position, radius: SPHERE_RADIUS };
      const contact =
        sweptSphereCapsuleContact(previous, current, bodyCapsule, bodyCapsule) ??
        sphereCapsuleContact(current, bodyCapsule, velocity);
      if (contact) return { ...contact, relativeVelocity: velocity };
    } else {
      const previous = dropCapsule(drop.previousPosition);
      const current = dropCapsule(drop.position);
      const contact =
        sweptCapsuleCapsuleContact(previous, current, bodyCapsule, bodyCapsule) ??
        capsuleCapsuleContact(current, bodyCapsule, velocity);
      if (contact) return { ...contact, relativeVelocity: velocity };
    }
  }
  return undefined;
}

function dropCapsule(position: THREE.Vector3): Capsule {
  return {
    start: { x: position.x, y: position.y - CAPSULE_HALF_AXIS, z: position.z },
    end: { x: position.x, y: position.y + CAPSULE_HALF_AXIS, z: position.z },
    radius: CAPSULE_RADIUS,
  };
}
