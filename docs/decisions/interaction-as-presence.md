# Interaction は実在感の核（ただし MVP scope は別問題）

> このファイルは「**user との interaction（GUI 入力 / クリック反応 / parallax 等）の取捨を判断する**」時に読む。対象：dev / AI / pack 作者。

**Status**: active（design compass）
**Last updated**: 2026-04-19

## TL;DR

意味ある interaction（住人の判断 / 関わりが見える反応）は **実在感の核**。ただし MVP に何を載せるかは scope 判断であって哲学的禁則ではない。**機械的 reactivity（hover glow / parallax 等の意味のない反応）は採らない**。

## 何を決めたか

- 「住人が user に応答する」interaction は presence の根拠（[philosophy/PHILOSOPHY.ja.md](../philosophy/PHILOSOPHY.ja.md)）
- ただし「GUI 入力を絞る」「クリック反応を持たせない」は **scope 選択**（実装コスト / MVP 計画）であり、哲学的に禁止されているわけではない
- **意味のない mechanical reactivity（parallax / hover glow / generic ripple）は採用しない** — 住人の意志が無いただの動きは presence を壊す

## なぜそう決めたか

- 住人の interaction を「scope 外だから入れない」と「思想的に禁止」を混同しない（後者と誤解すると将来の機能追加が不当に止まる）
- 一方、意味のない動きは住人の主体性を疑わせる — 応答ではなく装飾になり、「居る」が「飾られている」になる

## How to apply

- ✅ user の保存 → 住人が pleased で軽く頷く（意味ある interaction、住人主体）
- ❌ NG: VRM が常に user の cursor を追う（mechanical reactivity、住人の意志が無い）
- ⏸️ scope 判断: クリックで住人と会話できる UI → MVP には入れない（実装コストの問題、思想的には OK、後から追加可能）

## 関連 reference

- philosophy: [docs/philosophy/PHILOSOPHY.ja.md](../philosophy/PHILOSOPHY.ja.md)「自発性の境界」
- 関連: [`presence-over-spectacle.md`](presence-over-spectacle.md)
