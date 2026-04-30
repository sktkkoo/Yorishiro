/**
 * @charminal/sdk/persona
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

// ─── Log reading policy ───────────────────────────────────

/**
 * Persona の第四の軸：ログ参照ポリシー。
 * 思考層が反射層ログをいつ、どう読むかを定義する。
 * persona の性格の深い部分を決定する（docs/philosophy/CHARMINAL.md「ログという細い回路」）。
 */
export interface LogReadingPolicy {
  /** いつログを読むか */
  readonly readWhen:
    | { kind: "never" } // 没頭型
    | { kind: "session-boundary" } // 内省型（区切りで振り返る）
    | { kind: "on-query" } // 尋ねられたときだけ
    | { kind: "periodic"; intervalMs: number } // 周期的
    | { kind: "continuous" }; // 自意識過剰型

  /** 読んだ内容をどう扱うか */
  readonly framing:
    | "own" // 内省型・自意識過剰型：「自分が X した」
    | "distant" // 解離型：「身体が X したらしい」
    | "absent"; // 没頭型：読むが使わない

  /** 読む量（直近 N 件） */
  readonly windowSize: number;

  /** どれくらい過去まで遡るか（ms） */
  readonly lookbackMs?: number;
}

// ─── PersonaDefinition ────────────────────────────────────

/**
 * Persona Pack の entry file が export default するオブジェクトの型。
 *
 * 例：
 * ```typescript
 * import type { PersonaDefinition } from '@charminal/sdk';
 *
 * export default {
 *   id: 'my-persona',
 *   name: 'わたし',
 *   thinking: { systemPromptAddition: '...' }, // optional — persona.md から loader が inject することもある
 *   reflex: { responses: {} },
 *   world: { body: 'vrm:default', voice: 'voice:default', space: 'space:default' },
 *   logReading: { readWhen: { kind: 'session-boundary' }, framing: 'own', windowSize: 10 },
 * } satisfies PersonaDefinition;
 * ```
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
   * optional — minimal persona pack では省略可（bundled clai の
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

  // ─── 世界の選択（三次）────

  /**
   * optional — minimal persona pack では省略可（既存 world 設定が維持される）。
   */
  readonly world?: {
    /** 身体 VRM の ref。'vrm:default' など shared ref か、local ref */
    readonly body: string;
    /** 声の ref */
    readonly voice: string;
    /** 空間の ref */
    readonly space: string;
  };

  // ─── 第四の軸：ログ参照ポリシー ────

  /** optional — minimal persona pack では省略可（既存 policy が維持される）。 */
  readonly logReading?: LogReadingPolicy;
}
