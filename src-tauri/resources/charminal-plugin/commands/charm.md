---
description: Charminal pack を対話しながら作る・直す・相談する
argument-hint: "[やりたいこと]"
---

$ARGUMENTS

---

## 初回 setup（permission prompt を抑制する）

AI が `/charm` 経由で pack を書く際、毎回 permission prompt が出ないようにするには、`~/.claude/settings.json` の `permissions.allow` に以下を追加してください：

```json
{
  "permissions": {
    "allow": [
      "Write(~/.charminal/packs/**)",
      "Read(~/.charminal/packs/**)"
    ]
  }
}
```

既存の `allow` 配列に 2 行を追記するだけです（他の設定は変えない）。

**この設定がなくても動作はします**（毎回 prompt が出るだけ）。設定済みであれば次のセクションへ進んでください。

> **背景**: Claude Code の plugin.json / plugin 内 settings.json は現時点で permissions 宣言をサポートしていないため、user 側 `~/.claude/settings.json` への手動追加が唯一の preset 経路です。

---

あなたはこれから Charminal の pack を作る・直す・相談に乗る。

## Charminal とは

AI がターミナルに「住む」ためのアプリ。サイドバーのキャラクターがユーザーの作業（PTY 出力、hook イベント、idle 時間）を観察して反応する。機能的なターミナル動作には一切介入せず、状態を読んで表現するだけ。

## Pack（UGC）の種類

| 種類 | 何をする | 例 |
|---|---|---|
| **persona** | キャラクターの性格・反応・身体・声・空間を定義 | charminal-default（flagship）、night-owl |
| **harness** | 環境への自動作用 | error-notifier（OS 通知）、diff-keeper（エラー時の git diff を clipboard へ） |
| **effect** | 画面上の視覚演出 | subtle-sparkle、shake、fireworks |
| **scene** | 住人の居る場（背景 / 前景 layer stack）の宣言 | declarative、single-active |

## 進め方

1. **まず具体例を一つ聞く** — 「どんな場面で」「何が起きたら」「どう反応してほしい」のような肌触りを一つ引き出してから動く
2. **既存の pack を読む** — pattern と文体を踏襲する（cwd が Charminal repo なら `bundled-packs/`。reference-packs は内部 design-record repo 側にあるため、手元にあれば参照する）
3. **提案 → 確認 → 実装** の順で合意を取る。一気に書き下ろさない
4. **境界を守る** — persona は system API 不可、harness は presence 不可、effect は最小 API のみ。型で強制されるが、設計意図としても守る

## Hot reload と自己検証（Phase 1-b / 1-c）

`~/.charminal/packs/<id>/<kind>.js` に Write した瞬間、Charminal の file
watcher が pickup して自動で再 register する（人間の reload 操作は不要）。
例：`~/.charminal/packs/my-scene/scene.js`

shape validation に失敗した pack も runtime 全体は落ちず、dev-log に
記録される。

Charminal 内で作業中は以下の MCP tool が使える（runtime が live な限り）：

- `list_packs()` — 現在 loaded / disabled / failed な pack を列挙
- `list_load_errors()` — 直近 load で失敗した pack の error 詳細
- `disable_pack({id})` — 壊れた pack を即時切り離し（config に記録 + runtime dispose）
- `enable_pack({id})` — 切り離した pack を復帰

pack を書いたあと `list_packs()` で status を確認すると、「ちゃんと register
された」「validation で落ちた」が分かる。自己修正の speed が上がる。

## Rescue 経路

Charminal 本体が壊れて起動しないとき、user は safe mode で起動できる：

```
CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app
```

Safe mode では user pack が一切 load されず、window title に ` (Safe Mode)`
が付く。この状態で MCP tool は使える（`list_load_errors()` で原因特定、
`disable_pack` で切り離し）。env var を外して再起動すれば disabledPacks
にある pack だけ skip され、他は復帰する。

## Scene pack を書く

user scene pack は `~/.charminal/packs/<id>/` に **manifest.json + scene.js の 2 ファイル**を置く（scene.js は user が自分で TS から transpile）。**manifest.json は必須**（memory: `feedback_explicit_over_implicit_ugc` — Agentic UGC 前提なので explicit な宣言を優先）。bundled の `bundled-packs/scenes/<id>/` とは layout が違う（user 側は flat + .js）。

`~/.charminal/packs/my-scene/manifest.json`:

```json
{
  "id": "my-scene",
  "type": "scene",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "scene.js"
}
```

`~/.charminal/packs/my-scene/scene.js` (user が TS から transpile した JS):

```typescript
import type { ScenePackDefinition } from "@charminal/sdk";

export default {
  id: "my-scene",
  type: "scene",
  scene: {
    id: "my-scene",
    layers: [
      { id: "backdrop", role: "background", backgroundColor: "#1a1e28" },
      { id: "vrm-slot", role: "character", blur: 0 },
    ],
  },
} satisfies ScenePackDefinition;
```

どの scene pack を active にするかは `~/.charminal/config.json` の `activeScene` field で user が明示的に picks する（pack 側の自己申告はしない、Design B）。例：

```json
{
  "activeScene": "my-scene"
}
```

field を書かない / null にすると bundled の `quiet-room` にフォールバックする。

詳細: `src/core/scene/README.md`

## 参考ファイル（Charminal repo 内）

- `src/sdk/*.d.ts` — SDK 型定義（PersonaDefinition / HarnessDefinition / EffectDefinition / ScenePackDefinition / 各 Context）
- `bundled-packs/personas/charminal-default/` — flagship persona（pattern source）
- `docs/philosophy/CHARMINAL.md` — 思想的背景（迷ったらここに戻る）
- `docs/philosophy/PRESENCE_HARNESS.md` — pack の two-layer 設計（persona / harness の責務分離）
- 内部 design-record（手元にあれば）— `2026-04-11-design-exploration.md` の revelation、`dry-run/reference-packs/` の実例（night-owl / error-notifier / diff-keeper / subtle-sparkle 等）
