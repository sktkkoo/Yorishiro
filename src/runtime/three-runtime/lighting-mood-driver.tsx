import { useFrame } from "@react-three/fiber";
import { folder, useControls } from "leva";
import { useRef } from "react";
import { Color, MathUtils } from "three";
import {
  type LightingMood,
  NEUTRAL_LIGHTING_MOOD,
  useWorkspaceLightingMood,
} from "../workspace-attention";
import {
  type AttentionLightSettingsStore,
  getAttentionLightSettingsStore,
} from "./attention-light-settings";
import { getMainLightRegistry, type MainLightRegistry } from "./main-light-registry";
import type { RuntimeLevaStore } from "./runtime-leva-store";

const DEFAULT_BRIGHTNESS_GAIN = 0.35;
const DEFAULT_WARMTH_GAIN = 0.22;
const DEFAULT_LERP_SPEED = 1.15;
const MIN_INTENSITY_FACTOR = 0.65;
const MAX_INTENSITY_FACTOR = 1.25;
const WARM_TINT = new Color("#ffd1a8");
const COOL_TINT = new Color("#b9d5ff");

export interface LightingMoodDriverProps {
  readonly registry?: MainLightRegistry;
  readonly settings?: AttentionLightSettingsStore;
  readonly store?: RuntimeLevaStore;
}

export interface LightingMoodDriverControls {
  readonly brightnessGain: number;
  readonly warmthGain: number;
  readonly lerpSpeed: number;
}

export interface MoodLightTarget {
  readonly intensity: number;
  readonly color: Color;
}

export function computeMoodLightTarget(
  baseline: { readonly intensity: number; readonly color: Color },
  mood: LightingMood,
  enabled: boolean,
  controls: LightingMoodDriverControls,
): MoodLightTarget {
  const effectiveMood = enabled ? mood : NEUTRAL_LIGHTING_MOOD;
  const brightnessOffset = (effectiveMood.brightness - 0.5) * controls.brightnessGain;
  const intensityFactor = MathUtils.clamp(
    1 + brightnessOffset,
    MIN_INTENSITY_FACTOR,
    MAX_INTENSITY_FACTOR,
  );
  const color = baseline.color.clone();
  const warmthOffset = (effectiveMood.warmth - 0.5) * 2 * controls.warmthGain;
  if (warmthOffset > 0) {
    color.lerp(WARM_TINT, MathUtils.clamp(warmthOffset, 0, 1));
  } else if (warmthOffset < 0) {
    color.lerp(COOL_TINT, MathUtils.clamp(-warmthOffset, 0, 1));
  }
  return {
    intensity: baseline.intensity * intensityFactor,
    color,
  };
}

export function LightingMoodDriver({
  registry = getMainLightRegistry(),
  settings = getAttentionLightSettingsStore(),
  store,
}: LightingMoodDriverProps) {
  const mood = useWorkspaceLightingMood();
  const warnedNoLightRef = useRef(false);
  const [controls] = useControls(
    () => ({
      "lighting mood": folder(
        {
          brightnessGain: {
            value: DEFAULT_BRIGHTNESS_GAIN,
            min: 0,
            max: 1,
            step: 0.01,
            label: "brightness gain",
          },
          warmthGain: {
            value: DEFAULT_WARMTH_GAIN,
            min: 0,
            max: 1,
            step: 0.01,
            label: "warmth gain",
          },
          lerpSpeed: {
            value: DEFAULT_LERP_SPEED,
            min: 0.05,
            max: 4,
            step: 0.05,
            label: "lerp speed",
          },
        },
        { collapsed: true },
      ),
    }),
    { store },
    [],
  );

  useFrame((_, delta) => {
    const entries = registry.getEntries();
    if (entries.length === 0) {
      if (import.meta.env.DEV && !warnedNoLightRef.current) {
        warnedNoLightRef.current = true;
        console.warn("[lighting-mood] active scene has no registered main light");
      }
      return;
    }
    const alpha = 1 - Math.exp(-Math.max(0.001, controls.lerpSpeed) * delta);
    const enabled = settings.getEnabled();
    for (const entry of entries) {
      const target = computeMoodLightTarget(entry.baseline, mood, enabled, controls);
      entry.light.intensity = MathUtils.lerp(entry.light.intensity, target.intensity, alpha);
      entry.light.color.lerp(target.color, alpha);
    }
  });

  return null;
}
