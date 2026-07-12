import { add, dot, length, lengthSquared, normalize, scale, subtract } from "../math";
import type { ForceEvent, Vec3 } from "../types";
import type { Capsule, CollisionForceGains, Contact, Sphere } from "./types";

const EPSILON = 1e-9;
const SWEEP_FRACTION = 0.25;

export const TENTATIVE_COLLISION_FORCE_GAINS: Readonly<CollisionForceGains> = {
  velocity: 1,
  penetration: 12,
  overall: 1,
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function lerp(a: Vec3, b: Vec3, time: number): Vec3 {
  return add(a, scale(subtract(b, a), time));
}

function fallbackNormal(axis: Vec3): Vec3 {
  const candidate = normalize({ x: -axis.y, y: axis.x, z: 0 });
  return candidate ?? { x: 1, y: 0, z: 0 };
}

export function closestPointOnSegment(point: Vec3, start: Vec3, end: Vec3): Vec3 {
  const segment = subtract(end, start);
  const denominator = lengthSquared(segment);
  if (denominator <= EPSILON) return { ...start };
  return add(start, scale(segment, clamp01(dot(subtract(point, start), segment) / denominator)));
}

function closestSegmentPoints(
  firstStart: Vec3,
  firstEnd: Vec3,
  secondStart: Vec3,
  secondEnd: Vec3,
): [Vec3, Vec3] {
  const firstAxis = subtract(firstEnd, firstStart);
  const secondAxis = subtract(secondEnd, secondStart);
  const offset = subtract(firstStart, secondStart);
  const firstLength = dot(firstAxis, firstAxis);
  const secondLength = dot(secondAxis, secondAxis);
  const secondProjection = dot(secondAxis, offset);
  let firstTime = 0;
  let secondTime = 0;

  if (firstLength <= EPSILON && secondLength <= EPSILON) return [firstStart, secondStart];
  if (firstLength <= EPSILON) {
    secondTime = clamp01(secondProjection / secondLength);
  } else {
    const firstProjection = dot(firstAxis, offset);
    if (secondLength <= EPSILON) {
      firstTime = clamp01(-firstProjection / firstLength);
    } else {
      const axesProjection = dot(firstAxis, secondAxis);
      const denominator = firstLength * secondLength - axesProjection * axesProjection;
      firstTime =
        denominator > EPSILON
          ? clamp01(
              (axesProjection * secondProjection - firstProjection * secondLength) / denominator,
            )
          : 0;
      secondTime = (axesProjection * firstTime + secondProjection) / secondLength;
      if (secondTime < 0) {
        secondTime = 0;
        firstTime = clamp01(-firstProjection / firstLength);
      } else if (secondTime > 1) {
        secondTime = 1;
        firstTime = clamp01((axesProjection - firstProjection) / firstLength);
      }
    }
  }
  return [
    add(firstStart, scale(firstAxis, firstTime)),
    add(secondStart, scale(secondAxis, secondTime)),
  ];
}

export function sphereCapsuleContact(
  sphere: Sphere,
  capsule: Capsule,
  relativeVelocity: Vec3 = { x: 0, y: 0, z: 0 },
): Contact | undefined {
  const onAxis = closestPointOnSegment(sphere.center, capsule.start, capsule.end);
  const separation = subtract(sphere.center, onAxis);
  const distance = length(separation);
  const radius = Math.max(0, sphere.radius) + Math.max(0, capsule.radius);
  if (!Number.isFinite(distance) || distance > radius + EPSILON) return undefined;
  const normal = normalize(separation) ?? fallbackNormal(subtract(capsule.end, capsule.start));
  return {
    point: add(onAxis, scale(normal, Math.max(0, capsule.radius))),
    normal,
    relativeVelocity,
    penetrationDepth: Math.max(0, radius - distance),
    time: 1,
  };
}

export function capsuleCapsuleContact(
  first: Capsule,
  second: Capsule,
  relativeVelocity: Vec3 = { x: 0, y: 0, z: 0 },
): Contact | undefined {
  const [onFirst, onSecond] = closestSegmentPoints(
    first.start,
    first.end,
    second.start,
    second.end,
  );
  const separation = subtract(onFirst, onSecond);
  const distance = length(separation);
  const radius = Math.max(0, first.radius) + Math.max(0, second.radius);
  if (!Number.isFinite(distance) || distance > radius + EPSILON) return undefined;
  const normal = normalize(separation) ?? fallbackNormal(subtract(second.end, second.start));
  const firstSurface = subtract(onFirst, scale(normal, Math.max(0, first.radius)));
  const secondSurface = add(onSecond, scale(normal, Math.max(0, second.radius)));
  return {
    point: scale(add(firstSurface, secondSurface), 0.5),
    normal,
    relativeVelocity,
    penetrationDepth: Math.max(0, radius - distance),
    time: 1,
  };
}

function sweepSteps(travel: number, radius: number): number {
  const interval = Math.max(radius * SWEEP_FRACTION, 1e-4);
  return Math.max(1, Math.ceil(travel / interval));
}

export function sweptSphereCapsuleContact(
  previousSphere: Sphere,
  currentSphere: Sphere,
  previousCapsule: Capsule,
  currentCapsule: Capsule,
): Contact | undefined {
  const sphereTravel = length(subtract(currentSphere.center, previousSphere.center));
  const capsuleTravel = Math.max(
    length(subtract(currentCapsule.start, previousCapsule.start)),
    length(subtract(currentCapsule.end, previousCapsule.end)),
  );
  const relativeVelocity = subtract(
    subtract(currentSphere.center, previousSphere.center),
    scale(
      add(
        subtract(currentCapsule.start, previousCapsule.start),
        subtract(currentCapsule.end, previousCapsule.end),
      ),
      0.5,
    ),
  );
  const steps = sweepSteps(
    sphereTravel + capsuleTravel,
    Math.max(0, currentSphere.radius) + Math.max(0, currentCapsule.radius),
  );
  for (let index = 0; index <= steps; index += 1) {
    const time = index / steps;
    const contact = sphereCapsuleContact(
      {
        center: lerp(previousSphere.center, currentSphere.center, time),
        radius: currentSphere.radius,
      },
      {
        start: lerp(previousCapsule.start, currentCapsule.start, time),
        end: lerp(previousCapsule.end, currentCapsule.end, time),
        radius: currentCapsule.radius,
      },
      relativeVelocity,
    );
    if (contact) return { ...contact, time };
  }
  return undefined;
}

export function sweptCapsuleCapsuleContact(
  previousFirst: Capsule,
  currentFirst: Capsule,
  previousSecond: Capsule,
  currentSecond: Capsule,
): Contact | undefined {
  const firstTravel = Math.max(
    length(subtract(currentFirst.start, previousFirst.start)),
    length(subtract(currentFirst.end, previousFirst.end)),
  );
  const secondTravel = Math.max(
    length(subtract(currentSecond.start, previousSecond.start)),
    length(subtract(currentSecond.end, previousSecond.end)),
  );
  const firstMotion = scale(
    add(
      subtract(currentFirst.start, previousFirst.start),
      subtract(currentFirst.end, previousFirst.end),
    ),
    0.5,
  );
  const secondMotion = scale(
    add(
      subtract(currentSecond.start, previousSecond.start),
      subtract(currentSecond.end, previousSecond.end),
    ),
    0.5,
  );
  const steps = sweepSteps(
    firstTravel + secondTravel,
    Math.max(0, currentFirst.radius) + Math.max(0, currentSecond.radius),
  );
  for (let index = 0; index <= steps; index += 1) {
    const time = index / steps;
    const contact = capsuleCapsuleContact(
      {
        start: lerp(previousFirst.start, currentFirst.start, time),
        end: lerp(previousFirst.end, currentFirst.end, time),
        radius: currentFirst.radius,
      },
      {
        start: lerp(previousSecond.start, currentSecond.start, time),
        end: lerp(previousSecond.end, currentSecond.end, time),
        radius: currentSecond.radius,
      },
      subtract(firstMotion, secondMotion),
    );
    if (contact) return { ...contact, time };
  }
  return undefined;
}

export function contactToForceEvent(
  contact: Contact,
  gains: Partial<CollisionForceGains> = {},
  tag = "collision",
): ForceEvent {
  const resolved = { ...TENTATIVE_COLLISION_FORCE_GAINS, ...gains };
  const closingSpeed = Math.max(0, -dot(contact.relativeVelocity, contact.normal));
  return {
    point: contact.point,
    direction: scale(contact.normal, -1),
    magnitude:
      Math.max(0, resolved.overall) *
      (Math.max(0, resolved.velocity) * closingSpeed +
        Math.max(0, resolved.penetration) * Math.max(0, contact.penetrationDepth)),
    tag,
  };
}

export type { Capsule, CollisionForceGains, Contact, Sphere } from "./types";
