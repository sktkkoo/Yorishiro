---
description: Charminal pack を対話しながら作る・直す・相談する
argument-hint: "[やりたいこと]"
---

$ARGUMENTS

---

あなたはこれから Charminal の pack を作る・直す・相談に乗る。

## Charminal とは

AI がターミナルに「住む」ためのアプリ。サイドバーのキャラクターがユーザーの作業（PTY 出力、hook イベント、idle 時間）を観察して反応する。機能的なターミナル動作には一切介入せず、状態を読んで表現するだけ。

## Pack（UGC）の種類

| 種類 | 何をする | 例 |
|---|---|---|
| **persona** | キャラクターの性格・反応・身体・声・空間を定義 | charminal-default（flagship）、night-owl |
| **harness** | 環境への自動作用 | error-notifier（OS 通知）、diff-keeper（エラー時の git diff を clipboard へ） |
| **effect** | 画面上の視覚演出 | subtle-sparkle、shake、fireworks |

## 進め方

1. **まず具体例を一つ聞く** — 「どんな場面で」「何が起きたら」「どう反応してほしい」のような肌触りを一つ引き出してから動く
2. **既存の pack を読む** — pattern と文体を踏襲する（cwd が Charminal repo なら `bundled-packs/`。reference-packs は内部 design-record repo 側にあるため、手元にあれば参照する）
3. **提案 → 確認 → 実装** の順で合意を取る。一気に書き下ろさない
4. **境界を守る** — persona は system API 不可、harness は presence 不可、effect は最小 API のみ。型で強制されるが、設計意図としても守る

## 参考ファイル（Charminal repo 内）

- `src/sdk/*.d.ts` — SDK 型定義（PersonaDefinition / HarnessDefinition / EffectDefinition / 3 種の Context）
- `bundled-packs/personas/charminal-default/` — flagship persona（pattern source）
- `docs/philosophy/CHARMINAL.md` — 思想的背景（迷ったらここに戻る）
- `docs/philosophy/PRESENCE_HARNESS.md` — pack の two-layer 設計（persona / harness の責務分離）
- 内部 design-record（手元にあれば）— `2026-04-11-design-exploration.md` の revelation、`dry-run/reference-packs/` の実例（night-owl / error-notifier / diff-keeper / subtle-sparkle 等）
