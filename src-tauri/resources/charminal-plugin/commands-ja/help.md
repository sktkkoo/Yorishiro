---
description: charm コマンドの使い方・pack の種類・MCP tool 一覧
argument-hint: "[知りたいこと]"
---

$ARGUMENTS

---

Charminal charm コマンドのリファレンスガイド。user の質問（`$ARGUMENTS`）があれば該当セクションを中心に回答し、なければ全体を簡潔に案内する。

---

## 初回 setup（permission prompt を抑制する）

AI が `/create` や `/update` 経由で pack を書く際、毎回 permission prompt が出ないようにするには、`~/.claude/settings.json` の `permissions.allow` に以下を追加する：

```json
{
  "permissions": {
    "allow": [
      "Write(~/.charminal/packs/**)",
      "Read(~/.charminal/packs/**)",
      "Write(~/.charminal/init.js)",
      "Read(~/.charminal/init.js)"
    ]
  }
}
```

既存の `allow` 配列に 4 行を追記するだけ（他の設定は変えない）。`init.js` は keyboard shortcut などを仕掛ける startup script（`/shortcut` 参照）。

**この設定がなくても動作する**（毎回 prompt が出るだけ）。

---

## charm コマンド一覧

| コマンド | 説明 |
|---|---|
| `/create` | 新しい pack を対話で作る |
| `/update` | 既存の pack を編集・調整する |
| `/help` | このリファレンスを表示する |
| `/shortcut` | キーボードショートカットの追加・編集（init.js） |

各コマンドは引数付きで呼べる。例：`/create 猫耳のペルソナ`、`/update my-scene の背景色を暗くして`。

---

## Pack の種類

| 種類 | 何をする | active 数 | config key |
|---|---|---|---|
| **persona** | キャラクターの性格・反応・身体・声を定義 | single | `primaryPersona` |
| **effect** | 視覚演出（パーティクル、shake 等） | multi（event-driven） | — |
| **scene** | 背景 / 前景の layer stack | single | `activeScene` |
| **ui** | サイドバーの主要 UI パネル | single | `activeUi` |
| **ambient-ui** | 常時表示のオーバーレイ UI | multi | — |

- persona / scene / ui は **single-active**：`~/.charminal/config.json` の config key で user が明示的に選ぶ
- effect / ambient-ui は **multi-active**：persona handler から呼ばれる（effect）、常時表示される（ambient-ui）

---

## Pack のファイル構成

配置先: `~/.charminal/packs/<id>/`

必須ファイル:

| ファイル | 役割 |
|---|---|
| `manifest.json` | id / type / version / entry の宣言（全 pack 共通） |
| `<kind>.js` | pack 本体（persona.js / effect.js / scene.js / ui.js / ambient-ui.js） |
| `persona.md` | **persona のみ**。キャラクター人格の canonical source |

`manifest.json` の共通 fields:

```json
{
  "id": "<pack-id>",
  "type": "<persona | effect | scene | ui | ambient-ui>",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "<kind>.js"
}
```

- user pack は `.js` のみ（TS から transpile する）
- bundled pack とは layout が異なる（bundled は `bundled-packs/<kind_plural>/<id>/`、user は flat `~/.charminal/packs/<id>/`）

---

## MCP tool 早見表

Charminal が起動中であれば以下の MCP tool が使える。

### Pack 管理

| tool | 引数 | 説明 |
|---|---|---|
| `list_packs()` | — | loaded / disabled / failed な pack を列挙 |
| `list_load_errors()` | — | 直近 load で失敗した pack の error 詳細 |
| `enable_pack({id})` | pack id | 切り離した pack を復帰 |
| `disable_pack({id})` | pack id | 壊れた pack を即時切り離し |

### UI state / パラメータ調整

| tool | 引数 | 説明 |
|---|---|---|
| `controls_get({scope, path?})` | scope（`scene`/`common`）, path（省略可） | F2 panel に出ているパラメータを読む |
| `controls_set({scope, path, value})` | scope, path, value | F2 panel のパラメータを書く（即反映） |
| `controls_set_many({scope, values})` | scope, values | F2 panel の複数パラメータをまとめて書く |
| `controls_transition({scope, values, durationMs})` | scope, values, durationMs | 数値パラメータを滑らかに補間する |

F2 で開く debug panel は 2 枚に分かれている：**Common panel**（runtime-wide。base camera など）と **Scene panel**（active scene pack 固有。lighting / post effect / scene layer の background・foreground / camera modulation など）。`useCharminalControls` + `useControlsBridge` で登録された scene pack の値は Scene panel に出る。

scene pack は照明・エフェクト・ポストプロセスなどのパラメータを SDK controls 経由で Scene panel に公開している（`useCharminalControls` + `useControlsBridge` で登録されたもの）。`controls_set({ scope: "scene", path, value })` で値を変えると画面に即反映される。user と相談しながらリアルタイムで調整し、「焼き込んで」と言われたら現在の値をソースの default に書き込む（= 次回起動からその値になる）。

Common camera の `camera.x` / `camera.y` / `camera.z` / `camera.targetX` / `camera.targetY` / `camera.targetZ` を controls 経由で書くと、tracking は自動で Off になり実カメラへ即反映される。滑らかにカメラを動かすデモは `controls_transition({ scope: "common", ... })` を使う。

ui pack は `ctx.state` で独自の key-value を持ち、`get_ui_state` / `set_ui_state` で読み書きできるが Scene panel には出ない（Scene panel は scene pack の `ControlStore` のみ表示）。

### キャラクター操作

| tool | 引数 | 説明 |
|---|---|---|
| `body_expression_set(...)` | expression params | キャラの表情を設定 |
| `body_animation_play(...)` | animation params | アニメーション再生 |
| `body_motion_cancel()` | — | モーション中止 |

### 空間操作

| tool | 引数 | 説明 |
|---|---|---|
| `space_effect_play(...)` | effect params | 視覚エフェクト再生 |
| `scene_screenshot(...)` | camera override? | scene canvas を撮影 |

カメラ移動は `controls_transition({ scope: "common", values, durationMs })` を使う。lighting / post effect / scene layer blur・opacity / camera modulation は `controls_get({ scope: "scene" })` で path を確認し、`controls_set` / `controls_transition` で調整する。

### UI 操作

| tool | 引数 | 説明 |
|---|---|---|
| `ui_sidebar_set(...)` | width, durationMs? | サイドバー幅を設定（px、durationMs で滑らか補間） |
| `ui_terminal_set(...)` | opacity, durationMs? | ターミナル透明度を設定（durationMs で滑らか補間） |

### 全体 state

| tool | 引数 | 説明 |
|---|---|---|
| `state_get()` | — | runtime 全体の state snapshot |

---

## SDK 型の概要

pack 開発時に参照する型定義の所在:

| ファイル | 内容 |
|---|---|
| `src/sdk/context.d.ts` | PersonaContext / EffectContext / UiContext / AmbientUiContext |
| `src/sdk/reaction.d.ts` | DispatchEvent / TriggerMatch / ReactionType |
| `docs/catalogs/standard-hooks.md` | 標準 hook / DispatchEvent の分類と使い方 |
| `src/sdk/pack.d.ts` | PersonaDefinition / EffectDefinition / ScenePackDefinition / UiPackDefinition / AmbientUiPackDefinition |

full API doc は `npm run doc`（typedoc）で生成できる。

---

## 境界ルール（早見表）

pack 種類ごとに使えない API が型レベルで強制されている。

| pack 種類 | 使えない API | 理由 |
|---|---|---|
| **persona** | `ctx.system.*` | 環境操作は別の責務 |
| **effect** | ほぼ全部（renderer + audio + time のみ） | state を持たない short-lived rendering 単位 |
| **scene** | handler 無し（宣言のみ） | 純粋なデータ定義 |
| **ui** | `ctx.system` / `ctx.character` / `ctx.voice` | 描画と state 管理のみ |
| **ambient-ui** | persona / system API | renderer と attention 情報のみ |

- handler 内から新 reaction を起こしたい場合 → `ctx.emitEvent()` で **synthetic event** を announce、trigger match 経由で発火

---

## キーボードショートカット

| キー | 動作 |
|---|---|
| **F1**（またはサイドバーボタン） | 設定画面の開閉 |
| **F2** | debug panel（Common / Scene）の表示切り替え |
| **Cmd+T** | 新しいシェルタブを開く |
| **Cmd+W** | アクティブなタブを閉じる（メインタブは閉じられない） |
| **Ctrl+Tab / Ctrl+Shift+Tab** | 次／前のタブに切り替え |
| **Cmd+1〜9** | N 番目のタブにジャンプ |

`init.js` でカスタムショートカットを追加できる（`/charm:shortcut` 参照）。

---

## よくある質問への誘導

| やりたいこと | 案内先 |
|---|---|
| pack を新しく作りたい | `/create` |
| 既存 pack を直したい | `/update` |
| ショートカットを追加したい | `/shortcut` |
| pack が壊れて起動しない | safe mode: `CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app` |

safe mode では user pack が一切 load されず、MCP tool（`list_load_errors()` / `disable_pack()`）で原因特定と切り離しができる。env var を外して再起動すれば disabledPacks 以外は復帰する。

---

## 参考ファイル

| ファイル | 内容 |
|---|---|
| `src/sdk/README.md` | SDK ドキュメント（Twin-trigger co-emission idiom 等） |
| `docs/catalogs/standard-hooks.md` | 標準 hook / DispatchEvent カタログ |
| `bundled-packs/` | bundled pack の実例（pattern source） |
| `docs/philosophy/CHARMINAL.md` | 思想的背景 |
