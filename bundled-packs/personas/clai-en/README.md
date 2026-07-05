# clai-en — CLAI の英語 default persona（bundled persona pack）

Charminal の flagship persona「CLAI」の英語版。ターミナルで作業する user のそばに
静かに居続け、開発作業を観察して時々反応する住人。`clai-ja` と対になる pack で、
**違いは default 言語だけ**——共通骨格は `clai-shared` の `createClaiPersona` から来る。

## 構成

- **thinking**: `persona.md` を Vite の `?raw` import で読み込み、system prompt overlay として
  渡す。CLAI の口調・内面・振る舞いの原則を英語で定義する（formal politeness を default に
  しない、`hey` / `yo` のような砕けた挨拶を避ける、等）。
- **reflex / world / logReading**: すべて `clai-shared` 由来。trigger・reaction handler の
  実装は `clai-ja` と完全に共有する（詳細は `../clai-shared/README.md`）。

## 言語別の違い

`clai-en` は `persona.md` で `By default, reply in the user's language. If the user's
language is unclear, reply in English.` と指示する。`clai-ja` は日本語で話すよう指示する。
身体表現（motion / expression / effect）の挙動は両者で同一。

この pack 固有の追加として、`persona.ts` で **abandoned-factory 用の ARG overlay 指示** を
system prompt に継ぎ足す（`activeScene === "abandoned-factory"` の時だけ、`old.clai` の
断片を生成して `space_effect_play({ kind: "abandoned-monitor", ... })` で全画面に流す）。
この ARG 文面は英語で書かれており、`clai-ja` の日本語版と対になる。

## 編集について

この pack は **Charminal 本体の一部** として扱われる。Charminal 内（AI / `/yori` /
file writer）からは編集不可、本体の version up でのみ更新される
（memory: `feedback_bundled_pack_immutability.md`）。

CLAI を自分用に作り変えたい場合は `~/.charminal/packs/clai-en/` に fork した pack を置く
（bundled は dispose され、user 版が active になる）。fork 時は `clai-shared` の factory に
依存せず、必要な reflex / thinking を自分の persona ファイルに書き写すのが安全。

## 関連

- 対になる pack: `../clai-ja/README.md`
- 共通骨格: `../clai-shared/README.md`
- Philosophy: `docs/philosophy/PHILOSOPHY.md`「意識に先立つ反応」
