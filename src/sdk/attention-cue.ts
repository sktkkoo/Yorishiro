/**
 * @yorishiro/sdk/attention-cue
 *
 * Scene Pack が runtime の attention cue を描画・claim するための public entry。
 * runtime の registry / default light / test injection surface は公開せず、Pack 作者に
 * 必要な component と hook だけを選択して公開する。
 */

import type { ComponentType } from "react";
import {
  AttentionCueLight as RuntimeAttentionCueLight,
  useClaimAttentionCue as useRuntimeClaimAttentionCue,
} from "../runtime/three-runtime/attention-cue-light";

export interface AttentionCueLightProps {
  /** 未指定なら cue 開始時のキャラクター head 位置から自動配置する。 */
  readonly position?: readonly [number, number, number];
  readonly color?: string;
  readonly intensityScale?: number;
}

/**
 * Scene 所有の attention cue light。mount 中は runtime の yielding default を退かせる。
 */
export const AttentionCueLight: ComponentType<AttentionCueLightProps> = RuntimeAttentionCueLight;

/** 描画せずに yielding default だけを退かせる。 */
export const useClaimAttentionCue: () => void = useRuntimeClaimAttentionCue;
