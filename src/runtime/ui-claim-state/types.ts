/**
 * ClaimState — UI pack が本体の自動処理を一時的に奪う（claim する）状態管理。
 *
 * 各自動処理（camera tracking / expression update / animation update）に対して
 * 「claimed かどうか」をフラグで持ち、本体側は毎フレーム isClaimed() を見て
 * 自分の処理を skip するか判断する。
 *
 * UI pack は single-active なので、同時に複数 claimer が来ることは実用上ない。
 * ただし safety net として claim overwrite 時に warn を出す。dispose 時に
 * 「最後の claim holder」だった場合のみ release する。
 *
 * Internal design-record: 2026-04-21-ui-pack-single-active.md（Plan 2 拡張）
 */

import type { Disposable } from "@charminal/sdk";

export type ClaimKind = "camera" | "expression" | "animation";

export interface ClaimState {
  /** 現在 claim されているか（本体側が毎フレーム参照） */
  isClaimed(kind: ClaimKind): boolean;

  /** claim する。Disposable.dispose で release。 */
  claim(kind: ClaimKind): Disposable;

  /** すべての claim を強制 release（UI pack deactivate 時の safety net） */
  releaseAll(): void;
}
