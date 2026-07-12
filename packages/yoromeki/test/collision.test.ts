import { describe, expect, it } from "vitest";
import {
  type Capsule,
  capsuleCapsuleContact,
  contactToForceEvent,
  sphereCapsuleContact,
  sweptCapsuleCapsuleContact,
  sweptSphereCapsuleContact,
} from "../src/collision";

const BODY: Capsule = {
  start: { x: 0, y: 0, z: 0 },
  end: { x: 0, y: 2, z: 0 },
  radius: 0.5,
};

describe("sphereCapsuleContact", () => {
  it("軸整列 capsule 直上の球を既知解と照合する", () => {
    const contact = sphereCapsuleContact({ center: { x: 0, y: 2.75, z: 0 }, radius: 0.5 }, BODY);
    expect(contact?.penetrationDepth).toBeCloseTo(0.25);
    expect(contact?.normal).toEqual({ x: 0, y: 1, z: 0 });
    expect(contact?.point).toEqual({ x: 0, y: 2.5, z: 0 });
  });

  it("接触境界を含み、境界外を除外する", () => {
    expect(sphereCapsuleContact({ center: { x: 1, y: 1, z: 0 }, radius: 0.5 }, BODY)).toBeDefined();
    expect(
      sphereCapsuleContact({ center: { x: 1.001, y: 1, z: 0 }, radius: 0.5 }, BODY),
    ).toBeUndefined();
  });
});

describe("capsuleCapsuleContact", () => {
  it("平行 capsule の距離と normal を既知解と照合する", () => {
    const contact = capsuleCapsuleContact(
      { start: { x: 0.8, y: 0, z: 0 }, end: { x: 0.8, y: 2, z: 0 }, radius: 0.4 },
      BODY,
    );
    expect(contact?.penetrationDepth).toBeCloseTo(0.1);
    expect(contact?.normal).toEqual({ x: 1, y: 0, z: 0 });
  });
});

describe("swept collision", () => {
  it("1 frame で capsule を跨ぐ sphere を捕捉する", () => {
    const contact = sweptSphereCapsuleContact(
      { center: { x: -2, y: 1, z: 0 }, radius: 0.2 },
      { center: { x: 2, y: 1, z: 0 }, radius: 0.2 },
      BODY,
      BODY,
    );
    expect(contact).toBeDefined();
    expect(contact?.time).toBeGreaterThan(0);
    expect(contact?.time).toBeLessThan(1);
  });

  it("1 frame で固定 capsule を跨ぐ capsule を捕捉する", () => {
    const moving = (x: number): Capsule => ({
      start: { x, y: 0.5, z: 0 },
      end: { x, y: 1.5, z: 0 },
      radius: 0.15,
    });
    expect(sweptCapsuleCapsuleContact(moving(-2), moving(2), BODY, BODY)).toBeDefined();
  });
});

it("接触を身体側へ向く ForceEvent に変換する", () => {
  const event = contactToForceEvent({
    point: { x: 0, y: 2.5, z: 0 },
    normal: { x: 0, y: 1, z: 0 },
    relativeVelocity: { x: 0, y: -3, z: 0 },
    penetrationDepth: 0.25,
    time: 1,
  });
  expect(event.direction).toEqual({ x: -0, y: -1, z: -0 });
  expect(event.magnitude).toBeCloseTo(6);
  expect(event.point).toEqual({ x: 0, y: 2.5, z: 0 });
});
