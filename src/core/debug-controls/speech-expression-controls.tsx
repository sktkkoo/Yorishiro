/** 発話反射層の実機調整用 leva controls。 */

import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useRef } from "react";
import { getThreeRuntime } from "../../runtime/three-runtime";
import type { RuntimeLevaStore } from "../../runtime/three-runtime/runtime-leva-store";
import type { Body } from "../body";
import {
  DEFAULT_SPEECH_MICROEXPRESSION_PARAMS,
  type SpeechMicroexpressionParams,
} from "../body/speech-microexpression-system";

export interface SpeechExpressionControlsProps {
  readonly store?: RuntimeLevaStore;
}

export function SpeechExpressionControls({ store }: SpeechExpressionControlsProps) {
  const runtime = getThreeRuntime();
  const defaults = DEFAULT_SPEECH_MICROEXPRESSION_PARAMS;
  const [controls] = useControls(
    () => ({
      speech: folder({
        enabled: { value: true, label: "enabled" },
        engagementEnabled: { value: defaults.engagementEnabled, label: "CH1 engagement" },
        blinkEnabled: { value: defaults.blinkEnabled, label: "CH2 phrase blink" },
        flickEnabled: { value: defaults.flickEnabled, label: "CH3 brow flick" },
        speechThreshold: {
          value: defaults.speechThreshold,
          min: 0,
          max: 0.5,
          step: 0.01,
          label: "speech threshold",
        },
        attackMs: {
          value: defaults.attackMs,
          min: 50,
          max: 500,
          step: 10,
          label: "attack (ms)",
        },
        releaseMs: {
          value: defaults.releaseMs,
          min: 100,
          max: 2_000,
          step: 25,
          label: "release (ms)",
        },
        engagementBrowWeight: {
          value: defaults.engagementBrowWeight,
          min: 0,
          max: 0.3,
          step: 0.005,
          label: "engagement brow",
        },
        engagementEyeWeight: {
          value: defaults.engagementEyeWeight,
          min: 0,
          max: 0.3,
          step: 0.005,
          label: "engagement eye",
        },
        browWeightMax: {
          value: defaults.browWeightMax,
          min: 0,
          max: 0.4,
          step: 0.005,
          label: "brow max weight",
        },
        eyeWeightMax: {
          value: defaults.eyeWeightMax,
          min: 0,
          max: 0.3,
          step: 0.005,
          label: "eye max weight",
        },
        gapThresholdMs: {
          value: defaults.gapThresholdMs,
          min: 100,
          max: 800,
          step: 10,
          label: "phrase gap (ms)",
        },
        blinkProbability: {
          value: defaults.blinkProbability,
          min: 0,
          max: 1,
          step: 0.05,
          label: "blink probability",
        },
        onsetThreshold: {
          value: defaults.onsetThreshold,
          min: 0,
          max: 1,
          step: 0.01,
          label: "onset rise",
        },
        onsetMinVolume: {
          value: defaults.onsetMinVolume,
          min: 0,
          max: 1,
          step: 0.01,
          label: "onset min volume",
        },
        refractoryMs: {
          value: defaults.refractoryMs,
          min: 200,
          max: 4_000,
          step: 50,
          label: "refractory (ms)",
        },
        flickDurationMs: {
          value: defaults.flickDurationMs,
          min: 100,
          max: 600,
          step: 10,
          label: "flick duration (ms)",
        },
        flickWeight: {
          value: defaults.flickWeight,
          min: 0,
          max: 0.3,
          step: 0.005,
          label: "flick weight",
        },
      }),
    }),
    { store },
    [],
  );

  const params: SpeechMicroexpressionParams = {
    engagementEnabled: controls.engagementEnabled,
    blinkEnabled: controls.blinkEnabled,
    flickEnabled: controls.flickEnabled,
    speechThreshold: controls.speechThreshold,
    attackMs: controls.attackMs,
    releaseMs: controls.releaseMs,
    engagementBrowWeight: controls.engagementBrowWeight,
    engagementEyeWeight: controls.engagementEyeWeight,
    browWeightMax: controls.browWeightMax,
    eyeWeightMax: controls.eyeWeightMax,
    gapThresholdMs: controls.gapThresholdMs,
    blinkProbability: controls.blinkProbability,
    onsetThreshold: controls.onsetThreshold,
    onsetMinVolume: controls.onsetMinVolume,
    refractoryMs: controls.refractoryMs,
    flickDurationMs: controls.flickDurationMs,
    flickWeight: controls.flickWeight,
  };
  const lastApplied = useRef<{
    body: Body | null;
    enabled: boolean;
    params: SpeechMicroexpressionParams;
  } | null>(null);

  // Body は controls より後に生成され得るため、render loop 上で instance 変更も拾う。
  useFrame(() => {
    const body = runtime.getBody();
    const previous = lastApplied.current;
    if (
      previous?.body === body &&
      previous.enabled === controls.enabled &&
      previous.params === params
    ) {
      return;
    }
    body?.setSpeechExpressionEnabled(controls.enabled);
    body?.setSpeechExpressionParams(params);
    lastApplied.current = { body, enabled: controls.enabled, params };
  });

  return null;
}
