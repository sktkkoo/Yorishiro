# attention-aura — 注目領域を淡い光の帯で照らす（bundled ambient-ui pack）

Yorishiro 本体同梱の reference ambient-ui pack。Attention runtime の snapshot を
subscribe し、いま注目されている矩形（`AttentionTarget.rect`）の上に柔らかい glow band を
overlay 描画する。

## ambient-ui pack の制度

ambient-ui は primary UI（`activeUi`）を占有しない **multi-active** な overlay 層。
`ambient-ui-pack-registry` が `enable(id)` / `disable(id)` / `getActiveSet()` で
active 集合（0..n）を管理し、active な pack はそれぞれ独立した container に mount される。
同 id の bundled / user は user-over-bundled で override される。

## 描画挙動

- `ctx.attention.subscribe(...)` で snapshot を購読し、`snapshot.target` を追従する。
- target rect へ向けて view（x / y / width / height / opacity）を毎フレーム lerp 補間し、
  収束したら RAF を pause する（静止中は CPU / バッテリーを使わない設計）。target が変化すると
  subscribe callback が RAF を再起動する。
- target が `null` になると opacity を線形 fade-out し、その後 RAF を完全停止する。
- glow は `mixBlendMode: "screen"` + `filter: blur(px)` による加算光で、container は
  `spread` 込みで rect を拡張して描く。`pointerEvents: "none"` / `aria-hidden` の純粋な装飾層。

## 見た目の出し分け

`visual.ts` の pure 関数が target の `kind` と `reason` から blur / spread / borderRadius /
gradient / boxShadow を決める。

- **kind** による base opacity と色味：`mouse` / `input-cursor` / `terminal-region` / `mcp-ui` /
  `focused-dom`。
- **reason** による強調：`approval-required` / `error` / `diagnostic` は opacity を強めて注意喚起、
  `tool-reading` / `tool-writing` / `tool-running` は読み（青）/ 書き（緑）/ 実行（暖色）で色分け、
  `search-match` / `selection` / `file-link` は控えめな band。
- opacity は base × reason 倍率 × `confidence`（[0,1] にクランプ）。

## 編集について

この pack は **Yorishiro 本体の一部** として扱われる。Yorishiro 内（AI / `/yori` /
file writer）からは編集不可、本体の version up でのみ更新される
（memory: `feedback_bundled_pack_immutability.md`）。

挙動を変えたい場合は、同 id で `~/.yorishiro/packs/attention-aura/` に fork を置く
（bundled は dispose され、user 版が active になる。fork の保守は user の責任）。

## 関連

- Internal design-record: `2026-04-25-attention-aura-v2-design.md`「Aura 描画負荷の対策」
- semantic priority: `docs/decisions/semantic-priority-attention.md`
