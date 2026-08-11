# User packはflat layout（通常.js、一部kindは.tsx）

> このファイルは「**user pack を scan / write / `/yori` で create する path** を扱う時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-08-12

## TL;DR

user packは**flat layout**：`~/.yorishiro/packs/<id>/<kind>.js`が基本で、`scene` / `ui` / `ambient-ui`だけは`.tsx`も選べる。bundledの**kind-first layout**（`bundled-packs/<kind_plural>/<id>/`）とは意図的に非対称であり、Rustの`list_user_packs`はflat前提でscanする。

## 何を決めたか

- user pack: `~/.yorishiro/packs/<id>/<kind>.js`（flat）が基本。`scene` / `ui` / `ambient-ui`はlocal trusted sourceとして`.tsx` entryも選べる
- bundled pack: `bundled-packs/<kind_plural>/<id>/<kind>.ts`（kind-first、`.ts` + tsconfig）
- user 側の`.js`は作者が事前compileする。`scene.tsx` / `ui.tsx` / `ambient-ui.tsx`だけは限定runtime compilerを通す
- Rust `list_user_packs` の scan logic はこの flat 構造前提で書かれている

## なぜそう決めたか

- user 側の通常entryは **runtime に直接 load** されるため`.js`とする。React/R3F authoringが必要な3 kindだけは、host moduleとPack内sourceに閉じたruntime `.tsx`経路を持つ
- bundled 側は **Yorishiro 開発の build 対象** で `.ts` + tsconfig 拘束、種類別整理が build / test の単位として自然
- 役割が違うので非対称が正解。「対称な方が綺麗」と統合する誘惑に乗らない（[separate-distinct-systems.md](separate-distinct-systems.md)）

## この決定の implication / 制約

- path を書く時 / ドキュメントで例示する時、**user と bundled を混同すると永遠に pack が見つからない**（最頻発の事故）
- `/yori` が user pack を write する時は flat layout に従う
- bundled-packs/ の layout を user-style に合わせない、user-packs/ を kind-first にしない
- `.tsx`経路の正確なimport/asset/version contractは[`local-source-authoring-contract.md`](local-source-authoring-contract.md)を正本とする

## 関連 reference

- source: `src-tauri/src/lib.rs:list_user_packs`、`src/runtime/user-pack-loader/`
- 関連: [`bundled-pack-immutability.md`](bundled-pack-immutability.md)、[`separate-distinct-systems.md`](separate-distinct-systems.md)
