import type { Vec3 } from "../types";

export interface Sphere {
  center: Vec3;
  radius: number;
}

export interface Capsule {
  start: Vec3;
  end: Vec3;
  radius: number;
}

/** normal は第 2 形状から第 1 形状へ向く。 */
export interface Contact {
  point: Vec3;
  normal: Vec3;
  relativeVelocity: Vec3;
  penetrationDepth: number;
  time: number;
}

export interface CollisionForceGains {
  velocity: number;
  penetration: number;
  overall: number;
}
