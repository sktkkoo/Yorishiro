/**
 * @charminal/sdk/effect
 *
 * Effect Pack の定義型。
 * effects/effect.ts では `satisfies EffectDefinition` を使って export default する。
 *
 * Effect は passive な rendering unit。persona から呼ばれて run する。
 * lifecycle が短く、memory も reaction も持たない。
 */

import type { EffectContext } from "./context";

// ─── Effect runner ────────────────────────────────────────

/**
 * Effect の実行関数。
 * ctx の renderer / audio API で描画し、time で lifecycle を制御する。
 * options は persona が `ctx.space.injectEffect({ kind, ...options })` で渡す。
 */
export type EffectRunner<TOptions = unknown> = (
  ctx: EffectContext<TOptions>,
  options: TOptions,
) => Promise<void>;

// ─── EffectDefinition ─────────────────────────────────────

/**
 * Effect Pack の entry file が export default するオブジェクトの型。
 *
 * 例（generic な骨格 — pack ごとに id / options / 数値は置き換えること）：
 * ```typescript
 * import type { EffectDefinition, EffectContext } from '@charminal/sdk';
 *
 * interface ExampleParticleOptions {
 *   origin: { x: number; y: number };
 *   count?: number;
 *   durationMs?: number;
 * }
 *
 * export default {
 *   id: 'example-particles',
 *   type: 'effect',
 *   run: async (
 *     ctx: EffectContext<ExampleParticleOptions>,
 *     options,
 *   ): Promise<void> => {
 *     const { origin, count = 30, durationMs = 500 } = options;
 *     const handle = ctx.renderer.addParticles({
 *       origin, count, durationMs, colorScheme: 'monochrome',
 *     });
 *     await ctx.time.after(durationMs);
 *     handle.dispose();
 *   },
 * } satisfies EffectDefinition<ExampleParticleOptions>;
 * ```
 *
 * この example は「pattern を示すための骨格」であって、具体的な effect の仕様ではない。
 * 実際の pack を書くときは id / interface 名 / 既定値 / colorScheme を、
 * その effect の意図に沿った値に差し替えること。
 */
export interface EffectDefinition<TOptions = unknown> {
  readonly id: string;
  readonly type: "effect";
  /** effect の実行関数 */
  readonly run: EffectRunner<TOptions>;
  /**
   * options の runtime schema（optional）。
   *
   * 型 safety は `EffectDefinition<TOptions>` の generic で既に担保されている。
   * TS 内部から呼ばれる限り、options の shape は compile 時に check 済み。
   *
   * このフィールドはそれとは別レイヤーの「runtime validation 用の保険」として position する：
   * - persona が `ctx.space.injectEffect({ kind, ...options })` で渡す options
   * - /charm UI など TypeScript の外側から injected される options
   * - 将来的な dynamic 呼び出し経路（RPC / IPC / config 由来）
   *
   * つまり「型では守れないエッジから入ってくる options を、
   *   effect 自身が自衛的に validate したい場合」にのみ宣言する。宣言しなくても effect は動く。
   *
   * 形式は JSON Schema に準拠する方針。TS 型から生成するのか手書きするのかは未決（本体実装時に確定）。
   * 当面は型を `unknown` のまま置くが、将来 `JsonSchema` へ narrow する予定。
   *
   * NOTE: manifest.json 側には optionSchema を重複させない。
   * single source of truth はここ（EffectDefinition）側。manifest は meta 情報のみを持つ。
   *
   * TODO(sdk): `unknown` を具体的な `JsonSchema` 型へ narrow する。
   */
  readonly optionSchema?: unknown;
  /**
   * 同 id の dispatch が続けて来たとき、前の実行を abort して最新だけ残す。
   * false（default）だと過去の dispatch と並行して走る。
   *
   * fireworks / text-physics のように 1 発が長く尾を引く effect で true にする。
   * screen-shake のような短命 effect は false のままで良い。
   *
   * singleton pack が abort される際、前の run に渡した ctx.signal が abort される。
   * pack 側では signal の 'abort' event で即 cleanup（RAF cancel + handle.dispose）
   * することで、新しい dispatch が clean な状態で走れるようにする。
   */
  readonly singleton?: boolean;
}
