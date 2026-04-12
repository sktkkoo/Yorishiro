/**
 * @charminal/sdk/harness
 *
 * Harness Pack の定義型。
 * harness/harness.ts では `satisfies HarnessDefinition` を使って export default する。
 *
 * ⚠️ 重要：Harness は motion-free。character / voice / space API は
 * HarnessContext に存在しない。harness の出力は system API と
 * 抽象 reaction の emit（via custom trigger）だけ。
 */

import type { HarnessContext } from "./context";
import type { Trigger, ReactionType } from "./reaction";

// ─── Harness automation ───────────────────────────────────

export type HarnessAutomation = (ctx: HarnessContext) => Promise<void>;

export interface WeightedHarnessAutomation {
  readonly handler: HarnessAutomation;
  readonly weight?: number;
  readonly cooldownMs?: number;
  readonly label?: string;
}

/** 一つの reaction type に対する automation 集合 */
export interface HarnessReactionSet {
  readonly handlers: ReadonlyArray<WeightedHarnessAutomation>;
}

// ─── HarnessDefinition ────────────────────────────────────

/**
 * Harness Pack の entry file が export default するオブジェクトの型。
 *
 * 例：
 * ```typescript
 * import type { HarnessDefinition } from '@charminal/sdk';
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
 * } satisfies HarnessDefinition;
 * ```
 */
export interface HarnessDefinition {
  readonly id: string;
  readonly name: string;

  /**
   * この harness が追加する custom trigger。
   * 環境 event を受けて、独自の reaction type に変換する。
   * harness の「何を検知するか」を決める部分。
   */
  readonly customTriggers?: ReadonlyArray<Trigger>;

  /**
   * 反応タイプごとの automation 集合。
   * persona の reflex.responses と似た shape だが、
   * handler は HarnessContext を受け取る（system API 有り、presence 無し）。
   */
  readonly automations: Partial<Record<ReactionType, HarnessReactionSet>>;

  /**
   * この harness が期待する asset の宣言（optional、loose coupling 用）。
   * load 時に missing なら warning + graceful skip。
   *
   * NOTE: ただし harness は character API を持たないので、
   * これらの asset を直接再生することはできない。
   * 代わりに、この harness を一緒に使う persona がこれらを持つことを
   * 期待する、という documentation の役割を持つ。
   */
  readonly requires?: {
    readonly animations?: ReadonlyArray<string>;
    readonly voicePhrases?: ReadonlyArray<string>;
  };
}
