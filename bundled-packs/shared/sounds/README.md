# bundled-packs/shared/sounds/ — 共有 ambient sound library

Scene Pack の `ambient` 宣言から `'sound:<name>'` で参照する shared library。

## Layout

- **flat root**: 汎用 ambient (雨・風・遠雷など、複数 scene で curated に reuse する set)
  - 例: `rain.mp3` → `'sound:rain'`
- **一段 namespace**: 特定 pack 由来の distinctive な音 / 将来の music。namespace は pack id 推奨 (enforce はしない)
  - 例: `lofi-vibes/cafe-loop.mp3` → `'sound:lofi-vibes/cafe-loop'`
- **二段以上は不可**。`shared/sounds/a/b/c.mp3` のような深い階層は対象外 (Vite glob `{*,*/*}` で限定)

## 命名規則

- `kebab-case` (例: `distant-thunder.mp3`、`window-creak.mp3`)
- 拡張子は `mp3` / `wav` / `ogg` / `m4a` のみ
- ファイル名は case-sensitive で扱われるので **小文字推奨**（`Rain.MP3` は glob にひっかからない）

## 衝突検出

`src/runtime/ambient-audio/sound-resolver.ts` の `buildSharedSoundMap` が module init 時に stem 衝突を throw します:

- `rain.mp3` と `rain.wav` の同居 → throw (拡張子違いで同 stem)
- `lofi-vibes/cafe.mp3` と `lofi-vibes/cafe.wav` の同居 → throw
- `rain.mp3` と `lofi-vibes/rain.mp3` → OK (namespace 違い、ref も `'sound:rain'` vs `'sound:lofi-vibes/rain'`)

dev / CI / production build どのフェーズでも即時に発覚します。エラーメッセージには衝突する両方のファイルパスが含まれます。

## Credits / Licenses

同梱音源とその出典 / license。新しい音源を追加するときは必ずこの table に行を追加すること。

| File | Source | License |
|---|---|---|
| `calming-rain.mp3` | [Pixabay](https://pixabay.com/) | [Pixabay Content License](https://pixabay.com/service/license-summary/) (帰属不要・商用 OK) |

Scene-local assets are credited beside the scene pack. For example,
`bundled-packs/scenes/abandoned-factory/assets/abandoned-factory_piano-loop.mp3`
is covered by `bundled-packs/scenes/abandoned-factory/assets/LICENSE`.

## 関連

- 仕様: `Yorishiro-design-record/specs/2026-04-25-scene-ambient-audio-design.md`
- 使い方 (Pack 作者向け): `src/sdk/README.md` の Scene Pack section
