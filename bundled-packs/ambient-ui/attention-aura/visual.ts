/**
 * Aura の見た目を decide する pure 関数群。
 *
 * - `targetOpacity(target)`: kind ごとの base opacity に confidence を掛けた値。
 *   confidence は [0, 1] にクランプ。
 * - `auraVisualForTarget(input)`: kind / reason ごとに blur radius (box-shadow 用) /
 *   spread / borderRadius / background gradient / boxShadow を返す。
 *
 * v1 では filter: blur を使っていたが GPU composite layer 全体に bloom を
 * かけるコストが高いため、v2 では box-shadow の blur radius と radial-gradient で
 * glow を表現する。
 */

import type { AttentionTarget, AttentionTargetKind } from "@charminal/sdk";

const TARGET_BASE_OPACITY: Record<AttentionTargetKind, number> = {
  mouse: 0.36,
  "input-cursor": 0.42,
  "terminal-region": 0.38,
  "mcp-ui": 0.4,
};

export function targetOpacity(target: AttentionTarget | null): number {
  if (target === null) return 0;
  const base = TARGET_BASE_OPACITY[target.kind];
  const confidence = Math.max(0, Math.min(1, target.confidence));
  return base * confidence;
}

export interface AuraVisualInput {
  readonly kind: AttentionTargetKind;
  readonly reason: string | undefined;
  readonly width: number;
  readonly height: number;
}

export interface AuraVisualStyle {
  readonly blur: number;
  readonly spread: number;
  readonly borderRadius: number;
  readonly background: string;
  readonly boxShadow: string;
}

export function auraVisualForTarget(input: AuraVisualInput): AuraVisualStyle {
  const baseRadius = Math.min(12, Math.max(4, Math.min(input.width, input.height) / 2));

  if (input.kind === "input-cursor") {
    return {
      blur: 10,
      spread: 18,
      borderRadius: baseRadius,
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.7) 0%, rgba(255, 255, 255, 0.48) 24%, rgba(242, 247, 255, 0.22) 54%, rgba(242, 247, 255, 0) 100%)",
      boxShadow: "0 0 12px rgba(255, 255, 255, 0.38), 0 0 24px rgba(242, 247, 255, 0.28)",
    };
  }
  if (input.kind === "mcp-ui") {
    return {
      blur: 12,
      spread: 24,
      borderRadius: Math.min(12, Math.max(6, baseRadius)),
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.56) 0%, rgba(218, 244, 255, 0.36) 34%, rgba(154, 223, 255, 0.12) 72%, rgba(154, 223, 255, 0) 100%)",
      boxShadow: "0 0 16px rgba(255, 255, 255, 0.28), 0 0 36px rgba(160, 226, 255, 0.24)",
    };
  }
  if (input.kind === "terminal-region") {
    if (input.reason === "diagnostic") {
      return {
        blur: 14,
        spread: 32,
        borderRadius: baseRadius,
        background:
          "radial-gradient(ellipse at 50% 45%, rgba(255, 220, 200, 0.62) 0%, rgba(255, 180, 160, 0.36) 36%, rgba(255, 140, 130, 0.1) 72%, rgba(255, 140, 130, 0) 100%)",
        boxShadow: "0 0 16px rgba(255, 220, 200, 0.36), 0 0 42px rgba(255, 180, 160, 0.24)",
      };
    }
    if (input.reason === "file-link") {
      return {
        blur: 12,
        spread: 24,
        borderRadius: baseRadius,
        background:
          "radial-gradient(ellipse at 50% 45%, rgba(218, 244, 255, 0.5) 0%, rgba(180, 220, 255, 0.32) 36%, rgba(180, 220, 255, 0.08) 72%, rgba(180, 220, 255, 0) 100%)",
        boxShadow: "0 0 14px rgba(218, 244, 255, 0.32), 0 0 30px rgba(180, 220, 255, 0.22)",
      };
    }
    return {
      blur: 10,
      spread: 20,
      borderRadius: baseRadius,
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.46) 0%, rgba(242, 247, 255, 0.28) 36%, rgba(242, 247, 255, 0.08) 72%, rgba(242, 247, 255, 0) 100%)",
      boxShadow: "0 0 12px rgba(255, 255, 255, 0.28), 0 0 24px rgba(242, 247, 255, 0.2)",
    };
  }
  // mouse (default)
  return {
    blur: 16,
    spread: 28,
    borderRadius: baseRadius,
    background:
      "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.66) 0%, rgba(255, 255, 255, 0.48) 22%, rgba(242, 247, 255, 0.26) 50%, rgba(242, 247, 255, 0.06) 78%, rgba(242, 247, 255, 0) 100%)",
    boxShadow: "0 0 18px rgba(255, 255, 255, 0.38), 0 0 38px rgba(242, 247, 255, 0.3)",
  };
}
