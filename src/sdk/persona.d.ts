/**
 * @yorishiro/sdk/persona
 *
 * Persona Pack の定義型。
 * scene/persona.ts では `satisfies PersonaDefinition` を使って export default する。
 */

import type { PersonaContext } from "./context";
import type { Trigger, ReactionType } from "./reaction";

// ─── Persona handler ──────────────────────────────────────

export type PersonaHandler = (ctx: PersonaContext) => Promise<void>;

export interface WeightedPersonaHandler {
  readonly handler: PersonaHandler;
  /** weighted random で使う。省略時は 1 */
  readonly weight?: number;
  /** 直前に使ったばかりなら避ける時間（クールダウン） */
  readonly cooldownMs?: number;
  /** ログ・デバッグ用のラベル */
  readonly label?: string;
}

/** 一つの reaction type に対する handler 集合 */
export interface PersonaReactionSet {
  readonly handlers: ReadonlyArray<WeightedPersonaHandler>;
}

// ─── PersonaDefinition ────────────────────────────────────

/**
 * Persona Pack の entry file が export default するオブジェクトの型。
 *
 * 例：
 * ```typescript
 * import type { PersonaDefinition } from '@yorishiro/sdk';
 *
 * export default {
 *   id: 'my-persona',
 *   name: 'わたし',
 *   thinking: { systemPromptAddition: '...' }, // optional — persona.md から loader が inject することもある
 *   reflex: { responses: {} },
 * } satisfies PersonaDefinition;
 * ```
 *
 * 軸は思考（thinking）と反射（reflex）の二つ。かつて存在した world / logReading 軸は
 * 2026-07-18 に削除した（宣言のみで runtime に消費者がいなかった）。空間（scene）は
 * workspace に紐づくため persona は選ばない。VRM / voice の persona 連動切替は
 * この型の軸としてではなく別の形で設計する（design-record 2026-07-18-persona-scope-review.md）。
 */
export interface PersonaDefinition {
  /** pack id。kebab-case */
  readonly id: string;
  /** 人間に見せる名前 */
  readonly name: string;

  // ─── 思考層への影響（一次）────

  /**
   * optional。loader が persona.md から systemPromptAddition を inject することがある。
   * thinking 自体が省略された場合、loader は persona.md の内容を使って補完する。
   */
  readonly thinking?: {
    /**
     * Claude Code の system prompt に追記される文字列。
     * optional — loader が persona.md から inject することがある。
     * この persona の「人格」を定義する最も強い部分。
     */
    readonly systemPromptAddition?: string;
  };

  // ─── 反射層への影響（二次、構造的）────

  /**
   * optional — minimal persona pack では省略可（bundled yori の
   * reflex が fallback として有効）。省略時は反応 handler を持たない。
   */
  readonly reflex?: {
    /** この persona 独自の custom trigger（任意） */
    readonly customTriggers?: ReadonlyArray<Trigger>;

    /**
     * 抽象反応タイプごとの handler 集合。
     * 同じ reaction に複数の handler を登録できる（weighted random で選ばれる）。
     * 複数候補があることで「確率的表現」が成立する（revelation 3.7）。
     */
    readonly responses: Partial<Record<ReactionType, PersonaReactionSet>>;
  };
}
