# Bundled pack の immutability

> このファイルは「**bundled pack を編集する誘惑 / fork ガイド / file writer の guard 設計**」を考える時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-04-19

## TL;DR

`bundled-packs/` は Yorishiro 本体の一部。**いかなる経路でも write 不可**（AI / `/yori` / file writer の全経路で block）。改変したい user は `~/.yorishiro/packs/<id>/` に **fork して** override する。fork した瞬間に責任は user に移る。

## 何を決めたか

- bundled-packs/ への write は **AI / `/yori` / file writer 全経路で禁止**
- バージョンアップでは bundled は **上書き** される。user fork は影響を受けない
- user fork は **ELPA stance**：壊れても Yorishiro は責任を負わない、user の管理範囲

## なぜそう決めたか

- bundled は **stable contract**（pack 作者にとっての reference / 動作保証）として扱う
- in-place edit を許すと「Yorishiro の更新で user 編集が破壊される」事故が必ず起きる
- Emacs の advice 機構相当（実体を別に置いて hook で振る舞いを差し替え）は導入しない方針 — 「実体は user 側で持つ」の一貫性

## 検討したが却下した代替案

- **bundled-packs/ の編集を AI に許す** — Yorishiro 更新時 conflict、責任境界が曖昧
- **Emacs の advice 機構** — 認知負荷が高く debug 困難

## この決定の implication / 制約

- bundled は手で動かさない reference として保つ → pack 作者の例として常に「動く状態」を示せる
- user 改変動線は必ず fork 経由：`/yori` の persona / scene / effect 編集はすべて user pack に対して
- **「fork して試す」が trial path の default**

## 関連 reference

- 関連: [`pack-override-pattern.md`](pack-override-pattern.md)、[`user-pack-layout.md`](user-pack-layout.md)
