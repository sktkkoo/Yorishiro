# 実在感を主、演出を従

> このファイルは「**scene compositor / per-layer 効果 / ambient binding / particle effect を設計する**」時に読む。対象：dev / AI / pack 作者。

**Status**: active（design compass）
**Last updated**: 2026-04-19

## TL;DR

Charminal の visual layer（scene / compositor / ambient / per-layer 効果）は **「実在感の増幅」が第一目的**。「綺麗な絵を見せる」「派手な演出」は副次。過剰演出（撮影意図の前面化）は Charminal には合わない場合が多い。

## 何を決めたか

- visual 設計の判断軸：「これは住人がそこに居る感を強めるか？」を最優先
- 「綺麗だが住人を後景化する」「ambient を強調しすぎて住人が埋もれる」は却下対象
- ambient binding / per-layer blur / color filter などは **静けさと変化の落差** を作るための道具

## なぜそう決めたか

- Charminal の core は presence（[philosophy/PHILOSOPHY.ja.md](../philosophy/PHILOSOPHY.ja.md)）。visual はその amplifier であって主役ではない
- 「frame を綺麗に見せる」ための layer stack と、「place として住人が居る」ための layer stack は目的が違う
- 演出が前面化すると、住人が「居る」のではなく「演じている」存在に見える（誠実さの原則に反する）

## How to apply（境界が曖昧な場面）

「派手な effect pack を作りたい / scene を凝りたい」場合：

- 主体が **住人の感情の表出** なら OK（distressed の screen-shake 等）
- 主体が **環境の演出** なら住人を埋めない範囲に抑える
- 「映え重視の仕上げ」は Charminal の compass からは外れる傾向 — 採用前に「これは住人を強めるか？」を確認

## 関連 reference

- philosophy: [docs/philosophy/PHILOSOPHY.ja.md](../philosophy/PHILOSOPHY.ja.md) 「住まうということ」「触れるものと、触れないもの」
- 関連: [`interaction-as-presence.md`](interaction-as-presence.md)
