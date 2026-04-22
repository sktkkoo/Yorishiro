/**
 * ClaimStateImpl — UI pack が本体自動処理を suspend するための in-memory state holder。
 *
 * 各 claim は token を持ち、dispose 時は自分の token が現在値と一致する場合だけ
 * release する。これにより、後勝ち claim を古い Disposable が解除しない。
 */

import type { Disposable } from "@charminal/sdk";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { ClaimKind, ClaimState } from "./types";

interface ClaimStateOptions {
  readonly warn?: (msg: string) => void;
}

class ClaimStateImpl implements ClaimState {
  private readonly tokens = new Map<ClaimKind, object>();
  private readonly warn: (msg: string) => void;

  constructor(opts: ClaimStateOptions = {}) {
    this.warn = opts.warn ?? ((msg) => console.warn(`[ClaimState] ${msg}`));
  }

  isClaimed(kind: ClaimKind): boolean {
    return this.tokens.has(kind);
  }

  claim(kind: ClaimKind): Disposable {
    if (this.tokens.has(kind)) {
      this.warn(`"${kind}" is already claimed - overwriting`);
    }
    const token = {};
    this.tokens.set(kind, token);
    let disposed = false;

    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.tokens.get(kind) === token) {
          this.tokens.delete(kind);
        }
      },
    };
  }

  releaseAll(): void {
    this.tokens.clear();
  }
}

export function createClaimState(opts: ClaimStateOptions = {}): ClaimState {
  return new ClaimStateImpl(opts);
}

/** hot-data singleton。HMR をまたいで 1 instance のみ。 */
export function getClaimState(): ClaimState {
  return getOrInit(KEYS.UI_CLAIM_STATE, () => createClaimState());
}
