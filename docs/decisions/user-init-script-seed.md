# ~/.charminal/init.js の seed 方針

> このファイルは「**init.js が初回起動でどう現れるか / Charminal が上書きする条件**」を決める時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-04-19

## TL;DR

`~/.charminal/init.js` は Charminal が **存在しないときだけ** 雛形を write する。存在すれば内容が空でも触らない。雛形は `src-tauri/resources/user-init-template.js` に置き、`include_str!` で binary に埋め込む。`~/.charminal/` を app bundle 内に置く案は採らない（OS が system-owned として扱う領域を user editable にする破壊性が大きすぎる）。

## 何を決めたか

- `~/.charminal/init.js` は `ensure_charminal_dirs()` の一部として seed する
- seed 条件は **「file が存在しないとき」のみ**。存在すれば中身を問わず touch しない（空 file でも保護）
- 雛形実体は `src-tauri/resources/user-init-template.js`。`USER_INIT_TEMPLATE` 定数が `include_str!` で埋め込む
- `~/.charminal/sdk.d.ts` とは **意図的に非対称**：sdk.d.ts は毎起動上書き（user 編集対象ではない）、init.js は seed-once（user editable）

## なぜそう決めたか

- charm.md で keyboard shortcut の導線を `init.js` 経由で紹介している以上、インストール直後から file が存在している方が barrier が低い（Agentic UGC 前提の設計方針（[explicit-over-implicit-ugc.md](explicit-over-implicit-ugc.md)）で「設定編集は AI 前提で barrier にならない」立場でも、file が存在しないと AI が「まず作ってから」と迂回する分 step が増える）
- 一方で「app resource / `public/` に置く」案は **OS signed bundle を user editable にする** ことを意味し、macOS では署名破壊・app update で消滅・sandbox 違反を引き起こす。`~/.emacs.d/` を Emacs のインストール先に置かないのと同じ理屈
- 「存在すれば触らない」を強制するのは、空 file でも user の意思表示（「何も要らない」）として尊重するため。`~/.charminal/sdk.d.ts` と違い init.js は user の territory

## 検討したが却下した代替案

- **`~/.charminal/` 全体を app bundle 内（`public/` など）に置く** — macOS signed bundle の署名破壊、app 再インストール / update で user 編集が消滅、sandbox 違反の三重苦
- **毎起動上書き（sdk.d.ts と同じ挙動）** — user 編集が消える。init.el を Emacs が書き換える世界線と同じで受け入れられない
- **空だったら上書き** — user が「何も要らないので空」とした意思を無視する。「存在 = user が管轄済み」の単純規則を採る
- **seed しない（DIY 路線）** — charm.md の example を copy-paste する前に mkdir + touch + 空関数定義が必要になり、AI が書くにしても step が増える

## この決定の implication / 制約

- 雛形の内容を増やす（例：keyboard shortcut の commented-out snippet を足す）時は、既に seed 済みの user を上書きしない性質上、**新規インストール or 消去後の next-launch まで届かない**。雛形 update は「すぐに行き渡る」ものではない
- charm.md の init.js section は「雛形が既にある」前提で書ける（編集ガイドに寄せられる）
- Rust 側に `seed_user_init_script_impl(&home) -> Result<(), String>` が pure 関数として露出している。env var を触らずに test 可能

## 関連 reference

- 実装: `src-tauri/src/lib.rs` の `USER_INIT_TEMPLATE` / `seed_user_init_script_impl` / `ensure_charminal_dirs`
- 雛形: `src-tauri/resources/user-init-template.js`
- 関連: [`bundled-pack-immutability.md`](bundled-pack-immutability.md)、[`user-pack-layout.md`](user-pack-layout.md)、[`explicit-over-implicit-ugc.md`](explicit-over-implicit-ugc.md)
- guide: `src-tauri/resources/charminal-plugin/commands/charm.md`「init.js（keyboard shortcut / startup hook）」
