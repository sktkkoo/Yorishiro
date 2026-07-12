import type { Quat, Vec3 } from "./types";

export const ZERO: Vec3 = { x: 0, y: 0, z: 0 };

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function subtract(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(value: Vec3, scalar: number): Vec3 {
  return { x: value.x * scalar, y: value.y * scalar, z: value.z * scalar };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function lengthSquared(value: Vec3): number {
  return dot(value, value);
}

export function length(value: Vec3): number {
  return Math.sqrt(lengthSquared(value));
}

export function normalize(value: Vec3): Vec3 | undefined {
  const magnitude = length(value);
  if (!Number.isFinite(magnitude) || magnitude <= 1e-9) return undefined;
  return scale(value, 1 / magnitude);
}

export function finiteVec(value: Vec3): boolean {
  return Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.z);
}

export function rotationVectorToQuat(value: Vec3): Quat {
  const angle = length(value);
  if (!Number.isFinite(angle) || angle <= 1e-9) return { x: 0, y: 0, z: 0, w: 1 };
  const multiplier = Math.sin(angle / 2) / angle;
  return {
    x: value.x * multiplier,
    y: value.y * multiplier,
    z: value.z * multiplier,
    w: Math.cos(angle / 2),
  };
}
