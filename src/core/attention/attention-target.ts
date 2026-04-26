/**
 * AttentionTarget の utility 関数群。
 *
 * 型本体（AttentionRect / AttentionTarget / AttentionSnapshot /
 * AttentionTargetKind）は SDK 側 (`src/sdk/attention.d.ts`) を canonical source
 * とする。core はここから re-import するだけ。v1 にあった二重定義（core 側と
 * SDK 側で field 単位重複）の解消。
 */

import type { AttentionRect } from "@charminal/sdk";

export type {
  AttentionRect,
  AttentionSnapshot,
  AttentionTarget,
  AttentionTargetKind,
} from "@charminal/sdk";

export function isValidAttentionRect(rect: AttentionRect): boolean {
  return (
    Number.isFinite(rect.x) &&
    Number.isFinite(rect.y) &&
    Number.isFinite(rect.width) &&
    Number.isFinite(rect.height) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function rectFromDomRect(rect: DOMRectReadOnly): AttentionRect {
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

export function expandRect(rect: AttentionRect, padding: number): AttentionRect {
  return {
    x: rect.x - padding,
    y: rect.y - padding,
    width: rect.width + padding * 2,
    height: rect.height + padding * 2,
  };
}
