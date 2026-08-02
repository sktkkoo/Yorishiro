/**
 * ExpressionIntentResolver — admitted な semantic intent を concrete な
 * ExpressionManager contribution（kind + expressionName + weight）へ変換する。
 *
 * ここも mixer ではない：weight の合成・budget は行わず、1 intent を
 * one-or-many の contribution に写像するだけ。mapping は host 共通とし、
 * persona 固有 catalog は所有しない（decision doc §2）。
 *
 * direct-target compatibility：既存 persona / MCP API の arbitrary preset /
 * custom morph は移行中だけ target 直指定で包む。region metadata を安全に
 * 解決できない target は推測で分類せず unmapped として観察する。
 */

import type { AdmittedExpressionIntent } from "./expression-intent";
import { FULL_FACE_AFFECT_OCCUPANCY } from "./expression-intent-policy";
import type { ExpressionKind } from "./expression-manager";

/** resolver が bridge / shadow へ返す 1 contribution 分の写像結果。 */
export interface ExpressionContribution {
  readonly intentId: string;
  readonly source: AdmittedExpressionIntent["source"];
  readonly kind: ExpressionKind;
  readonly expressionName: string;
  readonly requestedWeight: number;
}

/** contribution を受け取る callback。hot path での配列 allocation を避ける。 */
export type ContributionSink = (
  kind: ExpressionKind,
  expressionName: string,
  requestedWeight: number,
) => void;

/**
 * host 共通の semantic state → concrete mapping。
 * `semantic.state` は provider-neutral な意味語で、現時点では VRM 1.0 の
 * 感情 preset と同名の語彙を identity で写像する。persona 固有の語彙は
 * ここに足さない（compatibility resolver の存在を persona catalog の既成
 * 事実にしない）。
 */
const HOST_SEMANTIC_STATE_TO_MOOD: ReadonlyMap<string, string> = new Map([
  ["neutral", "neutral"],
  ["happy", "happy"],
  ["angry", "angry"],
  ["sad", "sad"],
  ["relaxed", "relaxed"],
  ["surprised", "surprised"],
]);

/** VRM 1.0 の感情 preset 名（full-face mood として扱う direct-target）。 */
const VRM_MOOD_PRESETS: ReadonlySet<string> = new Set([
  "neutral",
  "happy",
  "angry",
  "sad",
  "relaxed",
  "surprised",
]);

/** eyelid / gaze 系 direct-target（legacy kind "eye" 相当）。 */
const EYE_VARIANTS: ReadonlySet<string> = new Set([
  "blink",
  "blinkLeft",
  "blinkRight",
  "blinkL",
  "blinkR",
  "lookUp",
  "lookDown",
  "lookLeft",
  "lookRight",
]);

/** 口形素 direct-target（legacy kind "lip" 相当）。 */
const VISEMES: ReadonlySet<string> = new Set(["aa", "ih", "ou", "ee", "oh"]);

/** Hana Tool 系 part morph の region prefix。 */
const PART_PREFIX_TO_KIND: ReadonlyMap<string, ExpressionKind> = new Map([
  ["Fcl_BRW_", "part-brow"],
  ["Fcl_EYE_", "part-eye"],
  ["Fcl_MTH_", "part-mouth"],
]);

function isFullFaceAffect(intent: AdmittedExpressionIntent): boolean {
  const occupancy = intent.occupancy;
  if (occupancy.length !== FULL_FACE_AFFECT_OCCUPANCY.length) return false;
  for (const required of FULL_FACE_AFFECT_OCCUPANCY) {
    if (!occupancy.some((o) => o.region === required.region && o.lane === required.lane)) {
      return false;
    }
  }
  return true;
}

export class ExpressionIntentResolver {
  /**
   * intent を contribution へ解決し sink に流す。解決できなければ false
   * （呼び出し側が `unmapped-target` として観察する）。
   *
   * 優先順: semantic.state の host mapping → semantic.target の
   * direct-target compatibility。
   */
  resolve(intent: AdmittedExpressionIntent, sink: ContributionSink): boolean {
    // legacy public API（express / acquireExpressionSlot）由来の intent は
    // caller が明示した kind をそのまま使う（#83 M5 direct-target 互換）。
    const legacyKind = intent.semantic.legacyKind;
    if (legacyKind !== undefined && intent.semantic.target !== undefined) {
      sink(legacyKind, intent.semantic.target, intent.effectiveIntensity);
      return true;
    }

    const state = intent.semantic.state;
    if (state !== undefined) {
      const mood = HOST_SEMANTIC_STATE_TO_MOOD.get(state);
      if (mood !== undefined) {
        sink("mood", mood, intent.effectiveIntensity);
        return true;
      }
      // state が未知でも target があれば direct-target へ fallback する
    }

    const target = intent.semantic.target;
    if (target === undefined) return false;

    if (VRM_MOOD_PRESETS.has(target) && isFullFaceAffect(intent)) {
      sink("mood", target, intent.effectiveIntensity);
      return true;
    }
    if (EYE_VARIANTS.has(target)) {
      sink("eye", target, intent.effectiveIntensity);
      return true;
    }
    if (VISEMES.has(target)) {
      sink("lip", target, intent.effectiveIntensity);
      return true;
    }
    for (const [prefix, kind] of PART_PREFIX_TO_KIND) {
      if (target.startsWith(prefix)) {
        // baseline variation（idle micro 等）は legacy の custom kind に合わせ、
        // それ以外（persona part 指定 / speech 賦活）は part-{region} kind へ。
        // custom にすると speech / persona の source priority が idle の custom
        // slot（micro / relaxed）を kind 内で丸ごと抑止してしまうため。
        const resolvedKind = intent.semantic.role === "baseline" ? "custom" : kind;
        sink(resolvedKind, target, intent.effectiveIntensity);
        return true;
      }
    }
    // region metadata を持つ intent の任意 blendshape は custom として通す。
    // occupancy が空の target は分類根拠が無いので unmapped に倒す。
    if (intent.occupancy.length > 0) {
      sink("custom", target, intent.effectiveIntensity);
      return true;
    }
    return false;
  }
}
