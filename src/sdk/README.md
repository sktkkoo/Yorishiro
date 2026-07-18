# @yorishiro/sdk — Pack 作者向け API ガイド

このドキュメントは Yorishiro Pack を書く creator（あるいはその依頼を受けた AI）が読むための API リファレンス。**Pack を書く前に必ず読む**。

---

## UGC の Pack 種別（6 種類）

Yorishiro の UGC は 6 種類の Pack に分かれる。**どれを書きたいかで import する型と書き方が変わる**。前 3 つ（persona / amenity / effect）は **runtime-active**（event を受けて handler が動く）、scene は **declarative**（宣言が画面を規定し続ける）、ui は **primary UI**、ambient-ui は **overlay 系**（primary UI を奪わず複数 pack が重なる前提）。

| Pack type | 性格 | 責務 | 主な context API | 主な制約 |
|---|---|---|---|---|
| **Persona Pack** | runtime-active | character identity と反応 | character / voice / space | system API は持たない |
| **Amenity Pack** | runtime-active | 機能設備（タイマー等）+ MCP tool | system (exec/fs/notify) | character / voice / space は持たない（motion-free） |
| **Effect Pack** | runtime-active（短命） | rendering 実装 | renderer / audio | 最小 API のみ、state を持たない |
| **Scene Pack** | declarative | 住人の居る場（layer stack）の宣言 | **無し**（pure data） | single-active（同時に 1 つ）、active 選択は config で picks |
| **UI Pack** | primary UI | Yorishiro の操作面を定義 | three / claim / scene / state / layout / app | single-active（同時に 1 つ）。本体 layout を変更できる |
| **Ambient UI Pack** | overlay | primary UI を占有せず重ねる視覚 overlay（attention aura など） | renderer / attention | multi-active（複数同時 enable）。`ambient-ui-pack-registry` で管理 |

- `ambient-ui`: overlay 系 pack。`AmbientUiContext.attention` で attention runtime を読み、`#ambient-layer` 内の自身の container に描画する。bundled 例: `attention-aura` (v2 attention のデフォルト visual)。

**迷ったら**：

- 「キャラを反応させたい」→ Persona Pack
- 「常駐機能（タイマー等）を MCP tool として提供したい」→ Amenity Pack
- 「パーティクルや画面効果を描きたい」→ Effect Pack
- 「背景・前景の layer 構成を変えて居場所を作りたい」→ Scene Pack
- 「操作パネルや layout を差し替えたい」→ UI Pack
- 「注目状態などを overlay で常時可視化したい」→ Ambient UI Pack

---

## Persona Pack の書き方

### ファイル構造

```
personas/<pack-id>/
├── manifest.json      # pack metadata（必須）
├── persona.ts         # TS entry（必須）
├── tsconfig.json      # root tsconfig を extends（必須）
└── README.md          # 人間向け docs（推奨）
```

### manifest.json

```json
{
  "$schema": "https://yorishiro.dev/schemas/pack-manifest.schema.json",
  "id": "my-persona",
  "name": "わたし",
  "type": "persona",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "description": "...",
  "entry": "persona.ts",
  "tags": []
}
```

`type` は必ず `"persona"`。`id` は directory 名と一致させる。

### tsconfig.json

```json
{
  "extends": "../../tsconfig.json",
  "include": ["persona.ts"]
}
```

### persona.ts

```typescript
import type { PersonaDefinition, PersonaContext } from '@yorishiro/sdk';

export default {
  id: 'my-persona',
  name: 'わたし',

  thinking: {
    systemPromptAddition: `...`,  // persona の人格を決める文章
  },

  reflex: {
    responses: {
      // 反応タイプごとに handler 集合を定義
      startled: {
        handlers: [
          {
            handler: async (ctx) => {
              // ctx: PersonaContext
              ctx.character.play('VRMA_small_recoil');
              ctx.voice.play('voice:filler_ah');
            },
          },
        ],
      },
      // ... 他の reaction も同じ形で
    },
  },
} satisfies PersonaDefinition;
```

### Persona handler の中で使える API

`ctx` は `PersonaContext` 型。以下の namespace を持つ：

| namespace | 用途 |
|---|---|
| `ctx.event` | 発火した reaction と payload |
| `ctx.time` | `after(ms): Promise<void>` (sleep) / `schedule` / `every` / `probability` |
| `ctx.character` | `play` / `express` / `gaze` / `interrupt` |
| `ctx.voice` | `say` / `play` / `silence` |
| `ctx.space` | `injectEffect` （built-in と user Effect Pack を呼べる） |
| `ctx.log` | `tail` / `read` / `write` |
| `ctx.memory` | `persona` / `core` の 2 scope |
| `ctx.terminal` | `output(lastN)` （観察のみ、書き込み不可） |
| `ctx.yori` | `/yori` コマンドを発火 |
| `ctx.signal` | 中断通知の AbortSignal |

**⚠️ 使えない API**（型レベルで存在しない）：

- `ctx.system` — 存在しない。shell 実行やファイル操作は amenity の仕事
- `ctx.terminal.input` — 存在しない。PTY には書き込めない

---

## Amenity Pack の書き方

Amenity は住人の空間に備え付ける機能設備（ポモドーロ、天気、音楽再生など）。
**motion-free**：`character` / `voice` / `space` API は `AmenityContext` に存在しない。
キャラクターを反応させたいときは `ctx.emitEvent()` で synthetic event を announce し、
persona の reflex trigger に拾わせる（twin-trigger co-emission）。

### ファイル構成

```
~/.yorishiro/packs/<id>/
  manifest.json
  amenity.js     ← entry（manifest.entry が指す）
```

### manifest.json

```json
{
  "id": "my-amenity",
  "name": "My Amenity",
  "type": "amenity",
  "version": "1.0.0",
  "yorishiroVersion": "^0.4.0",
  "entry": "amenity.js"
}
```

### amenity.ts 実装

`export default ... satisfies AmenityPackDefinition` で書く。
bundled の `music-shelf`（`bundled-packs/amenities/music-shelf/amenity.ts`）が
user amenity pack の参考実装として読めるように書かれている。
`ctx.system.exec()` による外部コマンド実行、`ctx.time.every()` による定期 polling、
`ctx.emitEvent()` による persona への通知、dispose での cleanup のパターンを示す。

```typescript
import type { AmenityPackDefinition, AmenityContext } from '@yorishiro/sdk';

export default {
  id: 'my-amenity',
  name: 'My Amenity',
  // MCP tool listing 用の静的メタデータ。activate 前でも tool 一覧を返せる。
  toolMeta: [
    { name: 'my_tool_do',     description: '何かを実行する' },
    { name: 'my_tool_status', description: '現在の状態を返す' },
  ],
  // pack enable 時に呼ばれる lifecycle 関数。AmenityHandle を返す。
  activate: async (ctx: AmenityContext) => {
    // ctx.system.exec() で外部コマンドを実行できる
    // ctx.time.every() / ctx.time.schedule() で定期・遅延処理を登録できる
    // ctx.emitEvent() で persona に synthetic event を通知できる
    return {
      // key は toolMeta の name と一致させる contract。MCP 経由で呼ばれる。
      tools: {
        my_tool_do:     async (params) => { /* ... */ return { ok: true }; },
        my_tool_status: async ()       => { /* ... */ return { status: 'idle' }; },
      },
      // pack disable / アプリ終了時に呼ばれる後片付け。
      dispose: () => { /* timer cancel など */ },
    };
  },
} satisfies AmenityPackDefinition;
```

### lifecycle と cleanup

`activate(ctx)` は `AmenityHandle`（`{ tools, dispose }`）を返す。
`ctx.signal` は pack disable 時に abort される。`activate` 内で起動した非同期処理は
この signal を監視して cleanup すること。`dispose()` は disable / 終了で必ず呼ばれる。

### 環境 event への反応

`customTriggers?: ReadonlyArray<Trigger>` を宣言すると、環境 event を受けて独自の
reaction type に変換できる。キャラクターの存在反応が欲しいときは amenity から直接
motion を出さず、`ctx.emitEvent(name, payload)` で synthetic event を出し、persona
側の reflex trigger に拾わせる（twin-trigger co-emission。詳細は
[`docs/decisions/critical-constraints.md`](../../docs/decisions/critical-constraints.md) §4）。

### 使える context API

`AmenityContext` は system API（exec / fs / notify など）と共有 utility を持つが、
presence API（character / voice / space）は一切持たない（motion-free）。
`emitEvent` の contract は persona と同じ（synthetic event の announce）。

`ctx.loop.announce(phase, detail?)` は、外部の自律 agent loop（ralph 系 / 自前
harness 等）を観察する amenity が、その lifecycle phase（`started` / `iterating` /
`blocked-on-approval` / `progress-milestone` / `failed` / `completed`）を観察 stream に
流すための primitive。announce された phase は `loop-lifecycle` event として trigger に
届く（custom trigger が `event.kind === "loop-lifecycle"` で拾える）。住人 AI 側の
MCP `loop_announce` と対称。loop を **制御する** API ではない（観察境界）。詳細は
[`docs/decisions/loop-presence-layer.md`](../../docs/decisions/loop-presence-layer.md)。

---

## Effect Pack の書き方

### ファイル構造

```
effects/<pack-id>/
├── manifest.json
├── effect.ts
├── tsconfig.json
├── README.md
└── assets/            # texture / 音声（optional）
```

> **NOTE（読み手の AI へ）**: 下記の example は **teaching 用の骨格**であり、そのまま動く pack の recipe ではない。id / interface 名 / 既定値 / colorScheme / asset 参照は、実際の pack の意図に合わせて差し替えること。revelation 3.20 の「Docstring example の generic 化原則」に従い、test case と値が一致しないように意図的に generic な値を使っている。

### manifest.json

```json
{
  "id": "example-glow",
  "name": "Example Glow",
  "type": "effect",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "description": "...",
  "entry": "effect.ts"
}
```

`type` は必ず `"effect"`。`optionSchema` は manifest に置かない（code 側の `EffectDefinition.optionSchema` を single source of truth として維持する、revelation 3.19 周辺の設計決定）。

### effect.ts

```typescript
import type { EffectDefinition, EffectContext, Vec2 } from '@yorishiro/sdk';

interface ExampleGlowOptions {
  origin: Vec2;
  count?: number;
  durationMs?: number;
}

export default {
  id: 'example-glow',
  type: 'effect',
  run: async (ctx: EffectContext<ExampleGlowOptions>, options): Promise<void> => {
    const { origin, count = 20, durationMs = 800 } = options;

    // 効果音（optional）
    ctx.audio.play('./assets/pulse.wav', { volume: 0.5 });

    // パーティクルを emit
    const particles = ctx.renderer.addParticles({
      origin,
      count,
      durationMs,
      colorScheme: 'silver',
    });

    // durationMs 待って cleanup
    await ctx.time.after(durationMs);
    particles.dispose();
  },
} satisfies EffectDefinition<ExampleGlowOptions>;
```

### Effect runner の中で使える API

`ctx` は `EffectContext` 型（最小）。

| namespace | 用途 |
|---|---|
| `ctx.options` | persona が渡した options（型は自分で定義） |
| `ctx.time` | 遅延制御 |
| `ctx.signal` | 中断通知 |
| `ctx.renderer.addParticles` | パーティクル |
| `ctx.renderer.drawOnCanvas` | 直接描画 |
| `ctx.renderer.addShakeFilter` | 画面揺れ |
| `ctx.renderer.addCssFilter` | CSS filter（grayscale / blur / sepia 等） |
| `ctx.audio.play` | 効果音再生 |

**⚠️ 使えない API**（型レベルで存在しない）：

- `ctx.character` / `ctx.voice` / `ctx.space.injectEffect` — effect は他 effect を呼べない
- `ctx.system` — shell や fs には触れない
- `ctx.log` / `ctx.memory` — effect は state を持たない

### Built-in effects

Yorishiro 本体に同梱されている effect（persona から `ctx.space.injectEffect({ kind: ... })` で呼べる）：

| kind | 用途 | 主な options |
|---|---|---|
| `shake` | 画面揺れ | `intensity` (0-1), `durationMs` |
| `flash` | 色フラッシュ | `color`, `durationMs` |
| `particles` | generic パーティクル | `origin`, `count`, `durationMs`, `colorScheme` |
| `fireworks` | 花火 | `origin`, `count`, `durationMs` |
| `text-physics` | テキスト物理崩壊 | `origin`, `force`, `gravity` |
user Effect Pack も同じ API で呼ばれる（`kind` に pack id を指定）。

---

## Scene Pack の書き方

scene は **declarative**（runtime handler を持たない）。pack の宣言が **そのまま画面を規定し続ける** 存在で、event-driven な persona / amenity / effect とは性格が根本的に違う。

### ファイル構造

**bundled**（kind-first layout）：

```
bundled-packs/scenes/<pack-id>/
├── manifest.json
├── scene.ts               # TS entry（必須）
├── tsconfig.json
└── README.md
```

**user**（flat layout、`.js` 強制）：

```
~/.yorishiro/packs/<pack-id>/
├── manifest.json
└── scene.js               # user が TS から transpile した JS
```

> bundled と user で layout が**意図的に非対称**：bundled は本体の一部として種類別、user は flat。混同しない。詳細は `bundled-packs/README.md` および memory `feedback_user_pack_layout`。

### manifest.json

```json
{
  "$schema": "https://yorishiro.dev/schemas/pack-manifest.schema.json",
  "id": "my-scene",
  "name": "わたしの場所",
  "type": "scene",
  "version": "0.1.0",
  "yorishiroVersion": "^0.1.0",
  "description": "...",
  "entry": "scene.ts"
}
```

`type` は必ず `"scene"`。`id` は directory 名と一致させる。

> **`defaultActive` field は採用しない**。Scene の active 選択は pack 自己申告ではなく、`~/.yorishiro/config.json` の `activeScene` で **user が global に picks** する（memory: `feedback_single_active_config_picks`、`feedback_explicit_over_implicit_ugc`）。

### scene.ts（or scene.js）

```typescript
import type { ScenePackDefinition } from '@yorishiro/sdk';

export default {
  id: 'my-scene',
  type: 'scene',
  scene: {
    id: 'my-scene',
    layers: [
      // layer は先頭が一番奥、末尾が一番手前。
      // role: 'foreground' は default で character canvas より前に描画される
      {
        id: 'backdrop',
        role: 'background',
        backgroundImage: 'linear-gradient(180deg, #232838 0%, #161a24 100%)',
      },
      {
        id: 'vrm-slot',
        role: 'character',
        blur: 0,
      },
      {
        id: 'fg-vignette',
        role: 'foreground',
        backgroundImage: 'radial-gradient(ellipse at 50% 60%, transparent 60%, rgba(0,0,0,0.35) 100%)',
      },
    ],
  },
} satisfies ScenePackDefinition;
```

### Ambient sound

Scene が場の atmospheric layer として ambient sound を declare できる。常時 loop 再生され、scene 切替で 500ms crossfade。

```typescript
export default {
  id: 'rainy-window',
  type: 'scene',
  scene: {
    id: 'rainy-window',
    layers: [/* ... */],
    ambient: [
      { src: 'sound:rain', volume: 0.5 },                // shared library
      { src: 'sound:lofi-vibes/cafe-loop', volume: 0.3 }, // namespace 付き shared
      { src: './assets/window-creak.mp3', volume: 0.2 },  // pack-local
    ],
  },
} satisfies ScenePackDefinition;
```

- `src`: `'sound:<name>'` (shared) / `'sound:<namespace>/<name>'` (一段 namespace) / `'./...'` (pack-local) / 絶対 URL
- `volume`: 0..1, default 1.0
- 全 sound は loop 再生。one-shot は Effect Pack の `ctx.audio.play` で別系統
- shared sound の置き場と命名は `bundled-packs/shared/sounds/README.md` 参照

### Layer の field

| field | 役割 | 備考 |
|---|---|---|
| `id` | layer 識別子 | DOM の `data-layer-id` attribute |
| `role` | compositor の特殊扱い | `'background'` / `'character'` / `'foreground'` のいずれか、または省略 |
| `src` | 画像 / 動画 path | 拡張子から `<img>` / `<video>` 自動判定。`object-fit: cover` |
| `procedural` | runtime 内蔵 renderer | `{ kind: 'radiant-meadow' }` など。Scene Pack は declarative のまま、描画実装は runtime 側に閉じる。`src` と併用しない |
| `backgroundColor` | CSS background-color | 単色 |
| `backgroundImage` | CSS background-image | gradient や `url(...)` |
| `blur` | CSS `filter: blur(Xpx)` | per-layer 独立。`0` で「ぼかさない」を明示 |

`role` を持つ layer は **0 or 1 枚**：
- `'character'`: VRM slot（compositor が runtime から VRM canvas を差し込む。**通常 src/backgroundColor/backgroundImage は undefined**）
- `'background'`: 住人の奥（Phase 2 で Auto Color Correct の光源候補）
- `'foreground'`: 住人の手前（vignette、窓枠など）。default で character canvas より前に描画される

`role` を持たない layer は粒子・haze・overlay などに自由に追加可能。

### Active 選択の流れ

1. user が複数の scene pack を install / write
2. `~/.yorishiro/config.json` の `activeScene` field に id を書く（user が picks）
3. Yorishiro が起動・hot reload 時に config を読み、ScenePackRegistry が active 1 つを選ぶ
4. config が空 / null なら bundled `simple-room` に fallback

```json
// ~/.yorishiro/config.json
{
  "activeScene": "my-scene"
}
```

### Scene Pack には Context API が無い

- persona / amenity / effect は handler を持ち、それぞれ Context API（`PersonaContext` / `AmenityContext` / `EffectContext`）で runtime にアクセスする
- **scene は handler を持たない**（pure data）。よって scene 用の `SceneContext` 型は存在しない、追加もしない
- 動的に変えたい場合は **新しい scene pack に切り替える**（config で `activeScene` を書き換え → hot reload）

### `@yorishiro/sdk/r3f`

R3F primitive の re-export entry。Scene pack が R3F component を export する時に使う。
本 entry から import することで、Yorishiro 本体と同じ `@react-three/fiber` version を共有する。

詳細: specs/2026-05-03-scene-pack-r3f-component.md §3.2

### `@yorishiro/sdk/controls`

Scene pack が lighting / post effect などの runtime 調整値を公開するための entry。
pack 作者は `leva` を直接 import せず、SDK controls を使う。

`useYorishiroControls` で登録した値は **Scene panel**（F2 で開く 2 枚のうち pack-scoped 側）に出る。
runtime-wide な camera control を出す **Common panel** とは store も lifetime も独立する。
裏側の renderer は現在 leva adapter だが、pack API と UI renderer は分離されている。

```typescript
import { controlFolder, useYorishiroControls } from '@yorishiro/sdk/controls';

const [controls, setControls] = useYorishiroControls('lights', () => ({
  directionalIntensity: {
    value: 0.8,
    min: 0,
    max: 3,
    step: 0.05,
    label: 'light int.',
  },
  advanced: controlFolder(
    {
      bloomIntensity: { value: 1.0, min: 0, max: 3, step: 0.05 },
    },
    { collapsed: true },
  ),
}));
```

`useControlsBridge(packId, controls, setControls)` と組み合わせると、Scene panel と
MCP `get_ui_state` / `set_ui_state` の両方から同じ値を読み書きできる。

設計判断の詳細：[`docs/decisions/scene-controls-api.md`](../../docs/decisions/scene-controls-api.md)。

### Attention cue light（注目通知の点灯）

セッションが承認待ちなどで attention を要求すると、暖色の光が一瞬 2 回明滅する
（`AttentionLightCueStore` が「いつ光らせるか」を一元管理し、`seq` の変化で
再生が始まる）。この光の見た目（色・強さ・位置）は **scene pack が所有する**。
何もしなければ何もしなくていい ── 3 択：

1. **何もしない**：runtime が用意する default cue light がキャラの頭上付近に
   自動配置される。ほとんどの scene はこれで十分。
2. **自分で mount する**：色・強さ・位置を scene の雰囲気に合わせたい場合、
   `AttentionCueLight` を明示的に mount する。mount している間、default は
   自動で退く（同じ光が二重に点灯することはない）。
   ```tsx
   // bundled scene.tsx（bundled-packs/scenes/<id>/scene.tsx）からの相対 import 例。
   // useControlsBridge と同じく src/ を直接参照する（@yorishiro/sdk に相当する
   // 公開 alias はまだ無い）。
   import { AttentionCueLight } from '../../../src/runtime/three-runtime/attention-cue-light';

   <AttentionCueLight color="#ffb08a" intensityScale={1.8} position={[0, 1.9, 0.6]} />
   ```
   `position` を省略するとキャラの head 位置から自動配置される。明るい scene
   （directional / ambient が強い）では `intensityScale` を上げないと埋もれる。
3. **完全に消したい**：光そのものを不要とする scene は `useClaimAttentionCue()`
   だけを呼ぶ（描画は一切しない）。default が退くだけで、attention の通知手段を
   scene から取り除きたい場合に使う。

### Bundled scene の参考

- `bundled-packs/scenes/simple-room/` — flagship reference（gradient のみ、3 層構成）
- `bundled-packs/scenes/radiant-meadow/` — Three.js procedural renderer `radiant-meadow` を使う high-fidelity reference
- 詳細な data model 解説：[`src/core/scene/README.md`](../core/scene/README.md)

---

## Asset 参照の規約

### Shared ref（共有 asset）

`$DATA/shared/` にある共有 asset を参照する：

- `'vrm:<name>'` — 共有 VRM モデル。例：`'vrm:default'`
- `'anim:<name>'` — 共有 VRMA animation。例：`'anim:VRMA_wave'`
- `'voice:<name>'` — 共有 voice clip。例：`'voice:filler_gasp'`

### Local ref（pack 内 asset）

pack 内のファイルを相対パスで参照：

- `'./assets/backdrop.png'`
- `'./assets/voice/greeting.wav'`

---

## Reaction vocabulary

標準の `StandardReactionType`（以下から選ぶ）：

`'startled'` / `'contemplative'` / `'pleased'` / `'distressed'` / `'curious'` / `'focused'` / `'acknowledging'` / `'idle-fidget'` / `'confused'` / `'bored'`

**Custom reaction** を定義するには、文字列を使う：

```typescript
{ reaction: 'build-completed', payload: { ... } }
```

persona の reflex.responses や amenity の customTriggers / handler でも同じ文字列で参照する：

```typescript
responses: {
  'build-completed': { handlers: [...] }
}
```

---

## よくある間違い（これらは避けてください）

### ❌ Persona で system API を使う

```typescript
// persona handler
async (ctx) => {
  await ctx.system.exec('deploy.sh');  // ERROR: system は PersonaContext に存在しない
}
```

**正しい**：amenity を別に作って handler を書く。persona は反応の表現だけ担当。

### ❌ Amenity で character を動かす

```typescript
// amenity handler
async (ctx) => {
  ctx.character.play('VRMA_celebrate');  // ERROR: character は AmenityContext に存在しない
}
```

**正しい**：amenity は `customTriggers` で reaction を emit する（または handler 内で `ctx.emitEvent()` で synthetic event を announce する）。persona 側でそれに反応する handler を書く。

### ❌ Effect で system に触れる

```typescript
// effect runner
async (ctx, options) => {
  await ctx.system.fs.read('...');  // ERROR: system は EffectContext に存在しない
}
```

**正しい**：effect は passive な rendering 単位。state も system access も持たない。必要なら amenity に移すか、options として persona から渡す。

### ❌ 存在しない reaction type を使う

```typescript
{ reaction: 'surprised' }  // ← これは StandardReactionType に無い
```

**正しい**：`'startled'` を使う。custom で独自名にするのは OK だが、標準から外れる場合は意図的に custom として使うこと。

### ❌ PTY に書き込もうとする

```typescript
ctx.terminal.input('...');  // ERROR: input method は存在しない
```

**正しい**：PTY 観察のみ。書き込む API は意図的に存在しない（Yorishiro は Claude Code の reasoning loop に介入しない）。

### ❌ UI pack で host DOM の layout を直接書き換える

```typescript
// ui pack mount 内
document.querySelector('.shell-column')!.style.width = '100vw';  // NG
```

**正しい**：fullscreen / hidden / fixed px の切り替えは layout API で宣言する。

```typescript
import type { UiPackDefinition } from '@yorishiro/sdk';

export default {
  id: 'my-fullscreen-ui',
  type: 'ui',
  layout: {
    sidebar: { width: 'fullscreen' },
  },
  mount: (ctx, container) => {
    // runtime が shell の width / min-width / flex-basis と character 描画域を同期する。
    return { dispose() {} };
  },
} satisfies UiPackDefinition;
```

動的に切り替える場合も `ctx.layout.update({ sidebar: { width: 'fullscreen' } })` を使う。
`.shell-column` は `flex-basis` も幅決定に使うため、`style.width` だけを直接変えると
sidebar を閉じた状態から fullscreen にした時に VRM canvas の描画域と layout がずれることがある。

### ❌ handler 内で reaction を直接 emit しようとする

```typescript
// amenity handler
async (ctx) => {
  const result = await ctx.system.exec('./deploy.sh');
  if (result.exitCode !== 0) {
    ctx.emit('distressed');  // ERROR: emit method は存在しない
  }
}
```

**正しい**：`ctx.emitEvent('deploy-failed', { exitCode: result.exitCode })` で synthetic event を announce し、その synthetic event を match する custom trigger で `'distressed'` を emit する（Twin-trigger idiom を synthetic event にも適用する）。

理由：reaction の発生は必ず trigger match を経由することで、pack の振る舞いが trigger 定義を読むだけで分かる。handler の中に reaction 発火を隠さない。

---

## 開発フロー

1. 既存 pack（`personas/yori/` など）を `cat` で読んで pattern を把握する
2. どの Pack type を書くか決める
3. `manifest.json` を書く（type と id を正しく指定）
4. `.ts` entry file を書く（`satisfies <Type>Definition` で型チェック）
5. `tsconfig.json` を書く（root を extends）
6. `tsc --noEmit` で型エラーが無いことを確認
7. `cat $DATA/.yorishiro/sdk/README.md` を参照して API 確認
8. Yorishiro は file watcher で変更を pick up し、hot reload する

型エラーが出たら、**fix して reload する**（これは creator loop の自然な iteration）。
