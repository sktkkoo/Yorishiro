# @charminal/sdk — Pack 作者向け API ガイド

このドキュメントは Charminal Pack を書く creator（あるいはその依頼を受けた AI）が読むための API リファレンス。**Pack を書く前に必ず読む**。

---

## UGC の三軸

Charminal の UGC は 3 種類の Pack に分かれる。**どれを書きたいかで import する型が変わる**。

| Pack type | 責務 | 主な context API | 主な制約 |
|---|---|---|---|
| **Persona Pack** | character identity と反応 | character / voice / space | system API は持たない |
| **Harness Pack** | 機能的 automation | system (exec/fs/notify) | character / voice / space は持たない（motion-free） |
| **Effect Pack** | rendering 実装 | renderer / audio | 最小 API のみ、lifecycle 短い |

**迷ったら**：

- 「キャラを反応させたい」→ Persona Pack
- 「コマンドを実行したり通知を出したりしたい」→ Harness Pack
- 「パーティクルや画面効果を描きたい」→ Effect Pack

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
  "$schema": "https://charminal.dev/schemas/pack-manifest.schema.json",
  "id": "my-persona",
  "name": "わたし",
  "type": "persona",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
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
import type { PersonaDefinition, PersonaContext } from '@charminal/sdk';

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

  world: {
    body: 'vrm:default',      // 既存 VRM の shared ref
    voice: 'voice:default',
    space: 'space:default',
  },

  logReading: {
    readWhen: { kind: 'session-boundary' },
    framing: 'own',
    windowSize: 10,
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
| `ctx.charm` | `/charm` コマンドを発火 |
| `ctx.signal` | 中断通知の AbortSignal |

**⚠️ 使えない API**（型レベルで存在しない）：

- `ctx.system` — 存在しない。shell 実行やファイル操作は harness の仕事
- `ctx.terminal.input` — 存在しない。PTY には書き込めない

---

## Harness Pack の書き方

### ファイル構造

```
harnesses/<pack-id>/
├── manifest.json
├── harness.ts
├── tsconfig.json
└── README.md
```

### manifest.json

```json
{
  "id": "build-automation",
  "name": "Build Automation",
  "type": "harness",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "description": "...",
  "entry": "harness.ts",
  "permissions": {
    "system.exec": true,
    "system.notify": true,
    "system.fs": { "read": ["./**"], "write": ["./logs/**"] }
  }
}
```

`type` は必ず `"harness"`。`permissions` は MVP では文書的（enforce されない）が、使う API を宣言しておくと明示的になる。

### harness.ts

```typescript
import type { HarnessDefinition, HarnessContext } from '@charminal/sdk';

export default {
  id: 'build-automation',
  name: 'Build Automation',

  // 独自の reaction を検知する trigger
  customTriggers: [
    {
      id: 'build-success',
      match: (event) => {
        if (event.kind !== 'pty-output') return null;
        if (!/BUILD SUCCESS/.test(event.text)) return null;
        return {
          reaction: 'build-completed',  // custom reaction type
          payload: { at: event.timestamp },
        };
      },
    },
  ],

  // reaction が発火したときの automation
  automations: {
    'build-completed': {
      handlers: [
        {
          handler: async (ctx) => {
            // ctx: HarnessContext
            const result = await ctx.system.exec('./deploy.sh');
            if (result.exitCode === 0) {
              await ctx.system.notify({
                title: 'Deploy completed',
                body: 'デプロイが終わりました',
              });
            }
          },
        },
      ],
    },
  },
} satisfies HarnessDefinition;
```

### Harness automation の中で使える API

`ctx` は `HarnessContext` 型。

| namespace | 用途 |
|---|---|
| `ctx.event` | 発火した reaction と payload |
| `ctx.time` | 同上 |
| `ctx.system.exec` | shell コマンド |
| `ctx.system.spawn` | 長時間プロセス |
| `ctx.system.fs` | `read` / `write` / `exists` |
| `ctx.system.notify` | OS 通知 |
| `ctx.log` / `ctx.memory` / `ctx.terminal` / `ctx.charm` / `ctx.signal` | persona と同じ |

**⚠️ 使えない API**（型レベルで存在しない）：

- `ctx.character` — 存在しない。モーションは persona の仕事
- `ctx.voice` — 存在しない。発話は persona の仕事
- `ctx.space` — 存在しない。effect は persona から呼ばれる

もし「harness から character を動かしたい」と感じたら、設計の視点を変える必要がある：

1. **harness は custom trigger で reaction を emit する**
2. **persona 側でその reaction に反応する handler を書く**
3. persona handler がキャラを動かす

### Twin-trigger co-emission idiom（推奨 pattern）

harness が同じ環境 event に対して、自分の functional 処理（`system.exec` / `system.notify` 等）を走らせつつ、persona に反射的な presence expression（`distressed` / `pleased` 等）を同時に起こしたい場合の**標準 idiom**。

#### 何のための pattern か

- harness には身体（character / voice / space）が無い。motion-free 原則のため持てない
- しかし「コマンドが失敗した」「build が通った」のような観測は harness 側の決定論的 helper で一番綺麗に書ける
- そこで、**同じ event を 2 本の custom trigger で観測し、片方は自分の custom reaction、もう片方は標準 reaction を emit する**
- harness は自分の custom reaction を handle し、persona は既存の reflex handler（`distressed` / `pleased` 等）でそのまま身体を動かす

この pattern は dry-run で error-notifier / diff-keeper / celebrate-and-deploy の 3 連続で AI が自発的に発明した。経験的な裏付けがあるので、正式に推奨 pattern として採用する。

#### Shape

```typescript
import type { HarnessDefinition, HarnessContext, DispatchEvent } from '@charminal/sdk';

// 決定論的な detection helper（両 trigger が共有する）
function detectError(event: DispatchEvent): { matched: string } | null {
  if (event.kind !== 'pty-output') return null;
  // ... 実際の pattern match
  return /* ErrorDetection | null */ null;
}

export default {
  id: 'my-harness',
  name: 'My Harness',

  customTriggers: [
    // (1) harness 自身のための custom reaction
    {
      id: 'my-harness:command-failed',
      priority: 10,
      match: (event) => {
        const err = detectError(event);
        return err ? { reaction: 'command-failed', payload: err } : null;
      },
    },
    // (2) persona の反射を起こすための standard reaction
    {
      id: 'my-harness:signal-distressed',
      priority: 5,
      match: (event) => {
        const err = detectError(event);  // 同じ helper、同じ判定
        return err ? { reaction: 'distressed', payload: err } : null;
      },
    },
  ],

  automations: {
    // 自分の custom reaction は自分で handle
    'command-failed': {
      handlers: [
        {
          handler: async (ctx: HarnessContext) => {
            const payload = ctx.event.payload as { matched: string } | undefined;
            await ctx.system.notify({
              title: 'Command failed',
              body: payload?.matched ?? '',
            });
          },
        },
      ],
    },
    // 'distressed' は persona 側の reflex.responses で handle される。
    // harness は触らない。
  },
} satisfies HarnessDefinition;
```

#### Key points

- **両 trigger は同じ決定論的 helper**（上例の `detectError`）を共有する。判定の一貫性はここで担保する。片方だけ fire することは無い
- **cooldown は automation 側に設定できる**ので、functional 側（`command-failed`）は notify spam 防止の長めの cooldown、presence 側（`distressed`）は persona reflex の連続性を保つ短めの cooldown、と独立に調整できる
- **priority は documentation 的な意味**（同じ event に対して並列実行なので順序問題は発生しない）
- **persona との loose coupling**：既存 persona に `distressed` handler があれば、persona を swap しても pattern はそのまま機能する。harness 側は persona 名を知らない
- **pack minimization culture**：`distressed` のような標準 reaction handler に乗ることで、harness のために新しい persona を作る必要が無い。既存資産を再利用する設計になる

### Synthetic event による handler 内 announcement（上級 pattern）

Twin-trigger idiom は「環境 event を perceive した瞬間」の declarative な反応を扱う。しかし **handler の計算結果**（例：`ctx.system.exec` が 30 秒後に返した exitCode、`ctx.system.fs.read` の結果）から新たな reaction を起こしたいケースがある。これには別の pattern を使う。

#### やってはいけないこと

handler の中で reaction を直接 emit する API は**存在しない**。`ctx.emit(reaction)` のような method は無く、今後も追加しない（composability が壊れるため — reaction の発生源が handler の内部に隠れてしまうと、pack の振る舞いを trigger 定義からだけでは追えなくなる）。

#### 正しい方法

`ctx.emitEvent(name, payload)` で **synthetic event を announce する**。runtime はこれを通常の trigger loop に投入し、custom trigger が match すれば reaction が emit される。結果として synthetic event に対しても **Twin-trigger idiom がそのまま適用できる**。

#### Shape

```typescript
import type { HarnessDefinition, HarnessContext, DispatchEvent } from '@charminal/sdk';

function isBuildSuccess(event: DispatchEvent): boolean {
  return event.kind === 'pty-output' && /BUILD SUCCESS/.test(event.text);
}

export default {
  id: 'celebrate-and-deploy',
  name: 'Celebrate and Deploy',

  customTriggers: [
    // (1) 元の build success event に対する Twin-trigger
    {
      id: 'my:build-success-self',
      match: (e) => (isBuildSuccess(e) ? { reaction: 'build-completed' } : null),
    },
    {
      id: 'my:build-success-pleased',
      match: (e) => (isBuildSuccess(e) ? { reaction: 'pleased' } : null),
    },

    // (2) 自分が emit する synthetic event 'my:deploy-failed' への Twin-trigger
    {
      id: 'my:deploy-failed-self',
      match: (e) =>
        e.kind === 'synthetic' && e.name === 'my:deploy-failed'
          ? { reaction: 'deploy-failed', payload: e.payload }
          : null,
    },
    {
      id: 'my:deploy-failed-distressed',
      match: (e) =>
        e.kind === 'synthetic' && e.name === 'my:deploy-failed'
          ? { reaction: 'distressed', payload: e.payload }
          : null,
    },
  ],

  automations: {
    'build-completed': {
      handlers: [
        {
          handler: async (ctx: HarnessContext) => {
            await ctx.time.after(2500);
            const result = await ctx.system.exec('./deploy.sh', { timeoutMs: 60000 });
            if (result.exitCode !== 0) {
              // 直接 distressed を emit しない。
              // observation を synthetic event として announce する。
              ctx.emitEvent('my:deploy-failed', {
                exitCode: result.exitCode,
                stderr: result.stderr,
              });
            }
          },
        },
      ],
    },
    'deploy-failed': {
      handlers: [
        {
          handler: async (ctx: HarnessContext) => {
            await ctx.system.notify({ title: 'Deploy failed' });
          },
        },
      ],
    },
  },
} satisfies HarnessDefinition;
```

#### Key points

- **mental model**：handler の中で得た「観察」を synthetic event として announce し、trigger match 経由で reaction に変換する。reaction の発生源はあくまで trigger 定義であり、handler はそこを素通りしない
- **imperative な指示は出さない**：「直接 persona を悲しませる」のような書き方はしない。`observation → event → trigger → reaction` という一方向の flow を守る
- **誠実さの原則との整合**：`docs/philosophy/INHABITED_INTERFACE_PHILOSOPHY.md` の「コンテキストの壁」と整合する。reaction は必ず perception（本物の event または合成された synthetic event）由来で、捏造された身振りは発生しない
- **型**：synthetic event は `kind: 'synthetic'`、`name: string`、`payload?: unknown` の形（具体的な型は `@charminal/sdk` の `SyntheticEvent`）
- **scope**：`ctx.emitEvent` は **PersonaContext と HarnessContext の両方**にある。Effect Pack には無い（effect は reaction system の consumer で、event の発信源にはならない）

#### Runtime contract（知っておくべき挙動）

以下は runtime が `ctx.emitEvent` について保証する動作。`context.d.ts` の JSDoc にも同じ内容を記載している：

- **Timing**: trigger matching は emit 呼び出しの calling stack で同期実行される。match した handler は外来 event と同じ async scheduler に投入され、emit 側の handler は block されない
- **Timestamp**: `SyntheticEvent.timestamp` は emit 呼び出し時点の `time.now()` で runtime が自動補填する。dispatch の実時刻ではなく observation の瞬間を表す
- **Cooldown 計測**: 発火した reaction の cooldown 計測 start は emit 時点（= synthetic event の timestamp）。したがって handler の計算時間に cooldown が影響されない
- **Source 改ざん不能**: `SyntheticEvent.source` は runtime が pack load 時に per-pack bound context へ closure capture する。handler 側から他 pack の packId を名乗ることはできない
- **Loop protection (MVP)**: dispatch chain の depth は runtime が track し、**max depth 4** を超えると runtime が log.warn を残して emit を silently drop する（例外は投げない）。depth 1 = 外来 event、depth 2-4 = synthetic chain。それ以上の深さが必要なら、それは設計の黄色信号

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
  "charminalVersion": "^0.1.0",
  "description": "...",
  "entry": "effect.ts"
}
```

`type` は必ず `"effect"`。`optionSchema` は manifest に置かない（code 側の `EffectDefinition.optionSchema` を single source of truth として維持する、revelation 3.19 周辺の設計決定）。

### effect.ts

```typescript
import type { EffectDefinition, EffectContext, Vec2 } from '@charminal/sdk';

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
| `ctx.renderer.addColorFilter` | 色フィルタ |
| `ctx.audio.play` | 効果音再生 |

**⚠️ 使えない API**（型レベルで存在しない）：

- `ctx.character` / `ctx.voice` / `ctx.space.injectEffect` — effect は他 effect を呼べない
- `ctx.system` — shell や fs には触れない
- `ctx.log` / `ctx.memory` — effect は state を持たない

### Built-in effects

Charminal 本体に同梱されている effect（persona から `ctx.space.injectEffect({ kind: ... })` で呼べる）：

| kind | 用途 | 主な options |
|---|---|---|
| `shake` | 画面揺れ | `intensity` (0-1), `durationMs` |
| `flash` | 色フラッシュ | `color`, `durationMs` |
| `particles` | generic パーティクル | `origin`, `count`, `durationMs`, `colorScheme` |
| `fireworks` | 花火 | `origin`, `count`, `durationMs` |
| `text-physics` | テキスト物理崩壊 | `origin`, `force`, `gravity` |
| `text-glitch` | テキストグリッチ | `durationMs`, `intensity` |

user Effect Pack も同じ API で呼ばれる（`kind` に pack id を指定）。

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

persona の reflex.responses や harness の automations でも同じ文字列で参照する：

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

**正しい**：harness を別に作って automation を書く。persona は反応の表現だけ担当。

### ❌ Harness で character を動かす

```typescript
// harness automation
async (ctx) => {
  ctx.character.play('VRMA_celebrate');  // ERROR: character は HarnessContext に存在しない
}
```

**正しい**：harness は custom trigger で reaction を emit し、persona 側でそれに反応する handler を書く。

### ❌ Effect で system に触れる

```typescript
// effect runner
async (ctx, options) => {
  await ctx.system.fs.read('...');  // ERROR: system は EffectContext に存在しない
}
```

**正しい**：effect は passive な rendering 単位。state も system access も持たない。必要なら harness に移すか、options として persona から渡す。

### ❌ 存在しない reaction type を使う

```typescript
{ reaction: 'surprised' }  // ← これは StandardReactionType に無い
```

**正しい**：`'startled'` を使う。custom で独自名にするのは OK だが、標準から外れる場合は意図的に custom として使うこと。

### ❌ PTY に書き込もうとする

```typescript
ctx.terminal.input('...');  // ERROR: input method は存在しない
```

**正しい**：PTY 観察のみ。書き込む API は意図的に存在しない（Charminal は Claude Code の reasoning loop に介入しない）。

### ❌ handler 内で reaction を直接 emit しようとする

```typescript
// harness automation
async (ctx) => {
  const result = await ctx.system.exec('./deploy.sh');
  if (result.exitCode !== 0) {
    ctx.emit('distressed');  // ERROR: emit method は存在しない
  }
}
```

**正しい**：`ctx.emitEvent('deploy-failed', { exitCode: result.exitCode })` で synthetic event を announce し、その synthetic event を match する custom trigger で `'distressed'` を emit する（Twin-trigger idiom を synthetic event にも適用する）。

理由：reaction の発生は必ず trigger match を経由することで、pack の振る舞いが trigger 定義を読むだけで分かる。handler の中に reaction 発火を隠さない。これは upper 層の Synthetic event pattern subsection で詳しく説明している。

---

## 開発フロー

1. 既存 pack（`personas/charminal-default/` など）を `cat` で読んで pattern を把握する
2. どの Pack type を書くか決める
3. `manifest.json` を書く（type と id を正しく指定）
4. `.ts` entry file を書く（`satisfies <Type>Definition` で型チェック）
5. `tsconfig.json` を書く（root を extends）
6. `tsc --noEmit` で型エラーが無いことを確認
7. `cat $DATA/.charminal/sdk/README.md` を参照して API 確認
8. Charminal は file watcher で変更を pick up し、hot reload する

型エラーが出たら、**fix して reload する**（これは creator loop の自然な iteration）。
