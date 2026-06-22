---
description: 既存の pack を編集・調整する
argument-hint: "[対象の pack や変更内容]"
---

$ARGUMENTS

---

あなたはこれから既存の Charminal pack を編集・調整する。**新規作成は `charm:create` を使う。**

## 概要

既存 pack の編集フロー。user が「ここを直したい」「性格を変えたい」「scene の色を変えたい」と言ったとき、対象 pack を特定し、安全に編集して hot reload で反映する。

壊れそうな変更や複数ファイルにまたがる編集の前には `history_snapshot(label)` を呼び、何をなぜ試すのかが user にも分かる短い label（例: 「夜に使いやすい暗い見た目を試す」）を付ける。復元 UI はこの label を復元地点と直後の変更の主なサマリーとして使う。

## 対象 pack の特定

1. `list_packs()` MCP tool で現在 loaded な pack を確認する
2. user pack は `~/.charminal/packs/<id>/` にある（flat layout: `manifest.json` + `<kind>.js` + 必要なら追加ファイル）
3. **bundled pack は編集不可**（本体の一部、Charminal 更新で上書きされる）。user が改変したい場合は「bundled pack の fork」（後述）を案内する

## セキュリティ境界

- `manifest.json` の `executionClass` が `isolated-js` なら、runtime 未実装なので編集で有効化しない。公開 utility / isolated pack はまだ対象外
- `.js` / `.tsx` entry を持つ user pack は local trusted の `trusted-main-thread-js` として扱う。sandbox 済み・review 済み・Charminal 公開配布用 pack と案内しない
- GitHub 等で source code として共有することは妨げない。ただし手動導入する利用者は local trusted code として自己責任で実行する扱い
- `.js` / `.tsx` entry に `executionClass: "declarative"` を付けない。declarative は JS 評価なしの data-only artifact 用
- pack 内に `fetch` / `fs` / `system.exec` / Tauri API / Node builtin / PTY write を追加しない
- scene asset は pack 内の相対 path のみ。`https:`, `data:`, `file:`, absolute path, `../`, CSS `url(...)` を追加しない

## Persona の編集（backup-then-edit フロー）

persona の編集は最も慎重に扱う。人格文字列を破壊的に上書きせず、**必ず `backup/` に日時付き snapshot を残してから編集する**。いつでも過去の時点に戻せる。

### 手順

1. 対象 persona の `~/.charminal/packs/<id>/persona.md` を Read する
2. `~/.charminal/packs/<id>/backup/` directory が無ければ作る
3. backup file を write する：
   - filename: `persona YYYY-MM-DD HH.MM.SS.md`
     - local time（user の mac の timezone）
     - macOS QuickTime 画面収録 convention — **space と dot を含む**（例: `persona 2026-04-29 14.30.05.md`）
   - 内容: 現 `persona.md` をそのまま copy（一切変更しない）
4. user と相談した新内容で `persona.md` を上書き
5. Charminal の file watcher が hot reload し、PersonaRegistry に反映される（reflex 層の反応も新 persona のものに切替）
6. **完了後、必ず session restart を案内する**（下記参照）

### 過去 snapshot への復元

user が「前の性格に戻したい」と言った場合は、`~/.charminal/packs/<id>/backup/` の中から所望の file を `persona.md` に cp する。backup 一覧を見せて user に選ばせること。

### persona.js の編集

`persona.js` を直接編集する場合（reflex / world / logReading の override を変更するなど）も同様に backup を取る。ただし backup filename は `persona.js YYYY-MM-DD HH.MM.SS.js` とする（拡張子に注意）。

## ⚠️ Persona 編集後の session restart 案内

Charminal 本体側は自動で反映される（PersonaRegistry 更新、reflex 層の反応切替）。**ただし Terminal で走っている Claude Code / Codex の prompt overlay は古いまま**で話し続ける。Charminal は PTY observation-only 原則で走っている session に書き込めない — だから user 自身が新セッションを起動する必要がある。

AI は persona 作業が完了したら **必ず住人の声で案内する**（技術用語は書かない、persona の一人称・口調で自然に）：

> 新しい性格のわたし（ぼく / 俺 / おれ / あたし など persona の一人称で）と出会うには、セッションを新しくする必要があるから `/clear` をしてね。

重要：「systemPrompt」「PTY」「observation-only」のような技術用語は user 向け案内に書かない。住人が自分の声で誘う形に訳して伝える。

## Scene / Effect / UI / Ambient-UI の編集

persona 以外の pack は比較的軽量に編集できる。

1. 対象の `manifest.json` と entry file（`scene.js` / `effect.js` / `ui.js` / `ambient-ui.js`）を Read する
2. user の要望に合わせて修正し、Write する
3. hot reload で即反映される（再起動不要）
4. 編集後 `pack_diagnose({id: "<id>"})` で status / manifest / load error を確認する
5. 現在の workspace が Charminal source checkout なら `npm run check:pack -- ~/.charminal/packs/<id>` を実行し、checker error を修正する

scene の色・layer 構成、effect の parameter 調整、ui のレイアウト変更、ambient-ui の表示調整など、いずれもこのフローで完結する。

## Scene pack のパラメータをリアルタイム調整する

scene pack が SDK controls 経由で F2 の **Scene panel** にパラメータを公開している場合、ファイル編集なしでリアルタイムに値を変えられる。F2 で開く panel は Common（runtime-wide）と Scene（active scene pack 固有）の 2 枚に分かれており、`useCharminalControls` で登録された scene pack の値はすべて Scene panel に出る。

### 調整フロー

1. `controls_get({ scope: "scene" })` で現在のパラメータ一覧を取得する
2. user の要望（「照明もう少し明るくして」「bloom 控えめに」等）に合わせて `controls_set({ scope: "scene", path, value })` で値を変える。複数値は `controls_set_many({ scope: "scene", values })`、滑らかに見せたい調整は `controls_transition({ scope: "scene", values, durationMs })` を使う
3. user が気に入るまで繰り返す
4. 「焼き込んで」と言われたら、現在の全パラメータを `controls_get({ scope: "scene" })` で読み、ソースコードの `useCharminalControls` 定義内の `value:` を書き換える（= 次回起動からその値が default になる）

### path 名の対応

path 名は `controls_get({ scope: "scene" })` の結果に出る `path` をそのまま使う（例: `lights.directionalIntensity`, `post effects.bloom.bloomIntensity`, `effects.dust.moveAmp`）。active scene の id は `state_get()` の `runtime.activeScene` で確認できる。

### どのパラメータが公開されているか

pack 作者が `useCharminalControls` + `useControlsBridge` で登録した値だけが Scene panel に出る。登録していない値はコード内のローカル変数のまま固定される。user が「このパラメータも触りたい」と言ったら、ソースに `useCharminalControls` の項目を追加すればよい。

## Bundled pack の fork

bundled pack は read-only（本体の一部、編集不可）。user が改変したい場合は user pack directory にコピーして独立 pack として管理する。

### Fork 手順

1. bundled pack のソースを `bundled_example_read` MCP tool で読む（id を渡す。id は `list_packs` で確認）。packaged build でも読める。cwd が Charminal repo のときは `bundled-packs/<kind_plural>/<id>/`（`personas/`・`scenes/`・`effects/`・`ui/`・`ambient-ui/`）を直接 Read してもよい。
2. `~/.charminal/packs/<new-id>/` に `manifest.json` + entry file を作成する
3. manifest の `id` を `<new-id>` に変更し、`.js` / `.tsx` entry なら `"executionClass": "trusted-main-thread-js"` を入れる（元の id のままだと bundled と衝突する）
4. entry file の中の `id` も `<new-id>` に揃える
5. 必要に応じて `~/.charminal/config.json` の active 設定を `<new-id>` に切り替える
   - scene: `"activeScene": "<new-id>"`
   - persona: `"primaryPersona": "<new-id>"`
   - ui: `"activeUi": "<new-id>"`

fork 後は元の bundled pack とは独立した user pack として扱われる。bundled の更新は反映されない（user の責任で管理する）。

## config.json の編集

`~/.charminal/config.json` で Charminal 全体の設定を変更できる。

- `activeScene` — active な scene pack の id
- `primaryPersona` — active な persona pack の id
- `disabledPacks` — 無効化された pack id の配列

```json
{
  "activeScene": "my-scene",
  "primaryPersona": "my-persona",
  "disabledPacks": ["broken-pack"]
}
```

`config.json` が存在しないときは空 object `{}` で作成し、必要な field を追加する。存在するときは既存の field を保持しつつ該当 field だけを更新する。

## MCP tool での検証

編集後は MCP tool で状態を確認する：

- `list_packs()` — 現在 loaded / disabled / failed な pack を列挙。編集後の status 確認に使う
- `pack_diagnose({id})` — 1 つの pack の status / manifest / load error / 修復ヒントをまとめて確認する
- `list_load_errors()` — validation エラーの詳細。pack が load されない場合はここで原因を特定
- `disable_pack({id})` — 壊れた pack を即時切り離し（config に記録 + runtime dispose）。修正中に他の pack への影響を防ぐ
- `enable_pack({id})` — 切り離した pack を復帰

## Rescue — safe mode

pack の編集で Charminal が起動しなくなった場合は safe mode で起動する：

```
CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app
```

safe mode では user pack が一切 load されず、window title に ` (Safe Mode)` が付く。この状態で MCP tool は使える（`list_load_errors()` で原因特定、`disable_pack({id})` で切り離し）。env var を外して再起動すれば `disabledPacks` にある pack だけ skip され、他は復帰する。
