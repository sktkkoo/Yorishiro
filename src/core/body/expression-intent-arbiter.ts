/**
 * ExpressionIntentArbiter — 表情 intent の admission / suppression を決める
 * policy boundary。
 *
 * ここは mixer ではない：morph weight の加算・global budget scale・VRM への
 * write は一切行わず、intent を admitted / suppressed に分類して reason を
 * 説明するだけ。concrete な weight 合成は ExpressionManager が唯一の
 * numeric mixer として担う（decision doc §1）。
 *
 * - acquire / update / release と stale owner protection（generation）
 * - region + function lane の overlap 判定（policy table は
 *   expression-intent-policy.ts が正本）
 * - same-owner replacement（replacementKey）、pulse / held / release envelope
 * - admitted / suppressed と machine-readable reason の snapshot
 * - ambient variation の category 制約 enforce
 *
 * 設計正本: docs/decisions/expression-intent-arbitration.md §1, §4, §5, §6
 */

import type {
  AdmittedExpressionIntent,
  ExpressionArbitrationSnapshot,
  ExpressionIntent,
  ExpressionIntentHandle,
  ExpressionIntentPhase,
  ExpressionIntentReason,
  ExpressionIntentRequest,
  ExpressionIntentSnapshotEntry,
} from "./expression-intent";
import {
  deriveExpressionPriorityClass,
  derivePhysiologyPrecedence,
  EXPRESSION_PRIORITY_CLASS_RANK,
  type ExpressionPriorityClass,
  findAmbientPolicyViolation,
  isExclusiveCategoricalPair,
} from "./expression-intent-policy";

/** domain claim を snapshot の suppressedBy に出すときの識別子。 */
export const EXPRESSION_DOMAIN_CLAIM_ID = "claim:expression";

/** hot path で使い回す admitted view の mutable 実体。 */
interface MutableAdmittedView {
  intentId: string;
  source: ExpressionIntent["source"];
  semantic: ExpressionIntent["semantic"];
  occupancy: ExpressionIntent["occupancy"];
  effectiveIntensity: number;
}

/** intent 1 件分の内部 record。ExpressionIntent 互換 shape を直接持つ。 */
interface IntentRecord extends ExpressionIntent {
  intensity: number;
  readonly sequence: number;
  readonly priorityClass: ExpressionPriorityClass;
  readonly rank: number;
  readonly physiologyPrecedence: number;
  readonly ambientViolation: boolean;

  /** attack / release envelope の現在値 [0, 1]。 */
  envelope: number;
  releasing: boolean;
  /** release の発端（released = 明示 release / expired = pulse TTL）。 */
  releaseReason: ExpressionIntentReason | null;
  expired: boolean;
  /** expired を snapshot に 1 update 残してから purge するための arm。 */
  purgeArmed: boolean;
  /** pulse lifecycle の残り時間。held では null。 */
  pulseRemainingMs: number | null;

  reason: ExpressionIntentReason | null;
  suppressedBy: string | null;
  admitted: boolean;
  blended: boolean;

  readonly view: MutableAdmittedView;
}

/** replacementKey index の entry。record 消滅後も generation 記憶を残す。 */
interface ReplacementEntry {
  intentId: string | null;
  lastGeneration: number | undefined;
}

/** stale acquire（古い generation の再取得）に返す不活性 handle。 */
const INERT_HANDLE: ExpressionIntentHandle = {
  intentId: "stale",
  isAlive: false,
  updateIntensity: () => {},
  release: () => {},
};

export class ExpressionIntentArbiter {
  private readonly records = new Map<string, IntentRecord>();
  private readonly replacementIndex = new Map<string, ReplacementEntry>();
  private nextIntentNumber = 1;
  private nextSequence = 1;
  private domainClaimed = false;
  private admissionDirty = true;
  /** recompute 用 scratch。毎 frame の allocation を避ける。 */
  private readonly candidateScratch: IntentRecord[] = [];
  private readonly admittedScratch: IntentRecord[] = [];

  /**
   * intent を submit する。admission は宣言的 policy が決めるため、返る
   * handle は「admit された保証」ではない（結果は snapshot で観察する）。
   */
  acquire(request: ExpressionIntentRequest): ExpressionIntentHandle {
    const replacementKey = this.replacementKeyOf(request);
    if (replacementKey !== null) {
      const entry = this.replacementIndex.get(replacementKey);
      if (
        entry &&
        entry.lastGeneration !== undefined &&
        request.owner.generation !== undefined &&
        request.owner.generation < entry.lastGeneration
      ) {
        // 古い generation からの遅延 acquire は replacement intent を変更できない
        return INERT_HANDLE;
      }
      const existingId = entry?.intentId;
      const existing = existingId ? this.records.get(existingId) : undefined;
      if (existing && !existing.expired) {
        this.markExpired(existing, "replaced-same-owner");
      }
    }

    const intentId = `expr-intent-${this.nextIntentNumber++}`;
    const violation = findAmbientPolicyViolation(request);
    const attackMs = request.lifecycle.attackMs ?? 0;
    const record: IntentRecord = {
      intentId,
      owner: request.owner,
      source: request.source,
      semantic: request.semantic,
      occupancy: request.occupancy,
      salience: request.salience,
      intensity: request.intensity,
      lifecycle: request.lifecycle,
      sequence: this.nextSequence++,
      priorityClass: deriveExpressionPriorityClass(request.source, request.semantic),
      rank: EXPRESSION_PRIORITY_CLASS_RANK[
        deriveExpressionPriorityClass(request.source, request.semantic)
      ],
      physiologyPrecedence: derivePhysiologyPrecedence(request.source, request.semantic),
      ambientViolation: violation !== null,
      envelope: attackMs > 0 ? 0 : 1,
      releasing: false,
      releaseReason: null,
      expired: false,
      purgeArmed: false,
      pulseRemainingMs: request.lifecycle.kind === "pulse" ? request.lifecycle.durationMs : null,
      reason: violation !== null ? "ambient-policy-rejected" : null,
      suppressedBy: null,
      admitted: false,
      blended: false,
      view: {
        intentId,
        source: request.source,
        semantic: request.semantic,
        occupancy: request.occupancy,
        effectiveIntensity: 0,
      },
    };
    this.records.set(intentId, record);
    if (replacementKey !== null) {
      this.replacementIndex.set(replacementKey, {
        intentId,
        lastGeneration: request.owner.generation,
      });
    }
    this.admissionDirty = true;

    return {
      intentId,
      get isAlive() {
        return !record.expired;
      },
      updateIntensity: (intensity: number) => {
        if (record.expired) return;
        record.intensity = intensity;
      },
      release: () => {
        if (record.expired || record.releasing) return;
        this.beginRelease(record, "released");
      },
    };
  }

  /**
   * ClaimState.expression の claim を context input として受ける。claim 中は
   * 全 intent を silent に消すのではなく `domain-claimed` reason で suppress
   * する（decision doc §4）。
   */
  setDomainClaimed(claimed: boolean): void {
    if (this.domainClaimed === claimed) return;
    this.domainClaimed = claimed;
    this.admissionDirty = true;
  }

  /**
   * envelope / lifecycle を deltaS 秒ぶん進める。clock は caller（Body の
   * frame delta / test の手動刻み）が注入する。
   */
  update(deltaS: number): void {
    const deltaMs = Math.max(0, deltaS) * 1000;
    for (const record of this.records.values()) {
      if (record.expired) {
        if (record.purgeArmed) {
          this.records.delete(record.intentId);
          const key = this.replacementKeyOf(record);
          if (key !== null) {
            const entry = this.replacementIndex.get(key);
            if (entry && entry.intentId === record.intentId) entry.intentId = null;
          }
        } else {
          record.purgeArmed = true;
        }
        continue;
      }
      if (!record.releasing) {
        const attackMs = record.lifecycle.attackMs ?? 0;
        if (record.envelope < 1) {
          record.envelope = attackMs > 0 ? Math.min(1, record.envelope + deltaMs / attackMs) : 1;
        }
        if (record.pulseRemainingMs !== null) {
          record.pulseRemainingMs -= deltaMs;
          if (record.pulseRemainingMs <= 0) {
            this.beginRelease(record, "expired");
          }
        }
      } else {
        const releaseMs = record.lifecycle.releaseMs ?? 0;
        record.envelope = releaseMs > 0 ? Math.max(0, record.envelope - deltaMs / releaseMs) : 0;
        if (record.envelope <= 0) {
          this.markExpired(record, record.reason ?? "released");
        }
      }
    }
  }

  /**
   * admitted intent を caller-owned 配列へ書く。resolver / slot bridge 用の
   * hot path で、entry object は内部再利用のため保持し続けてはならない。
   */
  writeAdmitted(out: AdmittedExpressionIntent[]): AdmittedExpressionIntent[] {
    this.recomputeIfDirty();
    out.length = 0;
    for (const record of this.records.values()) {
      if (!record.admitted || record.expired) continue;
      record.view.effectiveIntensity = record.intensity * record.envelope;
      out.push(record.view);
    }
    return out;
  }

  /**
   * slot bridge 用の互換 view（#83 M5）。admitted intent は envelope 済み
   * 強度、policy 上 suppress された intent は強度 0 で出力する。
   *
   * legacy ExpressionManager では上位 source に抑止された slot は
   * 「effective 0 のまま残る」観察（state.get の slot view）だったため、
   * arbiter の suppress も slot 撤去ではなく weight 0 の contribution として
   * mixer へ届け、互換の slot view を維持する。ambient guard 違反と expired
   * は含めない。
   */
  writeSlotContributions(out: AdmittedExpressionIntent[]): AdmittedExpressionIntent[] {
    this.recomputeIfDirty();
    out.length = 0;
    for (const record of this.records.values()) {
      if (record.expired || record.ambientViolation) continue;
      record.view.effectiveIntensity = record.admitted ? record.intensity * record.envelope : 0;
      out.push(record.view);
    }
    return out;
  }

  /** admitted intent の新規配列を返す（テスト / 非 hot path 用）。 */
  getAdmitted(): AdmittedExpressionIntent[] {
    const out: AdmittedExpressionIntent[] = [];
    this.writeAdmitted(out);
    return out.map((view) => ({ ...view }));
  }

  /** reason 付き snapshot。要求時のみ allocate する。 */
  getSnapshot(): ExpressionArbitrationSnapshot {
    this.recomputeIfDirty();
    const intents: ExpressionIntentSnapshotEntry[] = [];
    for (const record of this.records.values()) {
      intents.push({
        intentId: record.intentId,
        owner: record.owner,
        source: record.source,
        semantic: record.semantic,
        occupancy: record.occupancy,
        salience: record.salience,
        requestedIntensity: record.intensity,
        effectiveIntensity: record.admitted ? record.intensity * record.envelope : 0,
        phase: this.phaseOf(record),
        reason: record.reason,
        suppressedBy: record.suppressedBy,
      });
    }
    return { intents };
  }

  /** 現在生きている（expired でない）intent 数。テスト・debug 用。 */
  get size(): number {
    let count = 0;
    for (const record of this.records.values()) {
      if (!record.expired) count++;
    }
    return count;
  }

  /**
   * 全 owner を即時失効させる。Body.dispose() 専用。
   * record を expired にしてから map を空にするため、外部に残った古い handle の
   * update / release closure も以後 no-op になる。
   */
  clear(): void {
    for (const record of this.records.values()) {
      record.expired = true;
      record.admitted = false;
      record.envelope = 0;
      record.reason = "released";
    }
    this.records.clear();
    this.replacementIndex.clear();
    this.candidateScratch.length = 0;
    this.admittedScratch.length = 0;
    this.domainClaimed = false;
    this.admissionDirty = true;
  }

  // ─── internal ─────────────────────────────────────────

  private replacementKeyOf(intent: { readonly owner: ExpressionIntent["owner"] }): string | null {
    const key = intent.owner.replacementKey;
    if (key === undefined) return null;
    return `${intent.owner.producerId} ${key}`;
  }

  private beginRelease(record: IntentRecord, reason: ExpressionIntentReason): void {
    record.releasing = true;
    record.releaseReason = reason;
    // ambient guard で拒否された intent も lifecycle は進めるが、debug view
    // では「なぜ出力されなかったか」を terminal reason より優先して残す。
    record.reason = record.ambientViolation ? "ambient-policy-rejected" : reason;
    const releaseMs = record.lifecycle.releaseMs ?? 0;
    if (releaseMs <= 0 || record.envelope <= 0) {
      this.markExpired(record, reason);
    }
  }

  private markExpired(record: IntentRecord, reason: ExpressionIntentReason): void {
    record.expired = true;
    record.releasing = true;
    record.envelope = 0;
    record.reason = record.ambientViolation ? "ambient-policy-rejected" : reason;
    record.admitted = false;
    this.admissionDirty = true;
  }

  private phaseOf(record: IntentRecord): ExpressionIntentPhase {
    if (record.expired) return "expired";
    // domain claim 中は（policy 上 admit されていても）出力は VRM に届かない
    // ため、観察上は suppressed として説明する
    if (this.domainClaimed && !record.ambientViolation) return "suppressed";
    if (!record.admitted) return "suppressed";
    if (record.releasing) return "releasing";
    return record.blended ? "blended" : "active";
  }

  private recomputeIfDirty(): void {
    if (!this.admissionDirty) return;
    this.admissionDirty = false;

    const candidates = this.candidateScratch;
    candidates.length = 0;
    for (const record of this.records.values()) {
      if (record.expired) continue;
      record.admitted = false;
      record.blended = false;
      if (record.ambientViolation) {
        record.reason = "ambient-policy-rejected";
        record.suppressedBy = null;
        continue;
      }
      // releasing の reason（released / expired）は releaseReason から復元し、
      // 前回 recompute の suppress reason を持ち越さない
      record.reason = record.releasing ? record.releaseReason : null;
      record.suppressedBy = null;
      candidates.push(record);
    }

    // rank 降順 → sequence 降順（新しい intent から admit を試みる）で処理。
    // greedy admit + 後着上位による退去（physiology precedence が class rank と
    // 逆転するケース：explicit eyelid action が先着 admitted の auto blink を
    // 蹴り出す）を 1 pass で扱う。
    candidates.sort((a, b) => b.rank - a.rank || b.sequence - a.sequence);

    const admitted = this.admittedScratch;
    admitted.length = 0;
    for (const candidate of candidates) {
      let blockedBy: IntentRecord | null = null;
      let blockKind: "rank" | "tie" = "rank";
      for (const winner of admitted) {
        const verdict = this.beats(winner, candidate);
        if (verdict !== null) {
          blockedBy = winner;
          blockKind = verdict;
          break;
        }
      }
      if (blockedBy !== null) {
        this.suppress(candidate, blockedBy, blockKind);
        continue;
      }
      // candidate が admitted 内の下位を蹴り出すケース（lane 内 precedence 逆転）
      for (let i = admitted.length - 1; i >= 0; i--) {
        const other = admitted[i];
        if (!other) continue;
        const verdict = this.beats(candidate, other);
        if (verdict !== null) {
          this.suppress(other, candidate, verdict);
          admitted.splice(i, 1);
        }
      }
      candidate.admitted = true;
      admitted.push(candidate);
    }

    // blended 判定：admitted 同士で occupancy が重なる pair は blended
    for (let i = 0; i < admitted.length; i++) {
      const a = admitted[i];
      if (!a) continue;
      for (let j = i + 1; j < admitted.length; j++) {
        const b = admitted[j];
        if (!b) continue;
        if (this.hasConflictingOverlap(a, b)) {
          a.blended = true;
          b.blended = true;
        }
      }
    }

    // domain claim overlay：admission（= manager slot 互換層への出力）は保った
    // まま、観察上は domain-claimed として説明する。実効的な出力停止は
    // apply 層（Body の claim guard）が担う — legacy の「claim 中も slot は
    // 据え置かれ、VRM 書き込みだけ止まる」挙動と互換を保つため、arbiter は
    // ここで intent を silent に落とさない（decision doc §4）。
    if (this.domainClaimed) {
      for (const record of candidates) {
        record.reason = "domain-claimed";
        record.suppressedBy = EXPRESSION_DOMAIN_CLAIM_ID;
      }
    }
  }

  private suppress(loser: IntentRecord, winner: IntentRecord, kind: "rank" | "tie"): void {
    loser.admitted = false;
    loser.suppressedBy = winner.intentId;
    if (kind === "tie") {
      loser.reason = "exclusive-tie-lost";
    } else if (loser.priorityClass === "ambient-baseline") {
      loser.reason = "ambient-suspended-by-grounded";
    } else {
      loser.reason = "lower-priority-overlap";
    }
  }

  /**
   * a が b に勝つか。全 overlap (region, lane) を見て、a がどこかで勝ち、
   * どこでも負けていなければ勝ち。exclusive tie の勝敗は sequence（新しい方が
   * 勝つ）。戻り値は勝因（rank 差 / exclusive tie）、勝たないなら null。
   */
  private beats(a: IntentRecord, b: IntentRecord): "rank" | "tie" | null {
    let anyRankWin = false;
    let anyTieWin = false;
    let anyLoss = false;
    let overlapped = false;
    for (const oa of a.occupancy) {
      if (oa.lane === "articulation") continue;
      for (const ob of b.occupancy) {
        if (ob.lane === "articulation") continue;
        if (oa.region !== ob.region || oa.lane !== ob.lane) continue;
        overlapped = true;
        const cmp =
          oa.lane === "physiology"
            ? a.physiologyPrecedence - b.physiologyPrecedence
            : a.rank - b.rank;
        if (cmp > 0) {
          anyRankWin = true;
        } else if (cmp < 0) {
          anyLoss = true;
        } else if (isExclusiveCategoricalPair(a, b)) {
          if (a.sequence > b.sequence) {
            anyTieWin = true;
          } else {
            anyLoss = true;
          }
        }
      }
    }
    if (!overlapped || anyLoss) return null;
    if (anyRankWin) return "rank";
    if (anyTieWin) return "tie";
    return null;
  }

  private hasConflictingOverlap(a: IntentRecord, b: IntentRecord): boolean {
    for (const oa of a.occupancy) {
      if (oa.lane === "articulation") continue;
      for (const ob of b.occupancy) {
        if (ob.lane === "articulation") continue;
        if (oa.region === ob.region && oa.lane === ob.lane) return true;
      }
    }
    return false;
  }
}
