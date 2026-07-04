# workspace-attention/

Workspace 全体の host-owned attention item store。P0 の producer は command run のみで、
failed / slow completed の run だけを lifecycle item にする。

## Entry

- `index.ts` — runtime 内 export。
- `workspace-attention-store.ts` — item lifecycle (`active` / `ack` / `snoozed` / `resolved`) と active / primary / aggregate projection。
- `command-run-producer.ts` — live terminal command run を noteworthy attention item に変換する producer。
- `presence-bridge.ts` — primary item の severity を Body の最小 expression pulse へ投影する bridge。

## Boundaries

- Pack code は item を write できない。producer は host wiring のみ。
- Output text は保持しない。command run locus は marker / rect metadata のみ。
- Lighting / sidebar consume は P0 では扱わない。

## Dependencies

- `terminal-runtime/` から command run metadata / locus を読む。
- locus の視覚 consumer は当面なし。失敗 turn の枠が可視化される Tier 2 で aura 再接続を検討する。
- `core/body` は最小 presence reaction 用の `Body.acquireExpressionSlot` だけを使う。
