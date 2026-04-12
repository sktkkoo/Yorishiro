/**
 * ExpressionManager — VRM expression weight budget management.
 *
 * SDK contract: "全 active expression の weight 合計は 1 を超えない。
 * 超える場合、Body は proportional に scale down する。"
 *
 * This module is pure data logic with no VRM/Three.js dependency,
 * making it fully testable via Vitest.
 */

/** Internal slot tracking a single active expression request. */
interface ExpressionSlot {
  readonly id: number;
  readonly expressionName: string;
  requestedWeight: number;
  effectiveWeight: number;
}

let nextSlotId = 1;

export class ExpressionManager {
  private readonly slots = new Map<number, ExpressionSlot>();

  /**
   * Add an expression slot. Returns a slot ID for later weight adjustment
   * or removal. Triggers immediate weight recomputation.
   */
  addSlot(expressionName: string, weight: number): number {
    const id = nextSlotId++;
    this.slots.set(id, { id, expressionName, requestedWeight: weight, effectiveWeight: 0 });
    this.recompute();
    return id;
  }

  /** Update the requested weight of a slot. */
  setWeight(id: number, weight: number): void {
    const slot = this.slots.get(id);
    if (!slot) return;
    slot.requestedWeight = weight;
    this.recompute();
  }

  /** Remove a slot entirely. */
  removeSlot(id: number): void {
    this.slots.delete(id);
    this.recompute();
  }

  /** Get the budget-adjusted effective weight for a slot. */
  getEffectiveWeight(id: number): number {
    return this.slots.get(id)?.effectiveWeight ?? 0;
  }

  /** Get the original requested weight for a slot. */
  getRequestedWeight(id: number): number {
    return this.slots.get(id)?.requestedWeight ?? 0;
  }

  /**
   * Resolve all active slots into a map of expressionName -> total effective weight.
   * This is what Body.update() uses to write to VRM expressionManager.
   */
  getResolved(): Map<string, number> {
    const result = new Map<string, number>();
    for (const slot of this.slots.values()) {
      if (slot.effectiveWeight > 0) {
        result.set(
          slot.expressionName,
          (result.get(slot.expressionName) ?? 0) + slot.effectiveWeight,
        );
      }
    }
    return result;
  }

  /** Number of active slots. */
  get size(): number {
    return this.slots.size;
  }

  /**
   * Recompute effective weights: proportional scale-down when total > 1.
   * When total <= 1, effective = requested.
   */
  private recompute(): void {
    let total = 0;
    for (const slot of this.slots.values()) {
      total += slot.requestedWeight;
    }
    const scale = total > 1 ? 1 / total : 1;
    for (const slot of this.slots.values()) {
      slot.effectiveWeight = slot.requestedWeight * scale;
    }
  }
}

/**
 * Map an SDK ExpressionTarget to the VRM expression name.
 * VRM 1.0 preset names match the SDK's string values directly.
 */
export type ExpressionTargetLike =
  | { kind: "mood"; preset: string }
  | { kind: "eye"; variant: string }
  | { kind: "lip"; phoneme: string }
  | { kind: "custom"; blendShapeName: string };

export function expressionTargetToName(target: ExpressionTargetLike): string {
  switch (target.kind) {
    case "mood":
      return target.preset;
    case "eye":
      return target.variant;
    case "lip":
      return target.phoneme;
    case "custom":
      return target.blendShapeName;
  }
}
