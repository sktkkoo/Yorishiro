---
description: 新しい pack（persona / scene / effect / amenity / ui / ambient-ui）を対話で作る
argument-hint: "[作りたいもの]"
---

$ARGUMENTS

---

あなたはこれから Yorishiro の **新しい pack** を対話しながら作る。

## Yorishiro とは

AI がターミナルに「住む」ためのアプリ。サイドバーのキャラクターがユーザーの作業（PTY 出力、hook イベント、idle 時間）を観察して反応する。機能的なターミナル動作には一切介入せず、状態を読んで表現するだけ。

## Pack の種類

| 種類 | 何をする | 例 |
|---|---|---|
| **persona** | キャラクターの性格（口調）と反射（体の癖）を定義（md-first、manifest.json + persona.md + minimal persona.js） | yori |
| **effect** | 画面上の視覚演出 | subtle-sparkle、shake、fireworks |
| **amenity** | 機能設備（タイマー・音楽再生等）+ MCP tool。local-trusted（system.exec 持つ） | pomodoro、music-shelf |
| **scene** | 住人の居る場（背景 / 前景 layer stack、または R3F component による lighting / 3D） | simple-room、radiant-meadow |
| **ui** | サイドバーの主要 UI パネル（設定画面等）。single-active | yorishiro-settings |
| **ambient-ui** | 常時表示のオーバーレイ UI。multi-active | attention-aura |

## セキュリティ境界

- `/yori:create` が作る `.js` / `.tsx` pack は **local trusted の `trusted-main-thread-js`**。Yorishiro public registry 用 artifact ではなく、sandbox 済み・review 済み・公開配布用 pack として扱わない
- GitHub 等で source code として共有することは妨げない。ただし手動導入する利用者は local trusted code として自己責任で実行する扱いだと明記する
- manifest には必ず `"executionClass": "trusted-main-thread-js"` を書く。`.js` / `.tsx` entry に `"declarative"` を付けない
- `utility` pack は作らない。`isolated-js` runtime と permission UX が未実装なので、公開配布対象外
- pack 内で `fetch` / `fs` / `system.exec` / Tauri API / Node builtin / PTY write を使わない。必要になったら本体側 capability として設計する
- 例外: amenity は `system.exec` を持つ機能設備 pack。local 自己利用に限って作ってよい（住人 AI が既に terminal で持つ shell 権限と同等）。公開配布は `isolated-js` runtime / permission UX まで保留（Amenity 節参照）
- scene asset は pack 内の相対 path（例: `./assets/bg.png`）だけを使う。`https:`, `data:`, `file:`, absolute path, `../`, CSS `url(...)` は使わない
- UI / ambient-ui から terminal へ直接書き込まない。prompt を提示する場合も既存の安全な UI 経路に限定する

## 進め方

1. **まず具体例を一つ聞く** — 「どんな場面で」「何が起きたら」「どう反応してほしい」のような肌触りを一つ引き出してから動く
2. **既存の pack を読む** — `bundled_example_read({id})` で bundled pack のソースを取得し、pattern と文体を踏襲する（`list_packs()` で利用可能な id を確認できる）
3. **提案 → 確認 → 実装** の順で合意を取る。一気に書き下ろさない
4. **境界を守る** — persona は system API 不可、amenity は local-trusted の system.exec ありだが motion-free、effect は最小 API のみ、scene は宣言または React+three.js の描画のみ、ui / ambient-ui は描画と state のみ。型で強制されるが、設計意図としても守る
5. **色は CSS 変数を使う** — UI / ambient-ui pack でハードコード色（`#eceff4`, `rgba(77, 217, 207, ...)` 等）を直書きしない。`var(--yorishiro-fg)`, `var(--yorishiro-accent)` 等の CSS 変数を使う。scene テーマが変わったときに全 UI が追従するため

## Hot reload と自己検証

`~/.yorishiro/packs/<id>/<kind>.js` に Write した瞬間、Yorishiro の file watcher が pickup して自動で再 register する（人間の reload 操作は不要）。例：`~/.yorishiro/packs/my-effect/effect.js`

shape validation に失敗した pack も runtime 全体は落ちず、dev-log に記録される。

Yorishiro 内で作業中は以下の MCP tool が使える（runtime が live な限り）：

- `list_packs()` — 現在 loaded / disabled / failed な pack を列挙
- `bundled_example_read({id})` — bundled pack のソースコード一式を取得（pack 作成時の参考に。id は `list_packs` で確認）
- `pack_diagnose({id})` — 1 つの pack について status / manifest / load error / 修復ヒントをまとめて確認
- `list_load_errors()` — 直近 load で失敗した pack の error 詳細
- `disable_pack({id})` — 壊れた pack を即時切り離し（config に記録 + runtime dispose）
- `enable_pack({id})` — 切り離した pack を復帰

pack を書いたあと `pack_diagnose({id: "<id>"})` で status を確認すると、「ちゃんと register された」「validation で落ちた」「manifest がずれている」が分かる。自己修正の speed が上がる。

現在の workspace が Yorishiro source checkout なら、あわせて実行する：

```bash
npm run check:pack -- ~/.yorishiro/packs/<id>
```

checker error は完了報告前に修正する。warning は user に説明する。

最後に、作成した pack は local trusted code であることを user に伝える。共有したい場合は source code として公開できるが、Yorishiro の public registry や `/yori:prepare-publish` はまだ未提供である。

## Rescue 経路

Yorishiro 本体が壊れて起動しないとき、user は safe mode で起動できる：

```
YORISHIRO_SAFE_MODE=1 open /Applications/Yorishiro.app
```

Safe mode では user pack が一切 load されず、window title に ` (Safe Mode)` が付く。この状態で MCP tool は使える（`list_load_errors()` で原因特定、`disable_pack` で切り離し）。env var を外して再起動すれば disabledPacks にある pack だけ skip され、他は復帰する。

## Scene pack を書く

user scene pack は `~/.yorishiro/packs/<id>/` に **manifest.json + scene.js または scene.tsx** を置く。**manifest.json は必須**（Agentic UGC 前提なので explicit な宣言を優先）。bundled の `bundled-packs/scenes/<id>/` とは layout が違う（user 側は flat）。

scene pack には 2 つの形式がある：

- **declarative（`scene.js`）**: layers + terminal + ui の宣言だけを書く。controls 公開はしない。手軽で、背景色・画像・terminal / UI theme を作るだけならこちらを選ぶ。
- **R3F component（`scene.tsx`）**: lighting / 3D object を React component で描く。`useYorishiroControls` / `useControlsBridge` による controls 公開はこの形式でだけ使う。

`scene.tsx` から pack 内の `./lib/*.tsx` 等へ相対 import して分割してよい。pack 内 source file の編集は owning `scene.tsx` の reload として扱われる。

component 内では React + three.js の描画に留め、`fetch` / `fs` / `system.exec` / Tauri API / Node builtin / PTY write は使わない。base camera は Common controls の所有なので scene から直接触らない。camera breath / shake / sway のような微小変調だけを Scene 側 controls として設計する。

### R3F scene の controls 結線

R3F component 形式を選んだら、実装前に user と **どのパラメータを外から触れるようにするか** を決める。lighting intensity / color / fog / post effect / camera modulation など、調整しながら肌触りを決めたい値だけを公開する。

裏側の panel renderer は現在 leva adapter だが、pack 作者は leva を直接 import しない。公開 API は `@yorishiro/sdk/controls` だけを使う。

作業ステップ：

1. user に「F2 Scene panel や `/yori:update` から調整したい値はどれ？」と聞く
2. `scene.tsx` の component 内で `@yorishiro/sdk/controls` の `useYorishiroControls` と `useControlsBridge` を使って登録する
3. 登録した値が F2 **Scene panel** に出ることを確認する
4. `/yori:update` または MCP `controls_get` / `controls_set` の `scope: "scene"` で読み書きできることを確認する

F2 で開く panel は **Common（runtime-wide な base camera など）と Scene（active scene pack の controls）** の 2 枚。scene pack の lighting / post effect / camera modulation はすべて Scene 側に登録される。

scene pack 作者は **Scene 側にだけ register する**。base camera は Common 所有なので scene pack から触らない。公開しないパラメータはコード内のローカル値として固定する。

bundled の `abandoned-factory` が参考実装（`bundled-packs/scenes/abandoned-factory/lib/` の各コンポーネントで `useYorishiroControls` + `useControlsBridge` を使っている）。

`~/.yorishiro/packs/my-scene/manifest.json`:

```json
{
  "id": "my-scene",
  "type": "scene",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "entry": "scene.js"
}
```

`~/.yorishiro/packs/my-scene/scene.js`:

```typescript
import type { ScenePackDefinition } from "@yorishiro/sdk";

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

`~/.yorishiro/packs/my-scene/scene.tsx`（R3F component + controls 公開）:

```typescript
import type { ScenePackDefinition } from "@yorishiro/sdk";
import { useYorishiroControls, useControlsBridge } from "@yorishiro/sdk/controls";

function MySceneComponent() {
  const [controls, setControls] = useYorishiroControls("lights", () => ({
    intensity: { value: 1.2, min: 0, max: 4, step: 0.1 },
  }));
  useControlsBridge("my-scene", controls, setControls);

  const intensity = Number(controls.intensity ?? 1.2);
  return <ambientLight intensity={intensity} color="#ffffff" />;
}

export default {
  id: "my-scene",
  type: "scene",
  scene: {
    id: "my-scene",
    layers: [{ id: "vrm-slot", role: "character", blur: 0 }],
    terminal: {
      background: "#1a1e28",
      foreground: "#c0c4cc",
      cursor: "#8abeb7",
    },
    ui: {
      background: "#1a1e28",
      foreground: "#c0c4cc",
    },
  },
  component: MySceneComponent,
} satisfies ScenePackDefinition;
```

### カラーテーマの設計

scene pack は **ターミナルの色と UI の色を一括で宣言** できる。scene 切替時に自動適用されるので、世界観に合った色を一箇所で定義すれば全体が統一される。

**terminal**: xterm.js の ANSI 16 色 + background / foreground / cursor / selection。省略した field は Yorishiro default にフォールバック。全 field を埋めると scene 固有の完全なカラースキームになる。既存のカラースキーム（Nord, Gruvbox, Catppuccin, Everforest 等）をベースにして scene の世界観に合わせて調整するのが近道。

**ui**: サイドバー・パネル・ボタン等の UI 全体の色。全 14 field（background, foreground, foregroundDim, sidebarBackground, panelBackground, border, buttonBackground, buttonForeground, inputBackground, accent, accentSoft, accentBorder, muted, glow）を定義できる。省略可。

**カラーテーマは user と一緒に決める。** scene を作るときに必ず通すステップ — ターミナルの色が世界観と合っていないと scene の意味が半減する。勝手に確定せず、次の順で相談する：
1. **scene の世界観から背景色を決める**（暗い場所なら暗色、明るい場所なら明色）。候補をいくつか出して user に選んでもらう
2. **terminal の ANSI 16 色を scene に合わせて調整**（彩度・色温度を揃える）。ベースにするカラースキーム（Nord, Gruvbox, Catppuccin, Everforest 等）を user に確認する
3. **ui は terminal と同じトーンで統一**（accent は cursor 色に揃えると自然）
4. 決まったら scene.js の `terminal` / `ui` に書き、`scene_activate` で current project の active scene にして、見た目を見ながら user と一緒に微調整する

bundled の参考実装：
- `bundled-packs/scenes/abandoned-factory/scene.tsx` — コンクリート灰の neutral dark テーマ（ANSI 全色 + ui 全 field）
- `bundled-packs/scenes/misty-grasslands/scene.ts` — Everforest ベースの light テーマ
- `bundled-packs/scenes/simple-room/scene.ts` — Nord 系の blue-dark テーマ

どの scene pack を active にするかは `scene_activate` で user が明示的に picks する（pack 側の自己申告はしない、Design B — config picks）。`scene_activate` は current project root が解決できる場合は `~/.yorishiro/config.json` の `sceneByProject` に、解決できない場合は global fallback の `activeScene` に永続化する。例：

```json
{
  "sceneByProject": {
    "/path/to/project": "my-scene"
  },
  "activeScene": "my-scene"
}
```

current project に `sceneByProject` entry がなければ `activeScene` に fallback する。どちらも無い / null なら bundled の `simple-room` にフォールバックする。

詳細: `src/core/scene/README.md`

## Persona pack を書く

user persona pack は `~/.yorishiro/packs/<id>/` に **manifest.json + persona.md + minimal persona.js** の 3 ファイルを置く。systemPromptAddition は persona.md に書き、loader が自動で `thinking.systemPromptAddition` に inject する。

persona は **single-active** — 同時に 1 人だけ active。どの persona を active にするかは `~/.yorishiro/config.json` の `primaryPersona` で user が picks する。

### persona.js と persona.md の関係（md-first flow）

- **`persona.md`**: キャラクターの人格文字列の canonical source。loader が read して `thinking.systemPromptAddition` に自動注入
- **`persona.js`**: shape の core（id / name / 任意の reflex）。`thinking.systemPromptAddition` を明示的に書けばそちらが優先、無ければ persona.md から注入される
- bundled `yori` も同じ layout（persona.ts が persona.md を Vite `?raw` で import、user pack は loader が runtime に fetch）

### 新規 persona の作り方

1. user と相談して persona の id / name / 性格の方向性を決める
2. 既存 primaryPersona を今から作る persona に差し替えるか、作るだけで切り替えはしないかを user に確認
3. bundled template を read: `bundled-packs/personas/yori-en/persona.md`（日本語 default なら `yori-ja`）
4. user pack directory に 3 ファイルを用意：

`~/.yorishiro/packs/<id>/manifest.json`:

```json
{
  "id": "<id>",
  "type": "persona",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "entry": "persona.js"
}
```

`~/.yorishiro/packs/<id>/persona.md` — bundled template の内容で初期化し、user 要望に合わせて編集

`~/.yorishiro/packs/<id>/persona.js` — minimal shape:

```javascript
export default {
  id: "<new-persona-id>",
  name: "<display name>",
  // thinking.systemPromptAddition は persona.md から loader が自動注入
  // reflex は override したい時だけ書く（無ければ bundled default の反射を丸ごと継承する）
};
```

5. VRM（姿）も用意するか user に確認する。用意する場合はパスを貼ってもらい、`vrm_validate({ "path": "<パス>" })` で検証してから `~/.yorishiro/packs/<id>/avatar.vrm` にコピーする。ここがこの persona の姿の置き場所——「お別れして切り替える」がここから拾う。用意しない場合は今の姿を引き継ぐ
6. 切り替える場合は `~/.yorishiro/config.json` を直接編集しない。下記「お別れして切り替える」を行う
7. 作るだけで切り替えない場合は、作成完了を短く伝える

### 反射（reflex）を設計する

反射は「どの出来事に体がどう動くか」——口調と同格の、人格のもう半分。省略もできるが、挙動を知った上で選ぶ：

- **reflex を書かない場合、bundled default（Yori）の反射を丸ごと継承する**。エラーで顔をしかめ、push 成功で花火を上げ、長い離席でいたずらの銃を撃つ——真面目な persona には合わないことがある。合わなければ reflex を明示する（1 つでも書けば継承は切れて、全て自前になる）
- 反応の語彙は standard vocabulary（`startled` / `contemplative` / `pleased` / `distressed` / `curious` / `focused` / `acknowledging` / `idle-fidget` / `confused` / `bored`）+ 任意の custom 文字列。まず 2〜3 反応から始めて、実機で観察してから足す
- custom trigger には `description`（人間可読の発火条件の一文）を書く。match 関数のコードは外から読めないため、これが一覧表示に載る唯一の説明になる
- 既存 persona が何に反応するかは `persona_reflex_list({ "personaId": "<id>" })` で確認できる（personaId 省略で active persona）。`reflexSource: "inherited-default"` なら bundled default の丸ごと継承
- 参考実装: `bundled-packs/personas/yori-shared/persona-factory.ts`

### お別れして切り替える

新規 persona 作成後にそのまま切り替える場合は、今の住人としてお別れを言ってから `persona_goodbye_switch` を呼ぶ。`primaryPersona` を直接書き換えない。

このお別れは user の記憶に残る一度きりの場面。事務的な挨拶にしない。

1. 切替先の姿を決める。まず切替先 pack の `~/.yorishiro/packs/<id>/avatar.vrm` を確認し、あれば `vrm_validate({ "path": "<パス>" })` で**この時点で**検証して使う（user には「〈name〉の姿に切り替える」と一言添えれば足りる）。無ければ VRM も切り替えるか user に確認し、切り替える場合は `.vrm` ファイルのパスを貼ってもらい検証する（無効なら理由を伝えて、再入力か「姿はそのまま」を選んでもらう）。モデルの切替はここでは行わない——検証で返ったパスを手順 5 で渡すと暗転中に切り替わり、カーテンが明けたときには新しい姿になっている
2. `journal_read` で自分の journal を読む（必要なら `days` を広めに取る）
3. 具体的な思い出がある場合は `ui_activate({ "id": "theater" })` で theater に入る
4. journal のいくつかの具体的な思い出に触れながら、今の住人の声でお別れを言う。長さは 200〜400 字ほど——読み上げるとおよそ 30〜60 秒になる。時間はあくまで目安
   - 構成・トーン・間の取り方は、自分の persona（口調・内面・振る舞いの原則）から導く。決まった型をなぞらない——淡白な persona なら最後に一度だけ何かが滲む、饒舌な persona なら急に言葉が減る、静かな persona なら言葉より沈黙が多い、というように、その persona らしい崩れ方・締め方を自分で選ぶ
   - 古い思い出と最近の思い出を混ぜると、過ごした時間の長さが伝わる
   - 汎用の「楽しかった」だけで済ませない。思い出の列挙だけでも終わらせない
   - 声は一回の voice_say にまとめる——複数回に分けると前の発話が途中で切れる
   - `[pause]` と書くと数秒の沈黙が入る。間の置き方にも persona が出る
5. `persona_goodbye_switch({ "id": "<new-persona-id>" })` を呼ぶ。VRM も切り替える場合は検証済みパスを添える: `persona_goodbye_switch({ "id": "<new-persona-id>", "vrmPath": "<検証済みパス>" })`
6. journal に具体的断片が無い場合は、言葉は挟まず `persona_goodbye_switch` を呼ぶ（vrmPath の扱いは同じ）

`persona_goodbye_switch` は暗転後に `primaryPersona` を保存し、裏で reload する。カーテンが明けた後、user が次に話しかけたとき新しい persona として応答できる。user に `/clear` を促す必要はない。お別れの事実（誰に器を譲ったか）は去る側の記憶（memories.md）に自動で一行残る——いつかその persona に戻ったとき、想起が拾う。

## Effect pack を書く

user effect pack は `~/.yorishiro/packs/<id>/` に **manifest.json + effect.js**（必要なら `assets/` も）を置く。effect は **declarative に呼ばれる存在**（persona の handler から `ctx.space.injectEffect({ kind: <pack-id> })` で起動される。effect 自身は trigger を持たない）。

`~/.yorishiro/packs/my-glow/manifest.json`:

```json
{
  "id": "my-glow",
  "type": "effect",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "entry": "effect.js"
}
```

`~/.yorishiro/packs/my-glow/effect.js`:

```typescript
import type { EffectDefinition, EffectContext, Vec2 } from "@yorishiro/sdk";

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

## Amenity pack を書く

amenity pack は住人の空間に備える機能設備（タイマー、音楽再生、外部状態の観察など）。MCP tool を公開し、必要なら `ctx.system.exec` で local command を実行する。**motion-free** なので `ctx.character` / `ctx.voice` / `ctx.space` は持たない。

amenity は **local-trusted 限定**。住人 AI が terminal で既に持つ shell 権限と同等なので local 自己利用では新しい権限境界を増やさないが、他人が install すると exec が走る公開配布 artifact ではない。公開配布は `isolated-js` runtime / permission UX まで保留。

`~/.yorishiro/packs/my-amenity/manifest.json`:

```json
{
  "id": "my-amenity",
  "type": "amenity",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "description": "この pack の短い説明",
  "author": "作成者名",
  "entry": "amenity.js"
}
```

`amenity.js` は `AmenityPackDefinition` を export する。`toolMeta` に MCP tool の名前と説明を書き、`activate(ctx)` で `{ tools, dispose }` を返す。`tools` の key は `toolMeta.name` と一致させる。

### 使える context API

- `ctx.system.exec(command, options?)` — local command を実行する。`system.spawn` / `system.fs` / `system.notify` は型にはあるが現状未実装（throw）なので使わない
- `ctx.time.every(...)` / `ctx.time.schedule(...)` / `ctx.time.after(...)` — polling、timer、遅延処理
- `ctx.emitEvent(name, payload?)` — synthetic event を流す。キャラクター表現が欲しいときは persona reflex がこれを拾う（twin-trigger）
- `ctx.history` — pack/config/init の snapshot / restore UI への入口
- `ctx.tween` — terminal opacity 等、host が渡した値の補間
- `ctx.ambientAudio` — scene ambient sound の一時 mute / volume 制御
- `ctx.loop.announce(phase, detail?)` — 自律 loop の lifecycle を観察 stream に報告する。loop を制御する API ではない
- `ctx.log` / `ctx.memory` — shared utility
- `ctx.terminal` — observation only。PTY write はできない
- `ctx.yori` / `ctx.signal` / `ctx.resolveAsset(path)` — `/yori` bridge、disable 時 abort、pack-local asset 解決

表現したい場合は amenity が直接 motion を出さず、`ctx.emitEvent()` → persona reflex の順に委ねる。参考実装: `bundled-packs/amenities/music-shelf/amenity.ts`、`bundled-packs/amenities/pomodoro/amenity.ts`。

## UI pack を書く

ui pack はサイドバーに表示される主要 UI パネル。**single-active**（同時に 1 つだけ active）。どの ui pack を active にするかは `~/.yorishiro/config.json` の `activeUi` で user が picks する。

`~/.yorishiro/packs/my-panel/manifest.json`:

```json
{
  "id": "my-panel",
  "type": "ui",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "entry": "ui.js"
}
```

ui pack は React コンポーネントを export する。`UiContext` を受け取り、`ctx.state` で永続化可能な key-value store を使える。`ctx.emitEvent()` で trigger loop に synthetic event を流すことも可能。

bundled の参考実装: `bundled-packs/ui/yorishiro-settings/`

### 境界

ui pack は **描画と state 管理のみ**。`ctx.system` / `ctx.character` / `ctx.voice` は持たない。terminal へ prompt を入れる場合は、`ctx.app.insertFixedPrompt(...)` のような host 所有の固定 key verb だけを使う。任意 terminal prefill / PTY write 直叩きは公開しない。

**色は CSS 変数を使う**: `#eceff4` や `rgba(77, 217, 207, ...)` のようなハードコード色を直書きしない。scene テーマが変わったときに追従するため、以下の CSS 変数を使う:

| 変数 | 用途 |
|---|---|
| `var(--yorishiro-bg)` | 背景色 |
| `var(--yorishiro-fg)` | テキスト色 |
| `var(--yorishiro-fg-dim)` | 薄いテキスト色 |
| `var(--yorishiro-panel-bg)` | パネル背景 |
| `var(--yorishiro-sidebar-bg)` | サイドバー背景 |
| `var(--yorishiro-border)` | ボーダー |
| `var(--yorishiro-button-bg)` | ボタン背景 |
| `var(--yorishiro-button-fg)` | ボタンテキスト |
| `var(--yorishiro-input-bg)` | input / toggle 背景 |
| `var(--yorishiro-accent)` | アクセント色 |
| `var(--yorishiro-accent-soft)` | アクセント薄め |
| `var(--yorishiro-accent-border)` | アクセントボーダー |
| `var(--yorishiro-muted)` | muted テキスト |
| `var(--yorishiro-glow)` | グロー |

## Ambient-UI pack を書く

ambient-ui pack は常時表示のオーバーレイ UI。**multi-active**（複数を同時に active にできる）。Three.js の scene 上に直接描画するか、HTML overlay として配置する。

`~/.yorishiro/packs/my-overlay/manifest.json`:

```json
{
  "id": "my-overlay",
  "type": "ambient-ui",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "executionClass": "trusted-main-thread-js",
  "entry": "ambient-ui.js"
}
```

bundled の参考実装: `bundled-packs/ambient-ui/attention-aura/`

### 境界

ambient-ui は **renderer と attention 情報のみ**。persona / system API は持たない。常時表示される性質上、パフォーマンスに注意すること。

**色は CSS 変数を使う**: UI pack と同じルール。ハードコード色を直書きせず `var(--yorishiro-*)` を使う。ただしエフェクト固有の色（パーティクル色等、scene テーマに依存しないもの）はハードコードで OK。

## 参考ファイル

> packaged build では source tree（`src/`・`bundled-packs/`・`docs/`）はディスク上に無い。bundled pack のソースは `bundled_example_read` MCP tool（id は `list_packs`）で読む。`~/.yorishiro/sdk.d.ts`（型）と `~/.yorishiro/sdk-guide.md`（ガイド）は常に読める。以下の `bundled-packs/` / `docs/` path は cwd が Yorishiro repo のときに有効。

- `~/.yorishiro/sdk.d.ts` — SDK 型定義一式（pack definition / context。毎起動で再生成）
- `~/.yorishiro/sdk-guide.md` — pack 作者向けガイド（idiom / twin-trigger co-emission。毎起動で再生成）
- `bundled-packs/personas/yori-en/`, `bundled-packs/personas/yori-ja/` — flagship persona（pattern source。共通 factory は `yori-shared/`）
- `bundled-packs/amenities/` — amenity pack の参考実装
- `bundled-packs/ui/` — UI pack の参考実装
- `bundled-packs/ambient-ui/` — ambient-ui pack の参考実装
- `docs/philosophy/PHILOSOPHY.md` — 思想的背景と pack の two-layer 設計（迷ったらここに戻る）
