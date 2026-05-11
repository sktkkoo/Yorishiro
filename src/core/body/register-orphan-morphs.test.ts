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
import {
  ExpressionManager,
  ExpressionSinkTracker,
  expressionTargetToName,
} from "./expression-manager";
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

// ─── SDK kind:"custom" 経路の end-to-end ─────────────────
//
// SDK 公開 API `express({ kind: "custom", blendShapeName: name }, intensity)` が
// orphan morph まで通電することを保証する。経路は：
//   ExpressionManager.addSlot("persona", "custom", name, w)
//     → resolved map に name -> w
//     → ExpressionSinkTracker.apply → vrm.expressionManager.setValue
//     → vrm.expressionManager.update() → mesh.morphTargetInfluences[idx]
// Body class そのものは VRM lookAt / humanoid 等を要求するため、ここでは
// applyExpressions と等価な層だけを組み立てて検査する。

describe("SDK kind:custom end-to-end (Fcl_* orphan morphs)", () => {
  function buildPipeline(morphTargetDictionary: Record<string, number>) {
    const mesh = makeMockMesh(morphTargetDictionary);
    const vrm = makeMockVrm({ meshes: [mesh] });
    registerOrphanMorphs(vrm);
    const exprMgr = new ExpressionManager();
    const tracker = new ExpressionSinkTracker();
    const flush = () => {
      tracker.apply(exprMgr.getResolved(), (name, weight) => {
        vrm.expressionManager?.setValue(name, weight);
      });
      vrm.expressionManager?.update();
    };
    return { mesh, vrm, exprMgr, flush };
  }

  it("custom slot drives the morphTargetInfluences via the full pipeline", () => {
    const { mesh, exprMgr, flush } = buildPipeline({ Fcl_BRW_Sorrow: 0 });

    // SDK 経路相当：kind:"custom" の slot を allocate
    const target = { kind: "custom" as const, blendShapeName: "Fcl_BRW_Sorrow" };
    exprMgr.addSlot("persona", "custom", expressionTargetToName(target), 0.6);
    flush();

    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0.6);
  });

  it("releasing the slot zeroes the morph on the next flush", () => {
    const { mesh, exprMgr, flush } = buildPipeline({ Fcl_BRW_Sorrow: 0 });
    const slot = exprMgr.addSlot("persona", "custom", "Fcl_BRW_Sorrow", 0.6);
    flush();
    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0.6);

    exprMgr.removeSlot(slot);
    flush();
    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0);
  });

  it("known limitation: same-kind suppression collapses multiple custom slots", () => {
    // 現状の ExpressionManager は kind 単位で priority 解決するため、
    // 異なる source から同 kind:"custom" の slot を取ると下位 source が
    // suppressed される。AU-level な multi-morph 構成は同 source 単一 slot で
    // 1 blendshape しか駆動できない。Phase C で custom の slot 設計を見直す
    // 余地あり（per-(source, kind, name) dedup or 専用 "au" kind 等）。
    const { mesh, exprMgr, flush } = buildPipeline({ Fcl_BRW_Sorrow: 0, Fcl_EYE_Spread: 1 });

    exprMgr.addSlot("persona", "custom", "Fcl_BRW_Sorrow", 0.4);
    exprMgr.addSlot("mcp", "custom", "Fcl_EYE_Spread", 0.3);
    flush();

    // mcp(3) > persona(2) の同 kind 比較で persona は suppressed、
    // Fcl_BRW_Sorrow には書かれない（=lastWritten にも入らないので 0 まま）。
    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0);
    expect(mesh.morphTargetInfluences?.[1]).toBeCloseTo(0.3);
  });

  it("single source can drive at most one custom slot due to (source, kind) dedup", () => {
    // 同じ source / kind で異なる name を addSlot すると、前 slot は dedup で release。
    // 「persona が AU1 と AU6 を同時に出す」ような pattern は今は表現できない。
    const { mesh, exprMgr, flush } = buildPipeline({ Fcl_BRW_Sorrow: 0, Fcl_EYE_Spread: 1 });

    exprMgr.addSlot("persona", "custom", "Fcl_BRW_Sorrow", 0.4);
    exprMgr.addSlot("persona", "custom", "Fcl_EYE_Spread", 0.3);
    flush();

    // 1 件目は dedup で release されており、2 件目だけが生きている
    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0);
    expect(mesh.morphTargetInfluences?.[1]).toBeCloseTo(0.3);
  });

  it("expressionTargetToName extracts the blendShapeName for kind:custom", () => {
    expect(expressionTargetToName({ kind: "custom", blendShapeName: "Fcl_EYE_Spread" })).toBe(
      "Fcl_EYE_Spread",
    );
  });

  it("part kinds let a single source compose brow+eye+mouth simultaneously", () => {
    // Phase C で persona pack が「眉=sorrow / 目=sorrow / 口=sorrow」のように
    // 部位ごとに独立 weight で sadness を構成できることを保証する。
    // 内部 kind が `part-brow / part-eye / part-mouth` に分かれているため
    // (source, kind) dedup の対象にならず、同一 source から 3 slot 並走できる。
    const { mesh, exprMgr, flush } = buildPipeline({
      Fcl_BRW_Sorrow: 0,
      Fcl_EYE_Sorrow: 1,
      Fcl_MTH_Sorrow: 2,
    });

    // 合計 0.3 + 0.2 + 0.4 = 0.9 で全 active 合算 budget 1.0 を超えないので
    // proportional scale-down は発生せず、各値はそのまま morph に書かれる。
    exprMgr.addSlot("persona", "part-brow", "Fcl_BRW_Sorrow", 0.3);
    exprMgr.addSlot("persona", "part-eye", "Fcl_EYE_Sorrow", 0.2);
    exprMgr.addSlot("persona", "part-mouth", "Fcl_MTH_Sorrow", 0.4);
    flush();

    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0.3);
    expect(mesh.morphTargetInfluences?.[1]).toBeCloseTo(0.2);
    expect(mesh.morphTargetInfluences?.[2]).toBeCloseTo(0.4);
  });

  it("same part-region from two sources still suppresses lower priority (per-kind arbitration)", () => {
    // part-brow など region 内では従来通り source priority arbitration が効く。
    // mcp が出した sorrow が persona の joy を上書きする。
    const { mesh, exprMgr, flush } = buildPipeline({ Fcl_BRW_Joy: 0, Fcl_BRW_Sorrow: 1 });

    exprMgr.addSlot("persona", "part-brow", "Fcl_BRW_Joy", 0.5);
    exprMgr.addSlot("mcp", "part-brow", "Fcl_BRW_Sorrow", 0.4);
    flush();

    expect(mesh.morphTargetInfluences?.[0]).toBeCloseTo(0);
    expect(mesh.morphTargetInfluences?.[1]).toBeCloseTo(0.4);
  });
});
