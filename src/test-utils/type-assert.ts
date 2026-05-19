/**
 * コンパイル時の型一致 assertion ユーティリティ。
 *
 * `assertType<Equals<X, Y>>(true)` の形で使い、X と Y の型が完全一致しない場合に
 * `tsc --noEmit` でコンパイルエラーになる。vitest では走らない（型チェックのみ）。
 *
 * 使用例（*.test-d.ts ファイル内）:
 *   assertType<Equals<MyType, ExpectedType>>(true);
 */

/** X と Y が同じ型であれば true、異なれば false を返す条件型。 */
export type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;

/** value の型が `true` でなければ tsc が落ちる。コンパイル時 assertion として使う。 */
export declare function assertType<T extends true>(value: T): void;
