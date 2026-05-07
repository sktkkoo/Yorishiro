# User pack は flat layout（.js 強制）

> このファイルは「**user pack を scan / write / `/charm` で create する path** を扱う時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-04-19

## TL;DR

user pack は **flat layout**：`~/.charminal/packs/<id>/<kind>.{js,md}`、`.js` 強制。bundled の **kind-first layout**（`bundled-packs/<kind_plural>/<id>/<kind>.{ts,md}`）と意図的に非対称。Rust の `list_user_packs` は flat 前提で scan する。

## 何を決めたか

- user pack: `~/.charminal/packs/<id>/<kind>.js`（flat、`.js` のみ）
- bundled pack: `bundled-packs/<kind_plural>/<id>/<kind>.ts`（kind-first、`.ts` + tsconfig）
- user 側は `.js` のみ受け付ける（user が TS から自分で transpile）
- Rust `list_user_packs` の scan logic はこの flat 構造前提で書かれている

## なぜそう決めたか

- user 側は **runtime に直接 load** されるため `.js` で良い（TS toolchain は user pack 開発時のみ、runtime 依存にしない）
- bundled 側は **Charminal 開発の build 対象** で `.ts` + tsconfig 拘束、種類別整理が build / test の単位として自然
- 役割が違うので非対称が正解。「対称な方が綺麗」と統合する誘惑に乗らない（[separate-distinct-systems.md](separate-distinct-systems.md)）

## この決定の implication / 制約

- path を書く時 / ドキュメントで例示する時、**user と bundled を混同すると永遠に pack が見つからない**（最頻発の事故）
- `/charm` が user pack を write する時は flat layout に従う
- bundled-packs/ の layout を user-style に合わせない、user-packs/ を kind-first にしない

## 関連 reference

- source: `src-tauri/src/lib.rs:list_user_packs`、`src/runtime/user-pack-loader/`
- 関連: [`bundled-pack-immutability.md`](bundled-pack-immutability.md)、[`separate-distinct-systems.md`](separate-distinct-systems.md)
