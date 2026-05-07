# 認知負荷の 2 原則 — 設計 / refactor 判断の lens

> このファイルは「**設計や refactor の判断軸を確認したい**」「**audit 提案を採用するか判断する**」時に読む。対象：dev / AI。

**Status**: active（design discipline）
**Last updated**: 2026-04-20

## TL;DR

設計 / refactor 判断は **2 つの原則** で評価する：

1. **読者が追跡しなければならないレイヤーを減らす**
2. **読者が頭に保持しなければならない状態を減らす**

新しい abstraction を入れる時は **2 原則の少なくとも片方を net で改善するか** を確認する。「便利そう」だけでは入れない。over-application（不要な abstraction）も同じ lens で却下する。

## 何を決めたか

- 設計判断・refactor 評価・audit 提案受け入れの **standard lens** として 2 原則を採用
- 新 abstraction 追加時：「layer が 1 増える」コスト vs「state が減る」利得を比較、net マイナスなら入れない
- duplicate code（state 最小だが layer 多）と over-abstraction（layer 少ないが暗黙 state 多）の **両方が事故源** と扱う

## なぜそう決めたか

- 当 project は 1 人開発 + AI との共同で context switch コストが高い
- 機能追加が累積するため、ベース構造の認知負荷は時間とともに膨らむ
- 1 つの lens に統一することで判断の一貫性が上がる（毎回 ad-hoc な原則を引っ張り出さない）
- DRY / SOLID のような細粒度原則は毎回照合コストが高い → **2 原則に集約**して即時判断できる軸にする

## 適用例（過去）

### ✅ 採用したもの

- **`docs/INDEX.md` → `docs/README.md` 統合**：layer -1（reader が「どっちのドアか」を判定する負荷を消した）
- **SingleActiveRegistry 統合**：duplicate -1、layer 微増（base class）だが net で state -1、行数 -122
- **App.tsx の 3 IIFE → 1 bootstrap**：state -1（暗黙の順序依存を明示化）+ config 読み 2 回 → 1 回
- **decisions/ + audience header**：layer +1（新規 directory）だが state を大きく -2（topic から最新決定を 1 ページで掴める / file 開いた瞬間に audience がわかる）

### ❌ 却下したもの

- **`PersonaReflexDispatcher` に interface 追加**：唯一 impl で layer +1 だけ、state -0
- **`LogBridge` と `DevLog` を共通基底に統合**：概念混乱で state 増、separate-distinct-systems 原則とも矛盾
- **concept-to-location map**：concept がまだ流動的なため drift リスクが高い、当面 state +1 にしかならない
- **Tauri invoke 全 wrap**：boilerplate +N（layer 増）、型安全性向上はあるが部分 wrap でも問題は出ていない

## 「不要な abstraction」を見抜く判定軸

以下のいずれかに該当したら abstraction は **疑わしい**：

- `interface X` に対して `impl X` が **1 つしかない**（interface 不要、class でいい）
- wrapper が **delegation だけ**（中身が `inner.x()` の繰り返し → wrapper 不要）
- helper function が **1 箇所からしか呼ばれない**（inline 化を検討）
- 「**将来必要かもしれない**」を理由にした abstraction（YAGNI、必要になった時に入れる）
- 同じ機能の **rename 違い**の wrapper（`getActive()` を `getActivePersona()` で wrap、ただし domain readability の利得があれば OK）

## 逆に abstraction が正しい場合

- **真の duplication**：同型コードが 2 箇所以上で、形が同期する必要がある（→ DRY base が正解、SingleActiveRegistry の例）
- **domain boundary を型レベルで強制**：`PersonaContext` / `UtilityContext` は意図的に別型 — 型エラーで境界違反を検出（critical-constraints §2 「Utility は motion-free」の根拠）
- **public contract**：SDK 公開型は impl が 1 つでも interface で書く価値がある（pack 作者が見る surface の安定性）

## audit 提案を受ける時の checklist

audit / code review で「abstraction を入れろ」recommendation が来たら：

1. その abstraction が **layer を 1 増やす**ことを認識する（タダではない）
2. それが **state をいくつ減らすか**を具体的に数える（曖昧なら却下）
3. 同じ目的を **comment 1 行** や **rename** で達成できないか先に確認
4. 「真の duplication」「domain boundary」「public contract」のいずれにも当たらないなら採用しない

agent が `interface 追加` / `wrapper 化` / `factory 化` を recommend する傾向があるので、特に注意して 2 原則で reweigh する。

## 検討したが却下した代替案

### A. DRY / SOLID / YAGNI など細粒度原則を default に

**却下理由**：粒度が細かすぎて毎回照合コストが高い。2 原則に集約する方が運用コストが低い。細粒度原則は 2 原則の **下位原理** として参照する程度でよい。

### B. 原則を持たず ad-hoc に判断

**却下理由**：時間が経つと判断が揺れる。同じ問題に対して別の判断をするリスク。少なくとも 1 つの統一 lens は持つべき。

## この決定の implication / 制約

- 新規 abstraction を提案する時、commit message / PR description に **「どの state がいくつ減るか」「どの layer が何コスト増えるか」を明示** すると後で audit しやすい
- 「便利そう」だけの abstraction は merge しない（「Large diff は質 / 体験の gain で代償を払う」原則と同方向）
- audit 提案の adoption は 2 原則の filter を **必ず通す**（特に外部 agent が DRY 一辺倒で over-recommend する場合）

## 関連 reference

### Working principles の補強

- CLAUDE.md「Working principles」§ 認知負荷の 2 原則
- 関連: [`separate-distinct-systems.md`](separate-distinct-systems.md)（分離 vs 統合の判断軸、本原則の specialization）
- 適用例: [`single-active-registry-pattern.md`](single-active-registry-pattern.md)（duplicate を base に集約した事例）

## 改訂履歴

- 2026-04-20: 初版（doc 整備 / scripts / TS 設計 / fix 範囲の 4 つの判断で同じ lens を反復使用したことを契機に明文化）
