/**
 * abandoned-factory 全 component が共有する色 / 霧 / flicker / 風の定数.
 *
 * これらは spec §5.1 の illustrative initial values.
 * 最終値は implementation phase で観察 + 調整.
 */

import * as THREE from "three";

export const PALETTE = {
  concreteRoot: new THREE.Color(0.18, 0.2, 0.22),
  concreteMid: new THREE.Color(0.32, 0.34, 0.36),
  concreteWet: new THREE.Color(0.42, 0.46, 0.5),
  mossCool: new THREE.Color(0.3, 0.42, 0.38),
  rustCool: new THREE.Color(0.3, 0.32, 0.3),
  stainGrey: new THREE.Color(0.5, 0.52, 0.54),
  hazeColor: new THREE.Color(0.45, 0.48, 0.52),
  skylight: new THREE.Color(0.62, 0.68, 0.74),
  lantern: new THREE.Color(0.95, 0.62, 0.32),
  crtSignal: new THREE.Color(0.72, 0.82, 0.94),
  electricalGlow: new THREE.Color(0.55, 0.78, 0.96),
} as const;

export const FOG = {
  near: 3.0,
  far: 18.0,
} as const;

export const FLICKER = {
  lantern: { baseHz: 0.7, irregularityNoise: 0.45, dropRate: 0.0008 },
  crt: { baseHz: 12.0, irregularityNoise: 0.25, signalShiftHz: 0.3 },
} as const;
