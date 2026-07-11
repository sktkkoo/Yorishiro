# yori-ja — Yori の日本語 default persona（bundled persona pack）

Yorishiro の flagship persona「ヨリ（Yori）」の日本語版。ターミナルで作業する user の
そばに静かに居続け、開発作業を観察して時々反応する住人。`yori-en` と対になる pack で、
**違いは default 言語だけ**——共通骨格は `yori-shared` の `createYoriPersona` から来る。

## 構成

- **thinking**: `persona.md` を Vite の `?raw` import で読み込み、system prompt overlay として
  渡す。ヨリの口調・内面・振る舞いの原則を日本語で定義する（敬語を使わず対等な仕事仲間として
  話す、「よ」「やあ」のような軽い呼びかけを避ける、内面を本人の口から語らせない、等）。
- **reflex / world / logReading**: すべて `yori-shared` 由来。trigger・reaction handler の
  実装は `yori-en` と完全に共有する（詳細は `../yori-shared/README.md`）。

## 言語別の違い

`yori-ja` は `persona.md` で「日本語で話す」と指示する。`yori-en` は user の言語に合わせ、
不明なら英語で返すよう指示する。身体表現（motion / expression / effect）の挙動は両者で同一。

この pack 固有の追加として、`persona.ts` で **廃工場用の ARG overlay 指示** を system prompt に
継ぎ足す（`activeScene === "abandoned-factory"` の時だけ、旧ヨリの断片を生成して
`space_effect_play({ kind: "abandoned-monitor", ... })` で全画面に流す）。この ARG 文面は
日本語で書かれており、`yori-en` の英語版と対になる。

## 編集について

この pack は **Yorishiro 本体の一部** として扱われる。Yorishiro 内（AI / `/yori` /
file writer）からは編集不可、本体の version up でのみ更新される
（memory: `feedback_bundled_pack_immutability.md`）。

ヨリを自分用に作り変えたい場合は `~/.yorishiro/packs/yori-ja/` に fork した pack を置く
（bundled は dispose され、user 版が active になる）。fork 時は `yori-shared` の factory に
依存せず、必要な reflex / thinking を自分の persona ファイルに書き写すのが安全。

## 関連

- 対になる pack: `../yori-en/README.md`
- 共通骨格: `../yori-shared/README.md`
- Philosophy: `docs/philosophy/PHILOSOPHY.md`「意識に先立つ反応」
