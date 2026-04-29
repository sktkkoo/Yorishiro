/**
 * @charminal/sdk/utility
 *
 * Utility Pack の定義型。
 * utility/utility.ts では `satisfies UtilityDefinition` を使って export default する。
 *
 * ⚠️ 重要：Utility は motion-free。character / voice / space API は
 * UtilityContext に存在しない。utility の出力は system API と
 * 抽象 reaction の emit（via custom trigger）だけ。
 */

import type { UtilityContext } from "./context";
import type { Trigger, ReactionType } from "./reaction";

// ─── Utility automation ───────────────────────────────────

export type UtilityAutomation = (ctx: UtilityContext) => Promise<void>;

export interface WeightedUtilityAutomation {
  readonly handler: UtilityAutomation;
  readonly weight?: number;
  readonly cooldownMs?: number;
  readonly label?: string;
}

/** 一つの reaction type に対する automation 集合 */
export interface UtilityReactionSet {
  readonly handlers: ReadonlyArray<WeightedUtilityAutomation>;
}

// ─── UtilityDefinition ────────────────────────────────────

/**
 * Utility Pack の entry file が export default するオブジェクトの型。
 *
 * 例：
 * ```typescript
 * import type { UtilityDefinition } from '@charminal/sdk';
 *
 * export default {
 *   id: 'build-automation',
 *   name: 'Build Automation',
 *   customTriggers: [
 *     {
 *       id: 'build-success',
 *       match: (event) => {
 *         if (event.kind !== 'pty-output') return null;
 *         if (!/BUILD SUCCESS/.test(event.text)) return null;
 *         return { reaction: 'build-completed' };
 *       },
 *     },
 *   ],
 *   automations: {
 *     'build-completed': {
 *       handlers: [{
 *         handler: async (ctx) => {
 *           await ctx.system.exec('./deploy.sh');
 *         },
 *       }],
 *     },
 *   },
 * } satisfies UtilityDefinition;
 * ```
 */
export interface UtilityDefinition {
  readonly id: string;
  readonly name: string;

  /**
   * この utility が追加する custom trigger。
   * 環境 event を受けて、独自の reaction type に変換する。
   * utility の「何を検知するか」を決める部分。
   */
  readonly customTriggers?: ReadonlyArray<Trigger>;

  /**
   * 反応タイプごとの automation 集合。
   * persona の reflex.responses と似た shape だが、
   * handler は UtilityContext を受け取る（system API 有り、presence 無し）。
   */
  readonly automations: Partial<Record<ReactionType, UtilityReactionSet>>;

  /**
   * この utility が期待する asset の宣言（optional、loose coupling 用）。
   * load 時に missing なら warning + graceful skip。
   *
   * NOTE: ただし utility は character API を持たないので、
   * これらの asset を直接再生することはできない。
   * 代わりに、この utility を一緒に使う persona がこれらを持つことを
   * 期待する、という documentation の役割を持つ。
   */
  readonly requires?: {
    readonly animations?: ReadonlyArray<string>;
    readonly voicePhrases?: ReadonlyArray<string>;
  };
}
