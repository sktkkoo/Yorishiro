/**
 * Aura の見た目を decide する pure 関数群。
 *
 * - `targetOpacity(target)`: kind ごとの base opacity に reasonBoost と
 *   confidence を掛けた値。confidence は [0, 1] にクランプ。
 * - `auraVisualForTarget(input)`: kind / reason ごとに blur radius /
 *   spread / borderRadius / background gradient / boxShadow を返す。
 *
 * v1 の visual fidelity を復元: mixBlendMode: "screen" + filter: blur(px) の
 * 組み合わせを前提とした glow intensity で gradient / spread を設定している。
 * container は spread 込みで rect を拡張して描画すること (ui.tsx 参照)。
 *
 * 意図的な v1 との差異:
 * - recent-output: v2 では emit されないため visual entry なし
 *   (decision: docs/decisions/semantic-priority-attention.md)
 * - focused-dom: SDK AttentionTargetKind に追加済み、producer も復元済み（B6）。
 */

import type { AttentionTarget, AttentionTargetKind } from "@charminal/sdk";

/** kind ごとの base opacity。v1 から復元。 */
const TARGET_BASE_OPACITY: Record<AttentionTargetKind, number> = {
  mouse: 0.36,
  "input-cursor": 0.42,
  "terminal-region": 0.38,
  "mcp-ui": 0.4,
  "focused-dom": 0.32,
};

/**
 * reason による opacity 倍率。v1 から復元。
 * - approval-required / error / diagnostic: 1.18 倍 (注意喚起)
 * - file-link: 1.08 倍 (軽微な強調)
 * - その他: 1.0 (そのまま)
 */
function reasonBoost(reason: string | undefined): number {
  if (reason === "approval-required" || reason === "error" || reason === "diagnostic") {
    return 1.18;
  }
  if (reason === "file-link") {
    return 1.08;
  }
  return 1.0;
}

export function targetOpacity(target: AttentionTarget | null): number {
  if (target === null) return 0;
  const base = TARGET_BASE_OPACITY[target.kind] ?? 0.36;
  const confidence = Math.max(0, Math.min(1, target.confidence));
  return base * reasonBoost(target.reason) * confidence;
}

/**
 * auraVisualForTarget に渡す入力。
 */
export interface AuraVisualInput {
  readonly kind: AttentionTargetKind | string;
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

export function auraBorderRadiusForTarget(input: AuraVisualInput): number {
  const baseRadius = Math.min(12, Math.max(4, Math.min(input.width, input.height) / 2));

  if (input.kind === "focused-dom") {
    return Math.min(10, Math.max(5, baseRadius));
  }

  if (input.kind === "mcp-ui") {
    return Math.min(12, Math.max(6, baseRadius));
  }

  if (
    input.reason === "tool-reading" ||
    input.reason === "tool-writing" ||
    input.reason === "tool-running"
  ) {
    return Math.min(12, Math.max(5, baseRadius));
  }

  if (input.reason === "approval-required") {
    return Math.min(12, Math.max(6, baseRadius));
  }

  if (input.reason === "error" || input.reason === "diagnostic") {
    return Math.min(10, Math.max(4, baseRadius));
  }

  if (
    input.reason === "search-match" ||
    input.reason === "selection" ||
    input.reason === "file-link"
  ) {
    return Math.min(8, Math.max(3, baseRadius));
  }

  return baseRadius;
}

/**
 * kind / reason の組み合わせに応じた aura visual style を返す。
 *
 * 優先順位:
 *   1. terminal-region の reason override (tool-reading, tool-writing, tool-running,
 *      approval-required, error, diagnostic, file-link, search-match)
 *   2. kind ベースのスタイル (input-cursor, focused-dom, mcp-ui, terminal-region default, mouse)
 */
export function auraVisualForTarget(input: AuraVisualInput): AuraVisualStyle {
  const borderRadius = auraBorderRadiusForTarget(input);

  // ── input-cursor ────────────────────────────────────────────────────────────

  if (input.kind === "input-cursor") {
    // typing / cursor 状態。v1 から復元。
    return {
      blur: 10,
      spread: 26,
      borderRadius,
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.7) 0%, rgba(255, 255, 255, 0.48) 24%, rgba(242, 247, 255, 0.22) 54%, rgba(242, 247, 255, 0) 100%)",
      boxShadow:
        "0 0 16px rgba(255, 255, 255, 0.38), 0 0 34px rgba(242, 247, 255, 0.28), 0 0 64px rgba(242, 247, 255, 0.16)",
    };
  }

  // ── focused-dom ──────────────────────────────────────────────────────────────

  if (input.kind === "focused-dom") {
    return {
      blur: 8,
      spread: 18,
      borderRadius,
      background:
        "radial-gradient(ellipse at 50% 50%, rgba(255, 255, 255, 0.34) 0%, rgba(225, 246, 255, 0.24) 42%, rgba(225, 246, 255, 0.08) 74%, rgba(225, 246, 255, 0) 100%)",
      boxShadow: "0 0 12px rgba(255, 255, 255, 0.26), 0 0 24px rgba(225, 246, 255, 0.2)",
    };
  }

  // ── mcp-ui ───────────────────────────────────────────────────────────────────

  if (input.kind === "mcp-ui") {
    return {
      blur: 12,
      spread: 28,
      borderRadius,
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.56) 0%, rgba(218, 244, 255, 0.36) 34%, rgba(154, 223, 255, 0.12) 72%, rgba(154, 223, 255, 0) 100%)",
      boxShadow:
        "0 0 16px rgba(255, 255, 255, 0.28), 0 0 36px rgba(160, 226, 255, 0.24), 0 0 68px rgba(160, 226, 255, 0.12)",
    };
  }

  // ── terminal-region の reason override ───────────────────────────────────────

  if (
    input.reason === "tool-reading" ||
    input.reason === "tool-writing" ||
    input.reason === "tool-running"
  ) {
    const running = input.reason === "tool-running";
    const writing = input.reason === "tool-writing";
    return {
      blur: running ? 14 : 10,
      spread: running ? 34 : 24,
      borderRadius,
      background: writing
        ? "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.54) 0%, rgba(232, 255, 218, 0.34) 36%, rgba(164, 240, 148, 0.1) 72%, rgba(164, 240, 148, 0) 100%)"
        : "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.52) 0%, rgba(218, 244, 255, 0.34) 36%, rgba(148, 216, 240, 0.1) 72%, rgba(148, 216, 240, 0) 100%)",
      boxShadow: running
        ? "0 0 16px rgba(255, 255, 255, 0.28), 0 0 42px rgba(255, 218, 160, 0.22)"
        : "0 0 14px rgba(255, 255, 255, 0.24), 0 0 30px rgba(190, 240, 230, 0.2)",
    };
  }

  if (input.reason === "approval-required") {
    return {
      blur: 14,
      spread: 30,
      borderRadius,
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.68) 0%, rgba(255, 244, 216, 0.42) 34%, rgba(255, 214, 150, 0.16) 68%, rgba(255, 214, 150, 0) 100%)",
      boxShadow:
        "0 0 18px rgba(255, 255, 255, 0.34), 0 0 42px rgba(255, 218, 160, 0.3), 0 0 76px rgba(255, 218, 160, 0.16)",
    };
  }

  if (input.reason === "error" || input.reason === "diagnostic") {
    return {
      blur: 12,
      spread: 20,
      borderRadius,
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.58) 0%, rgba(255, 225, 218, 0.34) 36%, rgba(255, 142, 120, 0.14) 72%, rgba(255, 142, 120, 0) 100%)",
      boxShadow: "0 0 16px rgba(255, 255, 255, 0.3), 0 0 38px rgba(255, 150, 128, 0.26)",
    };
  }

  if (
    input.reason === "search-match" ||
    input.reason === "selection" ||
    input.reason === "file-link"
  ) {
    return {
      blur: 6,
      spread: 12,
      borderRadius,
      background:
        "radial-gradient(ellipse at 50% 50%, rgba(255, 255, 255, 0.44) 0%, rgba(210, 248, 239, 0.3) 38%, rgba(210, 248, 239, 0.08) 78%, rgba(210, 248, 239, 0) 100%)",
      boxShadow: "0 0 10px rgba(255, 255, 255, 0.26), 0 0 22px rgba(210, 248, 239, 0.22)",
    };
  }

  // ── terminal-region default (reason なし / 上記以外) ─────────────────────────

  if (input.kind === "terminal-region") {
    return {
      blur: 10,
      spread: 20,
      borderRadius,
      background:
        "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.46) 0%, rgba(242, 247, 255, 0.28) 36%, rgba(242, 247, 255, 0.08) 72%, rgba(242, 247, 255, 0) 100%)",
      boxShadow: "0 0 12px rgba(255, 255, 255, 0.28), 0 0 24px rgba(242, 247, 255, 0.2)",
    };
  }

  // ── mouse (default fallback) ─────────────────────────────────────────────────

  return {
    blur: 16,
    spread: 38,
    borderRadius,
    background:
      "radial-gradient(ellipse at 50% 45%, rgba(255, 255, 255, 0.66) 0%, rgba(255, 255, 255, 0.48) 22%, rgba(242, 247, 255, 0.26) 50%, rgba(242, 247, 255, 0.06) 78%, rgba(242, 247, 255, 0) 100%)",
    boxShadow:
      "0 0 18px rgba(255, 255, 255, 0.38), 0 0 38px rgba(242, 247, 255, 0.3), 0 0 72px rgba(242, 247, 255, 0.18)",
  };
}
