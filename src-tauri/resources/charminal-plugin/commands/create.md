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
| **persona** | キャラクターの性格・反応・身体・声・空間を定義（md-first、manifest.json + persona.md + minimal persona.js） | clai |
| **effect** | 画面上の視覚演出 | subtle-sparkle、shake、fireworks |
| **scene** | 住人の居る場（背景 / 前景 layer stack）の宣言 | simple-room、radiant-meadow |
| **ui** | サイドバーの主要 UI パネル（設定画面等）。single-active | charminal-settings |
| **ambient-ui** | 常時表示のオーバーレイ UI。multi-active | attention-aura |

## セキュリティ境界

- `/charm:create` が作る `.js` / `.tsx` pack は **local trusted の `trusted-main-thread-js`**。Charminal public registry 用 artifact ではなく、sandbox 済み・review 済み・公開配布用 pack として扱わない
- GitHub 等で source code として共有することは妨げない。ただし手動導入する利用者は local trusted code として自己責任で実行する扱いだと明記する
- manifest には必ず `"executionClass": "trusted-main-thread-js"` を書く。`.js` / `.tsx` entry に `"declarative"` を付けない
- `utility` pack は作らない。`isolated-js` runtime と permission UX が未実装なので、公開配布対象外
- pack 内で `fetch` / `fs` / `system.exec` / Tauri API / Node builtin / PTY write を使わない。必要になったら本体側 capability として設計する
- scene asset は pack 内の相対 path（例: `./assets/bg.png`）だけを使う。`https:`, `data:`, `file:`, absolute path, `../`, CSS `url(...)` は使わない
- UI / ambient-ui から terminal へ直接書き込まない。prompt を提示する場合も既存の安全な UI 経路に限定する

## 進め方

1. **まず具体例を一つ聞く** — 「どんな場面で」「何が起きたら」「どう反応してほしい」のような肌触りを一つ引き出してから動く
2. **既存の pack を読む** — pattern と文体を踏襲する（cwd が Charminal repo なら `bundled-packs/` を参照）
3. **提案 → 確認 → 実装** の順で合意を取る。一気に書き下ろさない
4. **境界を守る** — persona は system API 不可、effect は最小 API のみ、scene は宣言のみ、ui / ambient-ui は描画と state のみ。型で強制されるが、設計意図としても守る
5. **色は CSS 変数を使う** — UI / ambient-ui pack でハードコード色（`#eceff4`, `rgba(77, 217, 207, ...)` 等）を直書きしない。`var(--charminal-fg)`, `var(--charminal-accent)` 等の CSS 変数を使う。scene テーマが変わったときに全 UI が追従するため

## Hot reload と自己検証

`~/.charminal/packs/<id>/<kind>.js` に Write した瞬間、Charminal の file watcher が pickup して自動で再 register する（人間の reload 操作は不要）。例：`~/.charminal/packs/my-effect/effect.js`

shape validation に失敗した pack も runtime 全体は落ちず、dev-log に記録される。

Charminal 内で作業中は以下の MCP tool が使える（runtime が live な限り）：

- `list_packs()` — 現在 loaded / disabled / failed な pack を列挙
- `pack_diagnose({id})` — 1 つの pack について status / manifest / load error / 修復ヒントをまとめて確認
- `list_load_errors()` — 直近 load で失敗した pack の error 詳細
- `disable_pack({id})` — 壊れた pack を即時切り離し（config に記録 + runtime dispose）
- `enable_pack({id})` — 切り離した pack を復帰

pack を書いたあと `pack_diagnose({id: "<id>"})` で status を確認すると、「ちゃんと register された」「validation で落ちた」「manifest がずれている」が分かる。自己修正の speed が上がる。

現在の workspace が Charminal source checkout なら、あわせて実行する：

```bash
npm run check:pack -- ~/.charminal/packs/<id>
```

checker error は完了報告前に修正する。warning は user に説明する。

最後に、作成した pack は local trusted code であることを user に伝える。共有したい場合は source code として公開できるが、Charminal の public registry や `/charm:prepare-publish` はまだ未提供である。

## Rescue 経路

Charminal 本体が壊れて起動しないとき、user は safe mode で起動できる：

```
CHARMINAL_SAFE_MODE=1 open /Applications/Charminal.app
```

Safe mode では user pack が一切 load されず、window title に ` (Safe Mode)` が付く。この状態で MCP tool は使える（`list_load_errors()` で原因特定、`disable_pack` で切り離し）。env var を外して再起動すれば disabledPacks にある pack だけ skip され、他は復帰する。

## Scene pack を書く

user scene pack は `~/.charminal/packs/<id>/` に **manifest.json + scene.js の 2 ファイル**を置く。**manifest.json は必須**（Agentic UGC 前提なので explicit な宣言を優先）。bundled の `bundled-packs/scenes/<id>/` とは layout が違う（user 側は flat + .js）。

### パラメータの公開（SDK controls）

scene pack の作者は、どのパラメータを外からリアルタイム調整可能にするかを自分で選べる。`@charminal/sdk/controls` の `useCharminalControls` と `useControlsBridge` で登録した値だけが F2 の **Scene panel**（active scene pack 固有の panel）に現れ、MCP（`controls_get` / `controls_set` の `scope: "scene"`）経由でも読み書きできるようになる。裏側の renderer は現在 leva adapter だが、pack 作者は leva を直接 import しない。

F2 で開く panel は **Common と Scene の 2 枚**：

- **Common**: runtime-wide な controls（base camera position / FOV / target / tracking など）。**scene 切替を跨いで保持される**。所有は ThreeRuntime singleton
- **Scene**: active scene pack 固有の controls（lighting、post effect、layer blur / opacity、camera modulation など）。scene 切替で reset される

scene pack 作者は **Scene 側にだけ register する**（base camera は Common 所有なので scene pack から触らない）。camera を揺らす / breath で動かすような **modulation は Scene 側に register** すれば、base camera に additive に合成される（CameraModulationRegistry）。

- 公開したいパラメータ → `useCharminalControls` に書く → Scene panel に出る → `/charm` で一緒にリアルタイム調整できる
- 公開しないパラメータ → コード内のローカル変数 → 固定値として動く

user に「どのパラメータを外から触れるようにする？」と聞いて一緒に設計する。後から公開パラメータを増やすこともできる。

bundled の `abandoned-factory` が参考実装（`bundled-packs/scenes/abandoned-factory/lib/` の各コンポーネントで `useCharminalControls` + `useControlsBridge` を使っている）。

`~/.charminal/packs/my-scene/manifest.json`:

```json
{
  "id": "my-scene",
  "type": "scene",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
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
    terminal: {
      background: "#1a1e28",
      foreground: "#c0c4cc",
      cursor: "#8abeb7",
      // ANSI 16 色は省略可（default にフォールバック）
    },
    ui: {
      background: "#1a1e28",
      foreground: "#c0c4cc",
      // 全 14 field は省略可（default にフォールバック）
    },
  },
} satisfies ScenePackDefinition;
```

### カラーテーマの設計

scene pack は **ターミナルの色と UI の色を一括で宣言** できる。scene 切替時に自動適用されるので、世界観に合った色を一箇所で定義すれば全体が統一される。

**terminal**: xterm.js の ANSI 16 色 + background / foreground / cursor / selection。省略した field は Charminal default にフォールバック。全 field を埋めると scene 固有の完全なカラースキームになる。既存のカラースキーム（Nord, Gruvbox, Catppuccin, Everforest 等）をベースにして scene の世界観に合わせて調整するのが近道。

**ui**: サイドバー・パネル・ボタン等の UI 全体の色。全 14 field（background, foreground, foregroundDim, sidebarBackground, panelBackground, border, buttonBackground, buttonForeground, inputBackground, accent, accentSoft, accentBorder, muted, glow）を定義できる。省略可。

user にテーマ設計を提案するときは：
1. **scene の世界観から背景色を決める**（暗い場所なら暗色、明るい場所なら明色）
2. **terminal の ANSI 16 色を scene に合わせて調整**（彩度・色温度を揃える）
3. **ui は terminal と同じトーンで統一**（accent は cursor 色に揃えると自然）

bundled の参考実装：
- `bundled-packs/scenes/abandoned-factory/scene.tsx` — コンクリート灰の neutral dark テーマ（ANSI 全色 + ui 全 field）
- `bundled-packs/scenes/misty-grasslands/scene.ts` — Everforest ベースの light テーマ
- `bundled-packs/scenes/simple-room/scene.ts` — Nord 系の blue-dark テーマ

どの scene pack を active にするかは `~/.charminal/config.json` の `activeScene` field で user が明示的に picks する（pack 側の自己申告はしない、Design B — config picks）。例：

```json
{
  "activeScene": "my-scene"
}
```

field を書かない / null にすると bundled の `simple-room` にフォールバックする。

詳細: `src/core/scene/README.md`

## Persona pack を書く

user persona pack は `~/.charminal/packs/<id>/` に **manifest.json + persona.md + minimal persona.js** の 3 ファイルを置く。systemPromptAddition は persona.md に書き、loader が自動で `thinking.systemPromptAddition` に inject する。

persona は **single-active** — 同時に 1 人だけ active。どの persona を active にするかは `~/.charminal/config.json` の `primaryPersona` で user が picks する。

### persona.js と persona.md の関係（md-first flow）

- **`persona.md`**: キャラクターの人格文字列の canonical source。loader が read して `thinking.systemPromptAddition` に自動注入
- **`persona.js`**: shape の core（id / name / 任意の reflex / world / logReading）。`thinking.systemPromptAddition` を明示的に書けばそちらが優先、無ければ persona.md から注入される
- bundled `clai` も同じ layout（persona.ts が persona.md を Vite `?raw` で import、user pack は loader が runtime に fetch）

### 新規 persona の作り方

1. user と相談して persona の id / name / 性格の方向性を決める
2. 既存 primaryPersona を今から作る persona に差し替えるか、作るだけで切り替えはしないかを user に確認
3. bundled template を read: `bundled-packs/personas/clai/persona.md`
4. user pack directory に 3 ファイルを用意：

`~/.charminal/packs/<id>/manifest.json`:

```json
{
  "id": "<id>",
  "type": "persona",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
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

persona の新規作成後、Charminal 本体側は自動で反映される（PersonaRegistry 更新、reflex 層の反応切替）。**ただし Terminal で走っている Claude Code / Codex の prompt overlay は古いまま**で話し続ける。Charminal は PTY observation-only 原則で走っている session に書き込まないため、user 自身が新セッションを起動する必要がある。

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
  "executionClass": "trusted-main-thread-js",
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
  "executionClass": "trusted-main-thread-js",
  "entry": "ui.js"
}
```

ui pack は React コンポーネントを export する。`UiContext` を受け取り、`ctx.state` で永続化可能な key-value store を使える。`ctx.emitEvent()` で trigger loop に synthetic event を流すことも可能。

bundled の参考実装: `bundled-packs/ui/charminal-settings/`

### 境界

ui pack は **描画と state 管理のみ**。`ctx.system` / `ctx.character` / `ctx.voice` は持たない。terminal へ何か入力させたい場合は、PTY write を直接呼ばず、既存の安全な prompt UI 経路だけを使う。

**色は CSS 変数を使う**: `#eceff4` や `rgba(77, 217, 207, ...)` のようなハードコード色を直書きしない。scene テーマが変わったときに追従するため、以下の CSS 変数を使う:

| 変数 | 用途 |
|---|---|
| `var(--charminal-bg)` | 背景色 |
| `var(--charminal-fg)` | テキスト色 |
| `var(--charminal-fg-dim)` | 薄いテキスト色 |
| `var(--charminal-panel-bg)` | パネル背景 |
| `var(--charminal-sidebar-bg)` | サイドバー背景 |
| `var(--charminal-border)` | ボーダー |
| `var(--charminal-button-bg)` | ボタン背景 |
| `var(--charminal-button-fg)` | ボタンテキスト |
| `var(--charminal-input-bg)` | input / toggle 背景 |
| `var(--charminal-accent)` | アクセント色 |
| `var(--charminal-accent-soft)` | アクセント薄め |
| `var(--charminal-accent-border)` | アクセントボーダー |
| `var(--charminal-muted)` | muted テキスト |
| `var(--charminal-glow)` | グロー |

## Ambient-UI pack を書く

ambient-ui pack は常時表示のオーバーレイ UI。**multi-active**（複数を同時に active にできる）。Three.js の scene 上に直接描画するか、HTML overlay として配置する。

`~/.charminal/packs/my-overlay/manifest.json`:

```json
{
  "id": "my-overlay",
  "type": "ambient-ui",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "entry": "ambient-ui.js"
}
```

bundled の参考実装: `bundled-packs/ambient-ui/attention-aura/`

### 境界

ambient-ui は **renderer と attention 情報のみ**。persona / system API は持たない。常時表示される性質上、パフォーマンスに注意すること。

**色は CSS 変数を使う**: UI pack と同じルール。ハードコード色を直書きせず `var(--charminal-*)` を使う。ただしエフェクト固有の色（パーティクル色等、scene テーマに依存しないもの）はハードコードで OK。

## 参考ファイル（Charminal repo 内）

- `src/sdk/*.d.ts` — SDK 型定義（PersonaDefinition / EffectDefinition / ScenePackDefinition / UiPackDefinition / AmbientUiPackDefinition / 各 Context）
- `bundled-packs/personas/clai/` — flagship persona（pattern source）
- `bundled-packs/ui/` — UI pack の参考実装
- `bundled-packs/ambient-ui/` — ambient-ui pack の参考実装
- `docs/philosophy/CHARMINAL.md` — 思想的背景（迷ったらここに戻る）
- `docs/philosophy/PRESENCE_HARNESS.md` — pack の two-layer 設計
