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
 * 部位別表情を author するときの region 識別子。Hana Tool (VRoid) 由来の
 * `Fcl_{BRW|EYE|MTH}_*` morph 体系に対応する。
 */
export type PartRegion = "brow" | "eye" | "mouth";

/**
 * 部位別 emotion 識別子。VRM 0.x 標準 6 group のうち Neutral を除いた 5 種。
 * Hana Tool の `Fcl_{BRW|EYE|MTH}_{Angry|Fun|Joy|Sorrow|Surprised}` に対応。
 */
export type PartEmotion = "angry" | "fun" | "joy" | "sorrow" | "surprised";

/**
 * Expression slot の論理的 channel。同一 (source, kind) は dedup され、
 * 後勝ちで前 slot を release する。
 *
 * - mood: happy / sad / surprised 等の感情 preset（全顔）
 * - eye: blink / blinkL / blinkR / lookup / lookdown 等の eyelid・gaze 系
 * - lip: aa / ih / ou / ee / oh の口形素
 * - part-{brow,eye,mouth}: 部位別 emotion (Fcl_BRW_*, Fcl_EYE_*, Fcl_MTH_*)。
 *   region 別 kind に分けてあるので、同 source から「眉=sorrow / 目=sorrow /
 *   口=sorrow」を同時 author できる
 * - custom: 上記に当てはまらない任意 blendShape の raw 名直叩き
 */
export type ExpressionKind = "mood" | "eye" | "lip" | `part-${PartRegion}` | "custom";

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
  private readonly recomputeKindTopPriority = new Map<ExpressionKind, number>();
  private readonly recomputeSuppressed = new Set<number>();

  /**
   * Add an expression slot. Returns a slot ID for later weight adjustment
   * or removal. Triggers immediate weight recomputation.
   *
   * Dedup rule:
   * - mood / eye / lip / part-{brow,eye,mouth}: 同 (source, kind) で 1 slot のみ。
   *   例えば persona の mood は happy か sad のどちらか 1 つしか持てない（categorical
   *   choice なので）。後勝ちで前 slot を release する。
   * - custom: 同 (source, kind, name) で 1 slot。異なる blendShape 名は別 channel として
   *   並存できる。idle 層の relaxed と microexpression、persona 側の同時 raw morph 駆動
   *   (AU 風合成) を許容する。
   */
  addSlot(
    source: ExpressionSource,
    kind: ExpressionKind,
    expressionName: string,
    weight: number,
  ): number {
    // Dedup: kind:"custom" は name を含む 3-tuple、それ以外は 2-tuple
    for (const [id, slot] of this.slots) {
      if (slot.source !== source || slot.kind !== kind) continue;
      if (kind === "custom" && slot.expressionName !== expressionName) continue;
      this.slots.delete(id);
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
    if (slot.requestedWeight === weight) return;
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
    this.writeResolved(result);
    return result;
  }

  /**
   * Resolve into a caller-owned map. Hot render paths use this to avoid
   * allocating a new Map every frame.
   */
  writeResolved(result: Map<string, number>): void {
    result.clear();
    for (const slot of this.slots.values()) {
      if (slot.effectiveWeight > 0) {
        result.set(
          slot.expressionName,
          (result.get(slot.expressionName) ?? 0) + slot.effectiveWeight,
        );
      }
    }
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

  /**
   * Returns true while a non-idle mood expression is actually affecting the face.
   * Body uses this to suspend idle-only overlays such as relaxed/squint so
   * intentional smiles or frowns do not get diluted by ambient idle expressions.
   */
  hasActiveNonIdleMood(): boolean {
    for (const slot of this.slots.values()) {
      if (
        slot.kind === "mood" &&
        slot.source !== "idle" &&
        slot.requestedWeight > 0 &&
        slot.effectiveWeight > 0
      ) {
        return true;
      }
    }
    return false;
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
    const kindTopPriority = this.recomputeKindTopPriority;
    kindTopPriority.clear();
    for (const slot of this.slots.values()) {
      const p = SOURCE_PRIORITY[slot.source];
      const current = kindTopPriority.get(slot.kind) ?? -1;
      if (p > current) kindTopPriority.set(slot.kind, p);
    }

    // suppressed slot を判定しつつ active total を計算
    const suppressed = this.recomputeSuppressed;
    suppressed.clear();
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
 * ExpressionSinkTracker — 前 frame に書いた expression 名を覚えておき、
 * 今 frame の batch に居ない名前を sink 経由で 0 に戻す責務を持つ。
 *
 * Body.applyExpressions が抱えていた reset bug の対策：旧実装は VRM 1.0
 * preset + visemes を hardcode で 0 reset していたため、`Fcl_BRW_Sorrow`
 * のような custom blendshape は slot release 後も値が lingering していた。
 * Tracker は名前を識別せず last-frame tracking で zeroing するので、
 * VRM preset / viseme / Hana Tool morph / Perfect Sync blendshape を
 * 区別なく扱える。
 *
 * 使い方：
 * ```ts
 * const tracker = new ExpressionSinkTracker();
 * // 毎 frame
 * tracker.apply(resolved, (name, w) => vrm.expressionManager.setValue(name, w));
 * ```
 */
export class ExpressionSinkTracker {
  private lastWritten = new Set<string>();
  private nextWritten = new Set<string>();

  /**
   * Apply `batch` to `sink`, after zeroing any names that were written in
   * the previous apply() call but are not present in this batch.
   */
  apply(batch: ReadonlyMap<string, number>, sink: (name: string, weight: number) => void): void {
    this.nextWritten.clear();
    for (const name of this.lastWritten) {
      if (!batch.has(name)) sink(name, 0);
    }
    for (const [name, weight] of batch) {
      sink(name, weight);
      this.nextWritten.add(name);
    }
    const previous = this.lastWritten;
    this.lastWritten = this.nextWritten;
    this.nextWritten = previous;
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
  | { kind: "part"; region: PartRegion; emotion: PartEmotion }
  | { kind: "custom"; blendShapeName: string };

const PART_REGION_PREFIX: Record<PartRegion, string> = {
  brow: "BRW",
  eye: "EYE",
  mouth: "MTH",
};

const PART_EMOTION_SUFFIX: Record<PartEmotion, string> = {
  angry: "Angry",
  fun: "Fun",
  joy: "Joy",
  sorrow: "Sorrow",
  surprised: "Surprised",
};

export function expressionTargetToName(target: ExpressionTargetLike): string {
  switch (target.kind) {
    case "mood":
      return target.preset;
    case "eye":
      return target.variant;
    case "lip":
      return target.phoneme;
    case "part":
      // 例: { region: "brow", emotion: "sorrow" } -> "Fcl_BRW_Sorrow"
      return `Fcl_${PART_REGION_PREFIX[target.region]}_${PART_EMOTION_SUFFIX[target.emotion]}`;
    case "custom":
      return target.blendShapeName;
  }
}

/**
 * 公開 SDK の ExpressionTarget から内部 ExpressionKind を導出する。
 * kind:"part" は region 別の `part-${region}` kind に展開して、source per kind
 * dedup の対象範囲を絞る（眉と目を同時に書ける）。
 */
export function expressionTargetToKind(target: ExpressionTargetLike): ExpressionKind {
  if (target.kind === "part") return `part-${target.region}`;
  return target.kind;
}
