export type AttentionTargetKind =
  | "mouse"
  | "input-cursor"
  | "focused-dom"
  | "terminal-region"
  | "mcp-ui";

export interface AttentionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface AttentionTarget {
  readonly kind: AttentionTargetKind;
  readonly source: string;
  readonly rect: AttentionRect;
  readonly confidence: number;
  readonly priority: number;
  readonly timestamp: number;
  readonly reason?: string;
}

export interface AttentionSnapshot {
  readonly target: AttentionTarget | null;
}

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
