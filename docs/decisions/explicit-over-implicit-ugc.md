# Agentic UGC 前提では explicit を選ぶ

> このファイルは「**user に何を書かせる / 自動推論するかを決める**」時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-04-19

## TL;DR

Yorishiro の UGC は AI が書く前提（Agentic UGC）。よって「user 設定編集は barrier」という従来 GUI app の前提は当てはまらない。**implicit な便利さより explicit な予測可能性を優先**。

## 何を決めたか

- 設定編集は **AI が代行** できるので user が触る barrier は低い
- 「manifest field が無くても動く」「config 自動推論」「規約による暗黙挙動」のような implicit な便利さは却下
- 例：scene pack の active 選択 → pack 自薦ではなく config の `activeScene` で picks

## なぜそう決めたか

- AI が書くなら「明示的な field 1 つ書く」コストはゼロに近い
- implicit は debug 不能性を増やす — 「なぜ active になっているのか」が code grep で答えられない
- 予測可能性は **creator loop（AI と user の協働）の信頼基盤**。AI が pack を書いた時の挙動が config から逆算できることが大事

## 検討したが却下した代替案

- **user 側 GUI で active 選択 UI を作る** — UI 開発コスト + 状態同期問題。AI が config 書ける今は不要
- **規約で暗黙挙動を作る**（例：file 名が `default.*` なら default active）— grep で見えない、AI が判断できない

## この決定の implication / 制約

- Pack manifest の必須 field は「明示的に required」。optional に逃さない
- config.json の field 名は意図が読める命名（`activeScene` / `primaryPersona` 等）
- 「便利な省略形」を加える時は本当にコスト < 利得か（debug 性 / AI の理解しやすさを犠牲にしないか）を確認

## 関連 reference

- 関連: [`single-active-config-picks.md`](single-active-config-picks.md)
