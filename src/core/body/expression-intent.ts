/**
 * ExpressionIntent — provider / avatar 非依存の表情 intent 型定義。
 *
 * #83 expression intent arbitration の基礎語彙。producer が「どの表情を
 * 出したいか」を semantic に宣言し、ExpressionIntentArbiter が admission /
 * suppression を判定する。concrete な morph 名や weight budget はここに
 * 持たない（それは ExpressionIntentResolver / ExpressionManager の責務）。
 *
 * 設計正本: docs/decisions/expression-intent-arbitration.md §2
 */

import type { ExpressionKind, ExpressionSource } from "./expression-manager";

/**
 * Intent の意味役割。priority class の導出に使う。
 *
 * - baseline: 常在の土台（state base / relaxed / idle micro / auto blink）
 * - grounded-state: 会話・活動に接地した状態表現（speech mood 等）
 * - explicit-action: 明示的な単発 action（persona express / MCP acquire）
 * - safety-reflex: 意識を上書きする安全・生理反射（documented highest priority）
 */
export type ExpressionSemanticRole =
  | "baseline"
  | "grounded-state"
  | "explicit-action"
  | "safety-reflex";

/**
 * 顔 region。ExpressionManager の PartRegion (brow/eye/mouth) と別に
 * `eyelid` を持つ：blink / squint は「目の affect」ではなく眼瞼の生理であり、
 * eye affect (見開き・視線系 morph) と共存するため。
 */
export type FaceRegion = "brow" | "eye" | "eyelid" | "mouth";

/**
 * Function lane。同 region でも lane が違えば競合しない。
 *
 * - affect: 感情・状態の表現（mood preset / part morph / microvariation）
 * - physiology: 生理（blink / squint / eyelid reflex）
 * - articulation: 発話構音（lip-sync viseme）。#83 では予約のみで、
 *   expression intent がこの lane を suppress することはない
 */
export type ExpressionLane = "affect" | "physiology" | "articulation";

/** Intent が占有する region + lane の 1 対。 */
export interface ExpressionOccupancy {
  readonly region: FaceRegion;
  readonly lane: ExpressionLane;
}

/**
 * Salience（顕在度）。source と合わせて priority class を導出する。
 * producer が arbitrary な数値 priority を渡す API は作らない。
 */
export type ExpressionSalience = "ambient" | "grounded" | "explicit" | "reflex";

/**
 * Intent の owner。producer + scope（utterance / reaction / request 単位）+
 * optional generation で識別する。
 *
 * - generation: 古い timer / event からの stale release を無効化する世代番号
 * - replacementKey: 同じ (producerId, replacementKey) の新 intent が旧 intent を
 *   replace する（speech mood のような「常に最新 1 つ」チャネル用）
 */
export interface ExpressionIntentOwner {
  readonly producerId: string;
  readonly scopeId: string;
  readonly generation?: number;
  readonly replacementKey?: string;
}

/**
 * Intent の semantic 内容。state は `acknowledging` / `concerned` のような
 * provider-neutral な意味語で、morph 名ではない。target は host 共通 mapping の
 * key（移行中の direct-target compatibility では raw morph / preset 名を入れる）。
 */
export interface ExpressionSemantic {
  readonly role: ExpressionSemanticRole;
  readonly state?: string;
  readonly target?: string;
  /**
   * direct-target compatibility（#83 M5）: legacy の public slot API
   * （express / acquireExpressionSlot）を intent で包む際、既存 caller が
   * 明示していた ExpressionKind をそのまま運ぶ。resolver はこれがあれば
   * kind の推測分類を行わない（arbitrary morph の region / kind を推測しない
   * という decision doc §2 の原則）。新規 producer は使わないこと。
   */
  readonly legacyKind?: ExpressionKind;
}

/** held: release されるまで維持。pulse: durationMs 後に自動 release。 */
export type ExpressionIntentLifecycle =
  | { readonly kind: "held"; readonly attackMs?: number; readonly releaseMs?: number }
  | {
      readonly kind: "pulse";
      readonly durationMs: number;
      readonly attackMs?: number;
      readonly releaseMs?: number;
    };

/** Arbiter へ submit する intent。intentId は arbiter が採番する。 */
export interface ExpressionIntentRequest {
  readonly owner: ExpressionIntentOwner;
  readonly source: ExpressionSource;
  readonly semantic: ExpressionSemantic;
  readonly occupancy: ReadonlyArray<ExpressionOccupancy>;
  readonly salience: ExpressionSalience;
  readonly intensity: number;
  readonly lifecycle: ExpressionIntentLifecycle;
}

/** 採番済み intent。snapshot / resolver が参照する完全形。 */
export interface ExpressionIntent extends ExpressionIntentRequest {
  readonly intentId: string;
}

/**
 * Intent lifecycle phase。
 *
 * - active: admitted、単独で occupancy を保持
 * - blended: admitted、同 class の他 intent と共存中
 * - suppressed: policy により抑止中（occupancy 上の負け / ambient guard /
 *   domain claim）。抑止元が消えれば再 admit される
 * - releasing: release envelope 進行中（occupancy は保持）
 * - expired: envelope 完了 / replace 済み。次 update で削除される
 */
export type ExpressionIntentPhase = "active" | "blended" | "suppressed" | "releasing" | "expired";

/**
 * Machine-readable な判定理由。
 * 設計正本: docs/decisions/expression-intent-arbitration.md §6
 */
export type ExpressionIntentReason =
  | "lower-priority-overlap"
  | "replaced-same-owner"
  | "exclusive-tie-lost"
  | "ambient-suspended-by-grounded"
  | "ambient-policy-rejected"
  | "domain-claimed"
  | "unmapped-target"
  | "released"
  | "expired";

/** Snapshot の 1 intent 分。reason は suppressed / releasing / expired 時に立つ。 */
export interface ExpressionIntentSnapshotEntry {
  readonly intentId: string;
  readonly owner: ExpressionIntentOwner;
  readonly source: ExpressionSource;
  readonly semantic: ExpressionSemantic;
  readonly occupancy: ReadonlyArray<ExpressionOccupancy>;
  readonly salience: ExpressionSalience;
  readonly requestedIntensity: number;
  /** envelope 適用後の現在強度（attack / release 進行を反映）。 */
  readonly effectiveIntensity: number;
  readonly phase: ExpressionIntentPhase;
  readonly reason: ExpressionIntentReason | null;
  /** 抑止した相手（intent なら intentId、claim なら "claim:expression" 等）。 */
  readonly suppressedBy: string | null;
}

/** Arbitration 全体の snapshot。要求時のみ allocate する。 */
export interface ExpressionArbitrationSnapshot {
  readonly intents: ReadonlyArray<ExpressionIntentSnapshotEntry>;
}

/**
 * Resolver / slot bridge へ渡す admitted intent の hot-path view。
 * 通常 render path での per-frame allocation を避けるため、arbiter が
 * 内部で再利用する mutable record を read-only 形で公開する。
 */
export interface AdmittedExpressionIntent {
  readonly intentId: string;
  readonly source: ExpressionSource;
  readonly semantic: ExpressionSemantic;
  readonly occupancy: ReadonlyArray<ExpressionOccupancy>;
  /** envelope 適用後の現在強度。 */
  readonly effectiveIntensity: number;
}

/** Producer が受け取る owner-scoped handle。 */
export interface ExpressionIntentHandle {
  readonly intentId: string;
  /**
   * release envelope を含め、record が lifecycle 上まだ生存しているか。
   * hot path から snapshot を生成せず pulse 完了を確認するための allocation-free view。
   */
  readonly isAlive: boolean;
  /** requested intensity を更新する。stale handle からの呼び出しは無視される。 */
  updateIntensity(intensity: number): void;
  /** release envelope を開始する。stale handle からの呼び出しは無視される。 */
  release(): void;
}
