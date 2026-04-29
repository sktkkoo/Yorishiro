/**
 * ExpressionManager — VRM expression weight budget management.
 *
 * SDK contract: "全 active expression の weight 合計は 1 を超えない。
 * 超える場合、Body は proportional に scale down する。"
 *
 * Slot は (source, kind) で tag され、複数 source が同時に表情に介入できる
 * mixer として振る舞う。同一 (source, kind) の重複 acquire は前 slot を
 * 自動 release する（per-(source, kind) single-slot enforcement）。
 *
 * This module is pure data logic with no VRM/Three.js dependency,
 * making it fully testable via Vitest.
 */

/**
 * Expression slot を発生させた主体。同一 source 内では (source, kind) ごとに
 * 1 slot のみ持てる。意味的な責任分担を表す tag。
 *
 * - reflex: blink などの反射的・自律的に走る system
 * - persona: PersonaContext の reaction handler
 * - idle: 状態依存の base 表情 / 30s 経過後の relaxed
 * - mcp: MCP tool 経由の外部 source（住人 AI 自身も含む）
 * - thinking: thinking-family state による表情上書き
 * - system: 上記に当てはまらない frame-internal な system 用途
 */
export type ExpressionSource = "reflex" | "persona" | "idle" | "mcp" | "thinking" | "system";

/**
 * Expression slot の論理的 channel。同一 (source, kind) は dedup され、
 * 後勝ちで前 slot を release する。
 *
 * - mood: happy / sad / surprised 等の感情 preset
 * - eye: blink / blinkL / blinkR / lookup / lookdown 等の eyelid・gaze 系
 * - lip: aa / ih / ou / ee / oh の口形素
 * - custom: 上記に当てはまらない blendShape
 */
export type ExpressionKind = "mood" | "eye" | "lip" | "custom";

/** Internal slot tracking a single active expression request. */
interface ExpressionSlot {
  readonly id: number;
  readonly source: ExpressionSource;
  readonly kind: ExpressionKind;
  readonly expressionName: string;
  requestedWeight: number;
  effectiveWeight: number;
}

/** Observability で公開する slot の snapshot 形（read-only）。 */
export interface SlotSnapshot {
  readonly source: ExpressionSource;
  readonly kind: ExpressionKind;
  readonly expressionName: string;
  readonly requestedWeight: number;
  readonly effectiveWeight: number;
}

/**
 * 同 kind 内の source 優先度。数値が大きいほど優先。
 * 同 kind に上位 source がいると下位の effective weight が 0 になる。
 */
const SOURCE_PRIORITY: Record<ExpressionSource, number> = {
  idle: 0,
  thinking: 1,
  persona: 2,
  mcp: 3,
  system: 3,
  reflex: 4,
};

let nextSlotId = 1;

export class ExpressionManager {
  private readonly slots = new Map<number, ExpressionSlot>();

  /**
   * Add an expression slot. Returns a slot ID for later weight adjustment
   * or removal. Triggers immediate weight recomputation.
   *
   * 同一 (source, kind) の slot が既にある場合は、それを release してから
   * 新 slot を追加する（per-(source, kind) single-slot enforcement）。
   * これにより同 source の同 channel は常に最新 1 件のみが active になる。
   */
  addSlot(
    source: ExpressionSource,
    kind: ExpressionKind,
    expressionName: string,
    weight: number,
  ): number {
    // Per-(source, kind) dedup: 既存の同 (source, kind) slot を退避
    for (const [id, slot] of this.slots) {
      if (slot.source === source && slot.kind === kind) {
        this.slots.delete(id);
      }
    }
    const id = nextSlotId++;
    this.slots.set(id, {
      id,
      source,
      kind,
      expressionName,
      requestedWeight: weight,
      effectiveWeight: 0,
    });
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

  /**
   * 現 active な全 slot の snapshot を返す。順序は保証しない。
   * state.get などの observability で使う（住人 AI が自分の感情構成を
   * 観察するための窓口）。
   */
  getSlots(): ReadonlyArray<SlotSnapshot> {
    return Array.from(this.slots.values()).map((s) => ({
      source: s.source,
      kind: s.kind,
      expressionName: s.expressionName,
      requestedWeight: s.requestedWeight,
      effectiveWeight: s.effectiveWeight,
    }));
  }

  /** Number of active slots. */
  get size(): number {
    return this.slots.size;
  }

  /**
   * Recompute effective weights。
   * 1. 同 kind に上位 source がいる slot は suppressed（effective = 0）
   * 2. 残った slot の合計が 1 を超えたら proportional scale-down
   */
  private recompute(): void {
    // kind ごとに最高 priority の source を求める
    const kindTopPriority = new Map<ExpressionKind, number>();
    for (const slot of this.slots.values()) {
      const p = SOURCE_PRIORITY[slot.source];
      const current = kindTopPriority.get(slot.kind) ?? -1;
      if (p > current) kindTopPriority.set(slot.kind, p);
    }

    // suppressed slot を判定しつつ active total を計算
    const suppressed = new Set<number>();
    let total = 0;
    for (const slot of this.slots.values()) {
      const top = kindTopPriority.get(slot.kind) ?? -1;
      if (SOURCE_PRIORITY[slot.source] < top) {
        suppressed.add(slot.id);
        slot.effectiveWeight = 0;
      } else {
        total += slot.requestedWeight;
      }
    }

    const scale = total > 1 ? 1 / total : 1;
    for (const slot of this.slots.values()) {
      if (!suppressed.has(slot.id)) {
        slot.effectiveWeight = slot.requestedWeight * scale;
      }
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
