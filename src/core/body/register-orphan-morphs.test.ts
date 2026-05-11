/**
 * register-orphan-morphs — orphan morph 走査 + 動的 VRMExpression 登録の test。
 *
 * Pure logic (`findOrphanMorphs`) と、@pixiv/three-vrm の実 class を使う integration
 * test の二段。後者は Three.js の最小 Mesh / VRMExpressionManager を組んで VRM-like
 * オブジェクトを作って入力する。
 */

import type { VRM } from "@pixiv/three-vrm";
import {
  VRMExpression,
  VRMExpressionManager,
  VRMExpressionMorphTargetBind,
} from "@pixiv/three-vrm";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { findOrphanMorphs, registerOrphanMorphs } from "./register-orphan-morphs";

// ─── findOrphanMorphs (pure) ──────────────────────────────

describe("findOrphanMorphs", () => {
  it("returns empty when every morph name is in takenExpressionNames", () => {
    const orphans = findOrphanMorphs({
      meshes: [{ morphTargetDictionary: { Fcl_ALL_Joy: 0, Fcl_MTH_A: 1 } }],
      takenExpressionNames: new Set(["Fcl_ALL_Joy", "Fcl_MTH_A"]),
      wiredMorphNames: new Set(),
    });
    expect(orphans).toEqual([]);
  });

  it("excludes morphs already wired by existing expressions", () => {
    // VRM 0.x preset 'joy' は Fcl_ALL_Joy にバインド済み。残り Fcl_BRW_Sorrow は orphan。
    const orphans = findOrphanMorphs({
      meshes: [{ morphTargetDictionary: { Fcl_ALL_Joy: 0, Fcl_BRW_Sorrow: 1 } }],
      takenExpressionNames: new Set(["joy"]),
      wiredMorphNames: new Set(["Fcl_ALL_Joy"]),
    });
    expect(orphans).toEqual([{ meshIndex: 0, morphName: "Fcl_BRW_Sorrow", morphIndex: 1 }]);
  });

  it("returns all morphs when none are taken or wired", () => {
    const orphans = findOrphanMorphs({
      meshes: [{ morphTargetDictionary: { Fcl_BRW_Joy: 0, Fcl_EYE_Spread: 1 } }],
      takenExpressionNames: new Set(),
      wiredMorphNames: new Set(),
    });
    expect(orphans).toHaveLength(2);
    expect(orphans).toContainEqual({ meshIndex: 0, morphName: "Fcl_BRW_Joy", morphIndex: 0 });
    expect(orphans).toContainEqual({ meshIndex: 0, morphName: "Fcl_EYE_Spread", morphIndex: 1 });
  });

  it("traverses multiple meshes and keeps the originating index", () => {
    const orphans = findOrphanMorphs({
      meshes: [
        { morphTargetDictionary: { Fcl_BRW_Joy: 0 } },
        { morphTargetDictionary: { Fcl_HA_Fung1: 5 } },
      ],
      takenExpressionNames: new Set(),
      wiredMorphNames: new Set(),
    });
    expect(orphans).toHaveLength(2);
    expect(orphans).toContainEqual({ meshIndex: 0, morphName: "Fcl_BRW_Joy", morphIndex: 0 });
    expect(orphans).toContainEqual({ meshIndex: 1, morphName: "Fcl_HA_Fung1", morphIndex: 5 });
  });
});

// ─── registerOrphanMorphs (integration) ───────────────────

function makeMockMesh(morphTargetDictionary: Record<string, number>): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.morphTargetDictionary = morphTargetDictionary;
  mesh.morphTargetInfluences = new Array(Object.keys(morphTargetDictionary).length).fill(0);
  return mesh;
}

function makeMockVrm(opts: {
  meshes: THREE.Mesh[];
  presetExpressions?: ReadonlyArray<{
    name: string;
    binds: ReadonlyArray<{ mesh: THREE.Mesh; index: number }>;
  }>;
}): VRM {
  const scene = new THREE.Scene();
  for (const m of opts.meshes) scene.add(m);

  const exprMgr = new VRMExpressionManager();
  for (const preset of opts.presetExpressions ?? []) {
    const expr = new VRMExpression(preset.name);
    for (const b of preset.binds) {
      expr.addBind(
        new VRMExpressionMorphTargetBind({
          primitives: [b.mesh],
          index: b.index,
          weight: 1,
        }),
      );
    }
    exprMgr.registerExpression(expr);
  }

  return { scene, expressionManager: exprMgr } as unknown as VRM;
}

describe("registerOrphanMorphs", () => {
  it("registers unbound Fcl_* morphs as synthetic expressions on a CLAI-like VRM", () => {
    // VRM 0.x ライクな構成：joy preset が Fcl_ALL_Joy にバインド済み。
    // Fcl_BRW_Sorrow / Fcl_EYE_Spread は orphan として残っているはず。
    const mesh = makeMockMesh({ Fcl_ALL_Joy: 0, Fcl_BRW_Sorrow: 1, Fcl_EYE_Spread: 2 });
    const vrm = makeMockVrm({
      meshes: [mesh],
      presetExpressions: [{ name: "joy", binds: [{ mesh, index: 0 }] }],
    });

    const { registered } = registerOrphanMorphs(vrm);

    expect(registered).toContain("Fcl_BRW_Sorrow");
    expect(registered).toContain("Fcl_EYE_Spread");
    expect(registered).not.toContain("Fcl_ALL_Joy");

    const exprMgr = vrm.expressionManager;
    if (!exprMgr) throw new Error("expressionManager null");
    expect(exprMgr.getExpression("Fcl_BRW_Sorrow")).not.toBeNull();
    expect(exprMgr.getExpression("Fcl_EYE_Spread")).not.toBeNull();
    // 既存 'joy' は維持
    expect(exprMgr.getExpression("joy")).not.toBeNull();
  });

  it("synthetic expression drives the underlying morphTargetInfluences via setValue + update", () => {
    const mesh = makeMockMesh({ Fcl_BRW_Sorrow: 0 });
    const vrm = makeMockVrm({ meshes: [mesh] });

    registerOrphanMorphs(vrm);
    const exprMgr = vrm.expressionManager;
    if (!exprMgr) throw new Error("expressionManager null");

    exprMgr.setValue("Fcl_BRW_Sorrow", 0.7);
    exprMgr.update();

    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0.7);
  });

  it("returns empty when the VRM has no expressionManager", () => {
    const scene = new THREE.Scene();
    const vrm = { scene, expressionManager: null } as unknown as VRM;
    const { registered } = registerOrphanMorphs(vrm);
    expect(registered).toEqual([]);
  });

  it("idempotent: calling twice does not duplicate registrations", () => {
    const mesh = makeMockMesh({ Fcl_BRW_Joy: 0 });
    const vrm = makeMockVrm({ meshes: [mesh] });

    const first = registerOrphanMorphs(vrm);
    const second = registerOrphanMorphs(vrm);

    expect(first.registered).toEqual(["Fcl_BRW_Joy"]);
    expect(second.registered).toEqual([]);
    expect(Object.keys(vrm.expressionManager?.expressionMap ?? {})).toHaveLength(1);
  });

  it("ignores meshes that have no morphTargetDictionary", () => {
    const faceMesh = makeMockMesh({ Fcl_BRW_Joy: 0 });
    const bodyMesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    // body mesh は morphTargetDictionary 持たない
    const vrm = makeMockVrm({ meshes: [faceMesh, bodyMesh] });

    const { registered } = registerOrphanMorphs(vrm);
    expect(registered).toEqual(["Fcl_BRW_Joy"]);
  });
});
