# Single-active pack は config picks

> このファイルは「**single-active な pack 種別の active 選択 mechanism を設計する**」時に読む。対象：dev / AI / pack 作者。

**Status**: active
**Last updated**: 2026-04-19

## TL;DR

scene / persona など single-active な pack 種別では、**active 選択は `~/.charminal/config.json` で user が picks**。pack 自身に `defaultActive` を持たせない。factory default は Charminal code に hard-code する。

## 何を決めたか

- single-active 系の pack（scene / persona）では config の対応 field（`activeScene` / `primaryPersona`）で user が指定
- pack manifest / definition に `defaultActive` のような自薦 field は **持たせない**
- config 未指定時の fallback は **Charminal code に hard-code**（bundled の特定 pack を register + 自動 fallback）

## なぜそう決めたか

- 複数 pack が「自分が active」を主張すると競合解決が必要 → config に集中させて単一 source of truth にする
- Agentic UGC 前提では config 編集は barrier にならない（AI が書く）→ implicit な便利さより explicit な予測可能性が勝つ（[explicit-over-implicit-ugc.md](explicit-over-implicit-ugc.md)）
- Pack 作者が誤って `defaultActive: true` を書いて global に影響を与える事故も予防

## 検討したが却下した代替案

- **pack 側 `defaultActive`** — 競合事故、責任不明瞭
- **install 順 / load 順で決める** — 非決定的、debug 困難

## この決定の implication / 制約

- 新 single-active pack 種別を追加する際は **config に field 1 つ追加** + Charminal 側で fallback 設計
- 新 pack 種別を「いつ複数並行 / いつ single-active」と分類する判断軸：状態を持つ / lifecycle が長い → single-active 寄り、event-driven / 短命 → 複数並行

## 関連 reference

- memory: `feedback_single_active_config_picks.md`、`feedback_explicit_over_implicit_ugc.md`
- source: `src/runtime/scene-pack-registry/`、`src/runtime/persona-registry/persona-registry-impl.ts`
- 関連: [`persona-multi-instance.md`](persona-multi-instance.md)、[`explicit-over-implicit-ugc.md`](explicit-over-implicit-ugc.md)
