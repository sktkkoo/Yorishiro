/**
 * register-orphan-morphs — VRM 上で expression にバインドされていない morph target
 * を実行時に synthetic VRMExpression として登録する。
 *
 * 背景：CLAI で使用している VRM 0.x モデルは Hana Tool (VRoid Studio) 命名の
 * 57 morph target を持つが、BlendShapeMaster に wired されているのは標準 14 group
 * のみで、残り 43 morph (Fcl_BRW_*, Fcl_EYE_part_*, asymmetric L/R 等) は orphan。
 * `vrm.expressionManager.setValue("Fcl_BRW_Sorrow", w)` は silently no-op だった。
 *
 * 本モジュールは VRM load 直後にこれらの orphan morph を 1-to-1 で synthetic
 * VRMExpression として登録し、`vrm.expressionManager.setValue(<morph名>, w)` で
 * 駆動可能にする。これにより ExpressionManager slot mixer の `kind: "custom"`
 * 経路と pack 作者が公開 API 経由で AU-level 表情を author できる。
 *
 * Perfect Sync 対応 VRM (52 ARKit blendshape) もここで透過的に拾える。
 */

import type { VRM } from "@pixiv/three-vrm";
import {
  VRMExpression,
  type VRMExpressionManager,
  VRMExpressionMorphTargetBind,
} from "@pixiv/three-vrm";
import type * as THREE from "three";

// ─── Pure logic ───────────────────────────────────────────

export interface OrphanScanInput {
  readonly meshes: ReadonlyArray<{
    readonly morphTargetDictionary: Record<string, number>;
  }>;
  /** すでに expression として登録済みの名前（preset + custom）。 */
  readonly takenExpressionNames: ReadonlySet<string>;
  /** 既存 expression bind がカバーしている morph 名。 */
  readonly wiredMorphNames: ReadonlySet<string>;
}

export interface OrphanMorph {
  readonly meshIndex: number;
  readonly morphName: string;
  readonly morphIndex: number;
}

/**
 * Pure scan — どの mesh のどの morph が orphan かを返す。
 * takenExpressionNames / wiredMorphNames はいずれも skip 条件。
 */
export function findOrphanMorphs(input: OrphanScanInput): OrphanMorph[] {
  const orphans: OrphanMorph[] = [];
  for (let mi = 0; mi < input.meshes.length; mi++) {
    const dict = input.meshes[mi]?.morphTargetDictionary;
    if (!dict) continue;
    for (const [morphName, morphIndex] of Object.entries(dict)) {
      if (input.takenExpressionNames.has(morphName)) continue;
      if (input.wiredMorphNames.has(morphName)) continue;
      orphans.push({ meshIndex: mi, morphName, morphIndex });
    }
  }
  return orphans;
}

// ─── VRM integration ──────────────────────────────────────

export interface RegisterOrphanMorphsResult {
  /** 今回新規に登録された expression 名のリスト。 */
  readonly registered: string[];
}

/**
 * VRM の scene を走査し、orphan morph を synthetic VRMExpression として登録する。
 * idempotent — 二度呼んでも同名 expression は重複登録されない。
 */
export function registerOrphanMorphs(vrm: VRM): RegisterOrphanMorphsResult {
  const exprMgr = vrm.expressionManager;
  if (!exprMgr) return { registered: [] };

  // 1. morphTargetDictionary を持つ mesh を収集
  const meshes = collectMorphMeshes(vrm.scene);
  if (meshes.length === 0) return { registered: [] };

  // 2. 既存 expression / bind 情報を集約
  const takenExpressionNames = new Set<string>(Object.keys(exprMgr.expressionMap));
  const wiredMorphNames = collectWiredMorphNames(exprMgr, meshes);

  // 3. orphan を pure scan
  const orphans = findOrphanMorphs({
    meshes: meshes.map((m) => ({
      // m.morphTargetDictionary は collectMorphMeshes で non-undefined 保証
      morphTargetDictionary: m.morphTargetDictionary as Record<string, number>,
    })),
    takenExpressionNames,
    wiredMorphNames,
  });

  // 4. 各 orphan に対し synthetic expression を登録
  const registered: string[] = [];
  for (const orphan of orphans) {
    const primitive = meshes[orphan.meshIndex];
    if (!primitive) continue;
    const expression = new VRMExpression(orphan.morphName);
    expression.addBind(
      new VRMExpressionMorphTargetBind({
        primitives: [primitive],
        index: orphan.morphIndex,
        weight: 1,
      }),
    );
    exprMgr.registerExpression(expression);
    registered.push(orphan.morphName);
  }

  return { registered };
}

// ─── helpers ──────────────────────────────────────────────

function collectMorphMeshes(scene: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    const m = obj as THREE.Mesh;
    if (!m.isMesh) return;
    const dict = m.morphTargetDictionary;
    if (!dict) return;
    if (Object.keys(dict).length === 0) return;
    meshes.push(m);
  });
  return meshes;
}

function collectWiredMorphNames(
  exprMgr: VRMExpressionManager,
  meshes: ReadonlyArray<THREE.Mesh>,
): Set<string> {
  const wired = new Set<string>();
  for (const expr of exprMgr.expressions) {
    for (const bind of expr.binds) {
      // VRMExpressionMorphTargetBind だけが index / primitives を持つ。
      // 他の bind type (TextureTransform / MaterialColor) は string lookup に
      // 寄与しないので skip。
      if (!(bind instanceof VRMExpressionMorphTargetBind)) continue;
      for (const prim of bind.primitives) {
        const dict = prim.morphTargetDictionary;
        if (!dict) continue;
        // この primitive で bind.index が指す morph 名を逆引きする
        for (const [name, idx] of Object.entries(dict)) {
          if (idx === bind.index) wired.add(name);
        }
      }
      // bind.primitives に含まれない mesh でも、同 index が同名を指している保証は
      // ないので、ここでは bind.primitives に列挙された分だけで十分。meshes 引数は
      // 将来 mesh 横断検査が必要になったとき用に取ってある。
      void meshes;
    }
  }
  return wired;
}
