/**
 * AttentionLightCueStore — attention light を「いつ光らせるか」を一元管理する store。
 *
 * 位置づけ（照明通知の scene 所有化 計画 Task 2）:
 *   - session attention（workspace-attention 経由）と MCP / 手動確認の両方から
 *     「cue（一度きりの光の合図）」の発行要求を受け、identity dedup / toggle /
 *     cooldown をここに集約する。envelope の再生自体は component 側の責務で、
 *     このstore は `seq` の変化でしか意思を伝えない。
 *   - identity dedup の意味論（上限 128 の FIFO 追い出し）は、旧 runtime 直注入の
 *     attention-flash-light.tsx（Task 4 で attention-cue-light.tsx に置き換え・削除済み）
 *     の rememberCompletedPulseIdentity から移植したもの。
 */

import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { SessionId } from "../sessions/types";
import {
  type AttentionLightSettingsStore,
  getAttentionLightSettingsStore,
} from "../three-runtime/attention-light-settings";

const MAX_REMEMBERED_IDENTITIES = 128;

/** triggerManual の連続発火を抑える cooldown。値は帰納的に調整する暫定値。 */
export const MCP_CUE_COOLDOWN_MS = 5000;

export interface AttentionLightCue {
  /** 単調増加。component は seq 変化で envelope を最初から再生する。 */
  readonly seq: number;
  readonly startedAt: number;
  readonly reason: "session-attention" | "mcp" | "run-failed" | "run-slow-completed";
  readonly sessionId?: SessionId;
}

export type ManualCueResult =
  | { readonly triggered: true }
  | { readonly triggered: false; readonly reason: "disabled" | "cooldown" };

type Listener = () => void;

export class AttentionLightCueStore {
  private readonly settings: AttentionLightSettingsStore;
  private readonly now: () => number;
  private readonly seenIdentities = new Set<string>();
  private readonly listeners = new Set<Listener>();
  private current: AttentionLightCue | null = null;
  private seq = 0;
  private lastManualTriggerAt: number | null = null;

  constructor(opts: {
    readonly settings: AttentionLightSettingsStore;
    readonly now?: () => number;
  }) {
    this.settings = opts.settings;
    this.now = opts.now ?? (() => Date.now());
  }

  getCurrent(): AttentionLightCue | null {
    return this.current;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * attention identity（`${sessionId}:${receivedAt}`）につき一度だけ cue する。
   * settings off なら cue も dedup 記録も行わない（再度 on になった際に再度 cue できる）。
   */
  cueForAttention(identity: string): boolean {
    if (!this.settings.getEnabled()) return false;
    if (this.seenIdentities.has(identity)) return false;
    this.rememberIdentity(identity);
    this.fire("session-attention");
    return true;
  }

  /** command run 由来の cue。sessionId は terminal glow の局所化に使う。 */
  cueForRun(
    reason: Extract<AttentionLightCue["reason"], "run-failed" | "run-slow-completed">,
    identity: string,
    sessionId: SessionId,
  ): boolean {
    if (!this.settings.getEnabled()) return false;
    if (this.seenIdentities.has(identity)) return false;
    this.rememberIdentity(identity);
    this.fire(reason, sessionId);
    return true;
  }

  /** MCP / 手動確認用の cue。settings off → disabled、cooldown 内 → cooldown。 */
  triggerManual(): ManualCueResult {
    if (!this.settings.getEnabled()) {
      return { triggered: false, reason: "disabled" };
    }
    const now = this.now();
    if (this.lastManualTriggerAt !== null && now - this.lastManualTriggerAt < MCP_CUE_COOLDOWN_MS) {
      return { triggered: false, reason: "cooldown" };
    }
    this.lastManualTriggerAt = now;
    this.fire("mcp");
    return { triggered: true };
  }

  private rememberIdentity(identity: string): void {
    this.seenIdentities.add(identity);
    if (this.seenIdentities.size <= MAX_REMEMBERED_IDENTITIES) return;
    const oldest = this.seenIdentities.values().next().value;
    if (oldest !== undefined) this.seenIdentities.delete(oldest);
  }

  // 再生中に新 identity が来た場合も同じ経路で seq++ し、envelope を再スタートさせる。
  // 複数 identity が短時間に重なった場合の coalesce（間引き）は将来の調整項目。
  private fire(reason: AttentionLightCue["reason"], sessionId?: SessionId): void {
    this.seq += 1;
    this.current = { seq: this.seq, startedAt: this.now(), reason, sessionId };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export function getAttentionLightCueStore(): AttentionLightCueStore {
  return getOrInit(
    KEYS.ATTENTION_LIGHT_CUE,
    () => new AttentionLightCueStore({ settings: getAttentionLightSettingsStore() }),
  );
}
