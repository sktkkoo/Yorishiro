import type { BodyResponseParams } from "./types";

/**
 * 控えめに立ち上がり、余韻を残して収束させるための暫定初期値。
 * 実機での帰納調整を前提とし、確定した物理定数として扱わない。
 */
export const TENTATIVE_RESPONSE_DEFAULTS: Readonly<BodyResponseParams> = {
  stiffness: 42,
  damping: 8,
  propagation: 0.58,
  propagationDelay: 0.055,
  recoveryTime: 0.65,
  gain: 0.16,
  energyDecay: 0.9,
  maxDeltaTime: 1 / 30,
  defaultMaxAngleRad: 0.28,
};
