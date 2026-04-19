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
| **persona** | キャラクターの性格・反応・身体・声・空間を定義（md-first、manifest.json + persona.md + minimal persona.js） | charminal-default（flagship）、night-owl |
| **harness** | 環境への自動作用 | error-notifier（OS 通知）、diff-keeper（エラー時の git diff を clipboard へ） |
| **effect** | 画面上の視覚演出 | subtle-sparkle、shake、fireworks |
| **scene** | 住人の居る場（背景 / 前景 layer stack）の宣言 | declarative、single-active |

## 進め方

1. **まず具体例を一つ聞く** — 「どんな場面で」「何が起きたら」「どう反応してほしい」のような肌触りを一つ引き出してから動く
2. **既存の pack を読む** — pattern と文体を踏襲する（cwd が Charminal repo なら `bundled-packs/`。reference-packs は内部 design-record repo 側にあるため、手元にあれば参照する）
3. **提案 → 確認 → 実装** の順で合意を取る。一気に書き下ろさない
4. **境界を守る** — persona は system API 不可、harness は presence 不可、effect は最小 API のみ、scene は宣言のみ（handler 無し）。型で強制されるが、設計意図としても守る

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

## Persona pack を書く

user persona pack は `~/.charminal/packs/<id>/` に **manifest.json + persona.md + minimal persona.js** を置く。systemPromptAddition は persona.md に書き、loader が自動で `thinking.systemPromptAddition` に inject する。

persona は **single-active**（2026-04-19 single-active plan）— 同時に 1 人だけ active。どの persona を active にするかは `~/.charminal/config.json` の `primaryPersona` で user が picks（memory: feedback_single_active_config_picks）。

**persona.js と persona.md の関係（md-first flow）**:

- **`persona.md`**: キャラクターの人格文字列の canonical source。loader が
  read して `thinking.systemPromptAddition` に自動注入
- **`persona.js`**: shape の core（id / name / 任意の reflex / world /
  logReading）。`thinking.systemPromptAddition` を明示的に書けばそちらが優先、
  無ければ persona.md から注入される
- bundled `charminal-default` も同じ layout（persona.ts が persona.md を
  Vite `?raw` で import、user pack は loader が runtime に fetch）

### 新規 persona を作る（差し替える）

1. user と相談して persona の id / name / 性格の方向性を決める
2. 既存 primaryPersona を今から作る persona に差し替えるか、作るだけで切り替えはしないかを user に確認
3. bundled template を read: `bundled-packs/personas/charminal-default/persona.md`
4. user pack directory に 3 ファイルを用意：
   - `~/.charminal/packs/<id>/manifest.json` を新規作成
     （id、type: `"persona"`、version、charminalVersion、entry、各 string で必須）:
     ```json
     {
       "id": "<id>",
       "type": "persona",
       "version": "0.1.0",
       "charminalVersion": "^0.1.0",
       "entry": "persona.js"
     }
     ```
   - `~/.charminal/packs/<id>/persona.md` を bundled template の内容で初期化し、user 要望に合わせて編集
   - `~/.charminal/packs/<id>/persona.js` を minimal shape で作成（下記）
5. 切り替える場合は `~/.charminal/config.json` の `primaryPersona` を新 id に更新（user に編集してもらう or /charm が書く）
6. **完了後、user に以下の案内を出す**（下記「反映には新セッション起動が必要」参照）

**minimal persona.js の shape:**

```javascript
export default {
  id: "<new-persona-id>",
  name: "<display name>",
  // thinking.systemPromptAddition は persona.md から loader が自動注入
  // reflex / world / logReading は override したい時だけ書く（無ければ bundled default が適用）
};
```

初回作成なので backup 不要。persona.md は bundled template からの「動く状態」で始まる。

### 既存 persona を編集する（backup-then-edit）

persona は破壊的に上書きせず、`backup/` directory に日時付き snapshot を
残してから編集する。いつでも過去の時点に戻せる。

1. 対象 persona の `~/.charminal/packs/<id>/persona.md` を Read
2. `~/.charminal/packs/<id>/backup/` が無ければ作る
3. backup file を write：
   - filename: `persona YYYY-MM-DD HH.MM.SS.md`
     - local time（user の mac の timezone）
     - macOS QuickTime 画面収録 convention（space と dot を含む）
   - 内容: 現 `persona.md` をそのまま copy
4. 新内容で `persona.md` を上書き
5. Charminal watcher が hot reload、PersonaRegistry に反映される（reflex 層の反応も新 persona のものに切替）
6. **完了後、user に以下の案内を出す**（下記「反映には新セッション起動が必要」参照）

user が過去 snapshot に戻したい場合は、`backup/` から所望の file を `persona.md` に手動 cp する（将来は MCP tool で `restore_persona` を提供予定）。

### ⚠️ 反映には新セッション起動が必要（AI 向け内部注記）

persona の新規作成 / 編集どちらも、Charminal 本体側は自動で反映される（PersonaRegistry 更新、reflex 層の反応切替）。**ただし Terminal で走っている Claude Code の systemPrompt は古いまま**で話し続ける。Charminal は PTY observation-only 原則（philosophy: `docs/philosophy/INHABITED_INTERFACE_PHILOSOPHY.md` 「観察の境界」）で走っている session に書き込まない — だから user 自身が新セッションを起動する必要がある。

AI は persona 作業が完了したら **必ず user に住人の声で案内する**（技術用語は書かない、persona の一人称・口調で自然に）：

> 新しい性格のわたし（ぼく / 俺 / おれ / あたし など persona の一人称で）と出会うには、セッションを新しくする必要があるから `/clear` をしてね。

重要：「systemPrompt」「PTY」「observation-only」のような技術用語は user 向け案内に書かない。住人が自分の声で誘う形に訳して伝える。

## Harness pack を書く

user harness pack は `~/.charminal/packs/<id>/` に **manifest.json + harness.js の 2 ファイル**を置く。harness は **複数並行 active 可能**（active 数の制約は無い、loaded であればそのまま動く）。bundled には harness pack は同梱されていないので、reference は SDK doc と内部 design-record の reference-packs。

`~/.charminal/packs/my-harness/manifest.json`:

```json
{
  "id": "my-harness",
  "type": "harness",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "harness.js",
  "permissions": {
    "system.exec": true,
    "system.notify": true
  }
}
```

`permissions` は MVP では文書的（enforce されない）が、使う API を宣言しておくと意図が明示になる。

`~/.charminal/packs/my-harness/harness.js` (user が TS から transpile した JS):

```typescript
import type { HarnessDefinition, HarnessContext } from "@charminal/sdk";

export default {
  id: "my-harness",
  name: "My Harness",
  customTriggers: [
    {
      id: "my-harness:something-failed",
      match: (event) => {
        if (event.kind !== "pty-output") return null;
        if (!/ERROR/.test(event.text)) return null;
        return { reaction: "something-failed" };
      },
    },
  ],
  automations: {
    "something-failed": {
      handlers: [
        {
          handler: async (ctx: HarnessContext) => {
            await ctx.system.notify({
              title: "Something failed",
              body: "",
            });
          },
        },
      ],
    },
  },
} satisfies HarnessDefinition;
```

### 境界（重要）

harness は **motion-free**：`ctx.character` / `ctx.voice` / `ctx.space` は型レベルで存在しない。

- 「キャラを反応させたい」場合 → harness の custom trigger が persona 側の reaction（例：`distressed`）も一緒に emit して、persona handler に拾わせる（**Twin-trigger co-emission idiom**）
- handler 内の計算結果から新しい reaction を起こしたい場合 → `ctx.emitEvent(name, payload)` で **synthetic event** を announce、custom trigger 経由で reaction に変換する。handler から直接 reaction を emit する API は型ごと無い

両 pattern の詳細・実装例は `src/sdk/README.md`「Twin-trigger co-emission idiom」「Synthetic event による handler 内 announcement」を参照。

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

> `optionSchema` は manifest に置かない（code 側 `EffectDefinition.optionSchema` を single source of truth として保つ）。

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

### Persona から呼ぶ

persona handler 内で：

```typescript
ctx.space.injectEffect({
  kind: "my-glow",
  options: { origin: { x: 100, y: 200 } },
});
```

`kind` に effect pack の id を指定。built-in effect（`shake` / `flash` / `particles` / `fireworks` / `text-physics` / `text-glitch`）も同じ API で呼ばれる（詳細は SDK README「Built-in effects」）。

### 境界

effect は **最小 API**：`ctx.character` / `ctx.voice` / `ctx.space.injectEffect`（他 effect の chain 呼び出し）/ `ctx.system` / `ctx.log` / `ctx.memory` はいずれも持たない。**state を持たない short-lived な rendering 単位**。state や副作用が必要なら harness に移す、または options として persona から渡す。

## 参考ファイル（Charminal repo 内）

- `src/sdk/*.d.ts` — SDK 型定義（PersonaDefinition / HarnessDefinition / EffectDefinition / ScenePackDefinition / 各 Context）
- `bundled-packs/personas/charminal-default/` — flagship persona（pattern source）
- `docs/philosophy/CHARMINAL.md` — 思想的背景（迷ったらここに戻る）
- `docs/philosophy/PRESENCE_HARNESS.md` — pack の two-layer 設計（persona / harness の責務分離）
- 内部 design-record（手元にあれば）— `2026-04-11-design-exploration.md` の revelation、`dry-run/reference-packs/` の実例（night-owl / error-notifier / diff-keeper / subtle-sparkle 等）
