---
description: 新しい pack（persona / scene / effect / ui / ambient-ui）を対話で作る
argument-hint: "[作りたいもの]"
---

$ARGUMENTS

---

あなたはこれから Charminal の **新しい pack** を対話しながら作る。

## Charminal とは

AI がターミナルに「住む」ためのアプリ。サイドバーのキャラクターがユーザーの作業（PTY 出力、hook イベント、idle 時間）を観察して反応する。機能的なターミナル動作には一切介入せず、状態を読んで表現するだけ。

## Pack の種類

| 種類 | 何をする | 例 |
|---|---|---|
| **persona** | キャラクターの性格・反応・身体・声・空間を定義（md-first、manifest.json + persona.md + minimal persona.js） | charminal-default |
| **effect** | 画面上の視覚演出 | subtle-sparkle、shake、fireworks |
| **scene** | 住人の居る場（背景 / 前景 layer stack）の宣言 | quiet-room、radiant-meadow |
| **ui** | サイドバーの主要 UI パネル（設定画面等）。single-active | charminal-settings、camera-lighting-panel |
| **ambient-ui** | 常時表示のオーバーレイ UI。multi-active | attention-aura |

## 進め方

1. **まず具体例を一つ聞く** — 「どんな場面で」「何が起きたら」「どう反応してほしい」のような肌触りを一つ引き出してから動く
2. **既存の pack を読む** — pattern と文体を踏襲する（cwd が Charminal repo なら `bundled-packs/` を参照）
3. **提案 → 確認 → 実装** の順で合意を取る。一気に書き下ろさない
4. **境界を守る** — persona は system API 不可、effect は最小 API のみ、scene は宣言のみ、ui / ambient-ui は描画と state のみ。型で強制されるが、設計意図としても守る

## Hot reload と自己検証

`~/.charminal/packs/<id>/<kind>.js` に Write した瞬間、Charminal の file watcher が pickup して自動で再 register する（人間の reload 操作は不要）。例：`~/.charminal/packs/my-effect/effect.js`

shape validation に失敗した pack も runtime 全体は落ちず、dev-log に記録される。

Charminal 内で作業中は以下の MCP tool が使える（runtime が live な限り）：

- `list_packs()` — 現在 loaded / disabled / failed な pack を列挙
- `list_load_errors()` — 直近 load で失敗した pack の error 詳細
- `disable_pack({id})` — 壊れた pack を即時切り離し（config に記録 + runtime dispose）
- `enable_pack({id})` — 切り離した pack を復帰

pack を書いたあと `list_packs()` で status を確認すると、「ちゃんと register された」「validation で落ちた」が分かる。自己修正の speed が上がる。

## Rescue 経路

Charminal 本体が壊れて起動しないとき、user は safe mode で起動できる：

```
CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app
```

Safe mode では user pack が一切 load されず、window title に ` (Safe Mode)` が付く。この状態で MCP tool は使える（`list_load_errors()` で原因特定、`disable_pack` で切り離し）。env var を外して再起動すれば disabledPacks にある pack だけ skip され、他は復帰する。

## Scene pack を書く

user scene pack は `~/.charminal/packs/<id>/` に **manifest.json + scene.js の 2 ファイル**を置く。**manifest.json は必須**（Agentic UGC 前提なので explicit な宣言を優先）。bundled の `bundled-packs/scenes/<id>/` とは layout が違う（user 側は flat + .js）。

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

`~/.charminal/packs/my-scene/scene.js`:

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

どの scene pack を active にするかは `~/.charminal/config.json` の `activeScene` field で user が明示的に picks する（pack 側の自己申告はしない、Design B — config picks）。例：

```json
{
  "activeScene": "my-scene"
}
```

field を書かない / null にすると bundled の `quiet-room` にフォールバックする。

詳細: `src/core/scene/README.md`

## Persona pack を書く

user persona pack は `~/.charminal/packs/<id>/` に **manifest.json + persona.md + minimal persona.js** の 3 ファイルを置く。systemPromptAddition は persona.md に書き、loader が自動で `thinking.systemPromptAddition` に inject する。

persona は **single-active** — 同時に 1 人だけ active。どの persona を active にするかは `~/.charminal/config.json` の `primaryPersona` で user が picks する。

### persona.js と persona.md の関係（md-first flow）

- **`persona.md`**: キャラクターの人格文字列の canonical source。loader が read して `thinking.systemPromptAddition` に自動注入
- **`persona.js`**: shape の core（id / name / 任意の reflex / world / logReading）。`thinking.systemPromptAddition` を明示的に書けばそちらが優先、無ければ persona.md から注入される
- bundled `charminal-default` も同じ layout（persona.ts が persona.md を Vite `?raw` で import、user pack は loader が runtime に fetch）

### 新規 persona の作り方

1. user と相談して persona の id / name / 性格の方向性を決める
2. 既存 primaryPersona を今から作る persona に差し替えるか、作るだけで切り替えはしないかを user に確認
3. bundled template を read: `bundled-packs/personas/charminal-default/persona.md`
4. user pack directory に 3 ファイルを用意：

`~/.charminal/packs/<id>/manifest.json`:

```json
{
  "id": "<id>",
  "type": "persona",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "persona.js"
}
```

`~/.charminal/packs/<id>/persona.md` — bundled template の内容で初期化し、user 要望に合わせて編集

`~/.charminal/packs/<id>/persona.js` — minimal shape:

```javascript
export default {
  id: "<new-persona-id>",
  name: "<display name>",
  // thinking.systemPromptAddition は persona.md から loader が自動注入
  // reflex / world / logReading は override したい時だけ書く（無ければ bundled default が適用）
};
```

5. 切り替える場合は `~/.charminal/config.json` の `primaryPersona` を新 id に更新
6. **完了後、user にセッション再起動の案内を出す**（下記参照）

### ⚠️ 反映には新セッション起動が必要

persona の新規作成後、Charminal 本体側は自動で反映される（PersonaRegistry 更新、reflex 層の反応切替）。**ただし Terminal で走っている Claude Code の systemPrompt は古いまま**で話し続ける。Charminal は PTY observation-only 原則で走っている session に書き込まないため、user 自身が新セッションを起動する必要がある。

AI は persona 作業が完了したら **必ず user に住人の声で案内する**（技術用語は書かない、persona の一人称・口調で自然に）：

> 新しい性格のわたし（ぼく / 俺 / おれ / あたし など persona の一人称で）と出会うには、セッションを新しくする必要があるから `/clear` をしてね。

重要：「systemPrompt」「PTY」「observation-only」のような技術用語は user 向け案内に書かない。住人が自分の声で誘う形に訳して伝える。

## Effect pack を書く

user effect pack は `~/.charminal/packs/<id>/` に **manifest.json + effect.js**（必要なら `assets/` も）を置く。effect は **declarative に呼ばれる存在**（persona の handler から `ctx.space.injectEffect({ kind: <pack-id> })` で起動される。effect 自身は trigger を持たない）。

`~/.charminal/packs/my-glow/manifest.json`:

```json
{
  "id": "my-glow",
  "type": "effect",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "effect.js"
}
```

`~/.charminal/packs/my-glow/effect.js`:

```typescript
import type { EffectDefinition, EffectContext, Vec2 } from "@charminal/sdk";

interface MyGlowOptions {
  origin: Vec2;
  count?: number;
  durationMs?: number;
}

export default {
  id: "my-glow",
  type: "effect",
  run: async (ctx: EffectContext<MyGlowOptions>, options) => {
    const { origin, count = 20, durationMs = 800 } = options;
    const particles = ctx.renderer.addParticles({
      origin,
      count,
      durationMs,
      colorScheme: "silver",
    });
    await ctx.time.after(durationMs);
    particles.dispose();
  },
} satisfies EffectDefinition<MyGlowOptions>;
```

### persona から呼ぶ

persona handler 内で：

```typescript
ctx.space.injectEffect({
  kind: "my-glow",
  options: { origin: { x: 100, y: 200 } },
});
```

`kind` に effect pack の id を指定。built-in effect（`shake` / `flash` / `particles` / `fireworks` / `text-physics` / `text-glitch`）も同じ API で呼ばれる。

### 境界

effect は **最小 API**：`ctx.character` / `ctx.voice` / `ctx.space.injectEffect`（他 effect の chain 呼び出し）/ `ctx.system` / `ctx.log` / `ctx.memory` はいずれも持たない。**state を持たない short-lived な rendering 単位**。options として persona から渡す。

## UI pack を書く

ui pack はサイドバーに表示される主要 UI パネル。**single-active**（同時に 1 つだけ active）。どの ui pack を active にするかは `~/.charminal/config.json` の `activeUi` で user が picks する。

`~/.charminal/packs/my-panel/manifest.json`:

```json
{
  "id": "my-panel",
  "type": "ui",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "ui.js"
}
```

ui pack は React コンポーネントを export する。`UiContext` を受け取り、`ctx.state` で永続化可能な key-value store を使える。`ctx.emitEvent()` で trigger loop に synthetic event を流すことも可能。

bundled の参考実装: `bundled-packs/ui/charminal-settings/`、`bundled-packs/ui/camera-lighting-panel/`

### 境界

ui pack は **描画と state 管理のみ**。`ctx.system` / `ctx.character` / `ctx.voice` は持たない。terminal への pre-fill は `TerminalPromptButton` コンポーネント経由で行う（PTY write を UI から直接呼ぶ唯一の経路）。

## Ambient-UI pack を書く

ambient-ui pack は常時表示のオーバーレイ UI。**multi-active**（複数を同時に active にできる）。Three.js の scene 上に直接描画するか、HTML overlay として配置する。

`~/.charminal/packs/my-overlay/manifest.json`:

```json
{
  "id": "my-overlay",
  "type": "ambient-ui",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "ambient-ui.js"
}
```

bundled の参考実装: `bundled-packs/ambient-ui/attention-aura/`

### 境界

ambient-ui は **renderer と attention 情報のみ**。persona / system API は持たない。常時表示される性質上、パフォーマンスに注意すること。

## 参考ファイル（Charminal repo 内）

- `src/sdk/*.d.ts` — SDK 型定義（PersonaDefinition / EffectDefinition / ScenePackDefinition / UiPackDefinition / AmbientUiPackDefinition / 各 Context）
- `bundled-packs/personas/charminal-default/` — flagship persona（pattern source）
- `bundled-packs/ui/` — UI pack の参考実装
- `bundled-packs/ambient-ui/` — ambient-ui pack の参考実装
- `docs/philosophy/CHARMINAL.md` — 思想的背景（迷ったらここに戻る）
- `docs/philosophy/PRESENCE_HARNESS.md` — pack の two-layer 設計
