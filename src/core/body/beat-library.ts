/**
 * Beat ライブラリ — pose beat 定義と state 別 profile。
 * 各 keyframe 値は帰納調整の出発点。
 * Internal design-record: 2026-06-17-motion-aliveness-research.md
 *
 * staging: 1 beat = 1 主役。gaze 主役 beat に spine anticipation は付けない。
 * anticipation: spine/head/posture 主役の beat は key の ~30% の逆溜めを at:0 に持つ。
 */

import type { BeatDef, BeatProfileMap } from "./beat-types";

// ── idle ────────────────────────────────────────────────
export const quickGlance: BeatDef = {
  name: "quick-glance",
  cooldown: 3,
  weight: "light",
  keyframes: [
    {
      at: 0,
      pose: {
        gaze: {
          get yaw() {
            return (Math.random() - 0.5) * 0.12;
          },
          get pitch() {
            return (Math.random() - 0.5) * 0.04;
          },
          durationS: 0.6,
        },
      },
    },
  ],
};

export const posturePop: BeatDef = {
  name: "posture-pop",
  cooldown: 8,
  weight: "heavy",
  keyframes: [
    { at: 0, pose: { spine: { z: -0.003, durationS: 0.08 } } }, // anticipation
    { at: 0.07, pose: { spine: { z: 0.012, durationS: 0.4 } } }, // key
  ],
  secondaryActions: [{ at: 0.07, fire: (target) => target.requestBlink() }],
};

export const microNod: BeatDef = {
  name: "micro-nod",
  cooldown: 5,
  weight: "medium",
  keyframes: [
    { at: 0, pose: { spine: { x: 0.0025, durationS: 0.08 } } }, // anticipation(逆溜め)
    { at: 0.07, pose: { spine: { x: -0.008, durationS: 0.25 } } }, // key(頷き down)
  ],
};

// 凝視しっぱなしを避ける、短い親密度調整そらし。
export const idleAversion: BeatDef = {
  name: "idle-aversion",
  cooldown: 10,
  weight: "light",
  keyframes: [
    {
      at: 0,
      pose: {
        gaze: {
          get yaw() {
            return (Math.random() < 0.5 ? -1 : 1) * (0.1 + Math.random() * 0.05);
          },
          pitch: 0,
          durationS: 1.5,
        },
      },
    },
  ],
};

// ── thinking ────────────────────────────────────────────
export const headTilt: BeatDef = {
  name: "head-tilt",
  cooldown: 4,
  weight: "light",
  keyframes: [
    // head roll(spine.z で上体ごと軽く傾く近似) + 視線が同方向に少し連れる(arc)
    { at: 0, pose: { spine: { z: 0.022, durationS: 1.2 } } },
    { at: 0, pose: { gaze: { yaw: 0.04, pitch: -0.03, durationS: 1.2 } } },
  ],
};

// 考え中の長い視線そらし(thinking presence の核)。上優位。
export const cognitiveAversion: BeatDef = {
  name: "cognitive-aversion",
  cooldown: 9,
  weight: "medium",
  keyframes: [
    {
      at: 0,
      pose: {
        gaze: {
          get yaw() {
            const r = Math.random();
            return r < 0.31 ? (Math.random() < 0.5 ? -0.12 : 0.12) : (Math.random() - 0.5) * 0.06;
          },
          get pitch() {
            const r = Math.random();
            return r < 0.39
              ? -(0.05 + Math.random() * 0.05)
              : r < 0.68
                ? 0.03 + Math.random() * 0.03
                : -0.01;
          },
          durationS: 3.2,
        },
      },
    },
  ],
};

export const thinkingSigh: BeatDef = {
  name: "thinking-sigh",
  cooldown: 25,
  weight: "medium",
  keyframes: [{ at: 0, pose: { posture: { leanZ: -0.005, durationS: 2.0 } } }],
  secondaryActions: [{ at: 0.5, fire: (target) => target.triggerDeepBreath() }],
};

// ── reading / writing / running ─────────────────────────
export const scanGlance: BeatDef = {
  name: "scan-glance",
  cooldown: 3,
  weight: "light",
  keyframes: [
    {
      at: 0,
      pose: {
        gaze: {
          get yaw() {
            return (Math.random() - 0.5) * 0.04;
          },
          pitch: -0.01,
          durationS: 0.8,
        },
      },
    },
  ],
};

export const postureSettle: BeatDef = {
  name: "posture-settle",
  cooldown: 15,
  weight: "light",
  keyframes: [
    {
      at: 0,
      pose: {
        posture: {
          get leanZ() {
            return (Math.random() - 0.5) * 0.006;
          },
          durationS: 1.5,
        },
      },
    },
  ],
};

export const runningGlance: BeatDef = {
  name: "running-glance",
  cooldown: 4,
  weight: "light",
  keyframes: [
    {
      at: 0,
      pose: {
        gaze: {
          get yaw() {
            return (Math.random() - 0.5) * 0.08;
          },
          pitch: 0,
          durationS: 0.5,
        },
      },
    },
  ],
};

// ── profiles ────────────────────────────────────────────
export const defaultProfiles: BeatProfileMap = {
  idle: {
    beats: [quickGlance, posturePop, microNod, idleAversion],
    baseInterval: 10,
    scaleWithIntensity: true,
  },
  thinking: {
    beats: [headTilt, cognitiveAversion, microNod, thinkingSigh],
    baseInterval: 5,
    scaleWithIntensity: false,
  },
  reading: {
    beats: [scanGlance, microNod],
    baseInterval: 7,
    scaleWithIntensity: false,
  },
  writing: {
    beats: [postureSettle],
    baseInterval: 20,
    scaleWithIntensity: false,
  },
  running: {
    beats: [runningGlance],
    baseInterval: 8,
    scaleWithIntensity: false,
  },
};
