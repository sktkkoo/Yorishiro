# Trigger / Reaction System Architecture

**Status**: active
**Last updated**: 2026-05-08
**Related**: `src/sdk/reaction.d.ts`, `src/runtime/event-bus/event-bus.ts`, `src/runtime/persona-reflex/persona-reflex-dispatcher.ts`

## TL;DR

環境 event は EventBus を通じて登録済み Trigger に同期 match され、match した handler が非同期で schedule される。handler 内から reaction を直接 emit する経路は存在せず、synthetic event → trigger match が唯一の chain 手段。

---

## 全体 flow

```
                        External sources
                        ┌──────────────┐
                        │ PTY output   │
                        │ Hook signal  │
                        │ User input   │
                        │ Idle timer   │
                        │ Tool activity│
                        │ Window event │
                        │ Scene change │
                        │ /charm cmd   │
                        └──────┬───────┘
                               │
                     Perception (src/core/perception/)
                               │
                               ▼
                  ┌─────────────────────────────┐
                  │     EventBus.dispatch(event) │  depth = 1
                  │                             │
                  │  ┌─ for each registered ──┐ │
                  │  │  trigger.match(event)   │ │  [同期]
                  │  │  → TriggerMatch | null  │ │
                  │  └─────────────────────────┘ │
                  │                             │
                  │  matched entries を          │
                  │  priority desc + seq asc で │
                  │  stable sort                │
                  │                             │
                  │  ┌─ for each matched ─────┐ │
                  │  │  schedule(handler)      │ │  [非同期: queueMicrotask]
                  │  └────────────────────────┘ │
                  └─────────────────────────────┘
                               │
                               ▼
                  ┌─────────────────────────────┐
                  │  PersonaReflexDispatcher     │
                  │                             │
                  │  1. responses[reaction] lookup│
                  │  2. cooldown filtering       │
                  │  3. weighted random selection │
                  │  4. PersonaContext 構築       │
                  │  5. handler(ctx) 起動         │
                  └──────────────┬──────────────┘
                               │
              handler 内で ctx.emitEvent() を呼ぶと
                               │
                               ▼
                  ┌─────────────────────────────┐
                  │  EventBus.emitSynthetic()    │  depth = parent + 1
                  │                             │
                  │  depth > maxDepth(4)?        │
                  │  → YES: logger.warn + drop   │
                  │  → NO:  dispatchAtDepth()    │
                  │         (上の match loop へ)  │
                  └─────────────────────────────┘
```

---

## DispatchEvent — trigger が観察する入力（9 種）

型定義: `src/sdk/reaction.d.ts`

### 外来 event（runtime が生成）

| kind | 発生源 | 主な用途 |
|---|---|---|
| `pty-output` | PTY 出力（ANSI escape 含む可能性） | 出力パターンの検出 |
| `hook-signal` | Claude Code hook bridge | ターン境界・tool 活動の検出 |
| `user-input` | ターミナル入力 | キー入力の観察 |
| `idle` | アイドル検知（`durationMs` 付き） | 暇な時間の反応 |
| `tool-activity` | 推定ツール活動（`reading` / `writing` / `running` / `none`） | Body state 遷移 |
| `window` | ウィンドウ状態（`resize` / `focus` / `blur`） | focus/blur 反応 |
| `scene-change` | シーン切替（`fromId` → `toId`） | シーン遷移時の反応 |
| `charm-command` | `/charm` コマンド | ユーザーコマンド処理 |

### Synthetic event（handler が生成）

| kind | 発生源 | 主な用途 |
|---|---|---|
| `synthetic` | handler の `ctx.emitEvent(name, payload)` | handler 間の declarative な情報伝達 |

SyntheticEvent は `source`（発行 pack の type + packId、runtime が自動 stamp）、`name`（推奨: `<packId>:<eventName>`）、`payload`（任意）、`timestamp`（emit 時点で自動補填）を持つ。handler 側から `source` を差し替える経路は存在しない（closure-bound）。

### Hook signal のタイミング

| SDK name | upstream | fire timing |
|---|---|---|
| `pre-tool-use` | `PreToolUse` | tool 呼び出しの直前 |
| `post-tool-use` | `PostToolUse` | tool 正常完了の直後 |
| `post-tool-failure` | `PostToolUseFailure` | tool 失敗の直後 |
| `user-prompt-submit` | `UserPromptSubmit` | **次ターン処理開始境界**（前ターン応答完了後。Enter 押下瞬間ではない） |
| `stop` | `Stop` | Claude 応答完了（ターン終了） |
| `notification` | `Notification` | Claude notification 発行時 |

`user-prompt-submit` の遅延問題と sent aura 事例の詳細: [hook-signals.md](hook-signals.md)

---

## Trigger — マッチングの仕組み

型定義: `src/sdk/reaction.d.ts`

```typescript
interface Trigger {
  readonly id: string;
  readonly priority?: number;              // 大きいほど先に処理
  match(event: DispatchEvent): TriggerMatch | null;  // 決定論的であるべき
}

interface TriggerMatch {
  readonly reaction: ReactionType;         // 標準 10 種 + custom string
  readonly payload?: unknown;              // amenity → persona の情報伝達
}
```

### 標準 ReactionType（10 種）

`startled` / `contemplative` / `pleased` / `distressed` / `curious` / `focused` / `acknowledging` / `idle-fidget` / `confused` / `bored`

これ以外の任意文字列も `ReactionType` として使える（例: `"mischievous-shoot"`, `"celebrate"`）。

### マッチングの実行

1. `dispatchAtDepth(event, depth)` が全登録 trigger に対して **同期的に** `match()` を実行
2. matched entries を **priority 降順 → registration sequence 昇順** で stable sort
3. 各 handler を `queueMicrotask()` 経由で **非同期に** schedule（fire-and-forget）
4. handler 内の例外は `logger.error` で記録、他の handler には影響しない

### Priority の解決

同一 event に複数 trigger がマッチした場合:
- `priority` が高い trigger の handler が先に schedule される
- 同 priority は登録順（`sequence` 昇順）で tiebreak
- `priority` 未指定は 0 として扱う

---

## EventBus — ディスパッチャコア

実装: `src/runtime/event-bus/event-bus.ts`

### 責務

- 外来 event の dispatch（`dispatch(event)` → depth = 1）
- Synthetic event の dispatch（`emitSynthetic(source, name, payload, parentDepth)` → depth = parent + 1）
- Trigger の register / dispose
- Dispatch chain depth の制限（最大 4、超過は logger.warn + silent drop）

### Dispatch chain depth protection

Synthetic event が更に synthetic event を emit する chain に対し、深度制限（MVP default: 4）を設ける。

- Depth 1: 外来 event
- Depth 2-4: synthetic chain
- Depth 5+: silent drop（例外は投げない）

目的は無限 loop の防止。深度 4 は MVP の値で、constructor から override 可能。

### 設計上の不変条件

- `Trigger.match()` は dispatch stack 上で synchronous に走る（side-effect なし）
- handler は schedule 経由で async に走る（dispatch 呼び出し元を block しない）
- `SyntheticEvent.timestamp` は `emitSynthetic` 時点の `time.now()` を自動補填
- Cooldown は bus の責務ではない（PersonaReflexDispatcher 側の責務）
- `PackSource` は register/emitSynthetic の呼び出し側（PersonaReflexDispatcher）が closure-bind して渡す

---

## PersonaReflexDispatcher — trigger から motion/expression/effect への bridge

実装: `src/runtime/persona-reflex/persona-reflex-dispatcher.ts`

### 責務

Active persona の `reflex`（`customTriggers` + `responses`）を EventBus に bridge する。

1. `PersonaRegistry.subscribeActive` で active persona の変化を購読
2. Active 切替時: 旧 registrations を dispose → 新 persona の `customTriggers` を bus に register
3. Handler 起動時: responses-table lookup → cooldown filtering → weighted random selection → PersonaContext 構築 → handler 呼び出し

### Handler 選択の詳細

1. **Response lookup**: `persona.reflex.responses[event.reaction]` で `PersonaReactionSet` を取得
2. **Cooldown filtering**: 各 handler の `cooldownMs` と `lastFiredAt` を比較、elapsed していないものを除外
3. **Weighted random**: 残った候補から `weight`（未指定は 1）に基づく weighted random pick
4. **Cooldown stamp**: handler 起動 **前に** fire 時刻を記録（throw しても cooldown は消費される）
5. **Context 構築**: `PersonaContextFactory` で `PersonaContext` を生成（`emitEvent` closure に `PackSource` と `depth` を bind）
6. **Fire-and-forget**: handler が Promise を返した場合は `.catch()` で error を logger に報告

### Cooldown 基準時刻

`event.triggeredBy.timestamp` を使う（`Date.now()` ではない）。synthetic event は producer の timestamp を保持し、EventBus が emit 時に補填するため、dispatch timing とは独立した observation 時刻が cooldown 基準になる。

---

## Context API 境界 — persona と amenity の分離

型定義: `src/sdk/context.d.ts`

| API | PersonaContext | AmenityContext |
|---|---|---|
| `character`（animation / expression / gaze） | あり | **なし** |
| `voice`（TTS / clips） | あり | **なし** |
| `space`（effects） | あり | **なし** |
| `system`（exec / fs / notify） | **なし** | あり |
| `emitEvent` | あり | あり |
| `time` / `log` / `memory` / `terminal` / `charm` | あり | あり |
| `signal`（AbortSignal） | あり | あり |

型レベルで強制されており、amenity が motion を触る経路は物理的に存在しない。詳細: [critical-constraints.md](critical-constraints.md) §2

---

## 正規 idiom

### Twin-trigger co-emission

同じ環境 event に amenity の機能反応と persona の存在反応を共存させたい場合、**同じ trigger を二つの pack に独立に書く**。amenity から persona を直接呼ぶ API は提供しない。

詳細: [critical-constraints.md](critical-constraints.md) §4

### Synthetic event による handler 間伝達

handler が「観察した事実」を他の trigger に伝えるには、`ctx.emitEvent(name, payload)` で synthetic event を announce する。直接 reaction を emit する API は意図的に存在しない。

```
handler が事実を観察
  → ctx.emitEvent('deploy-failed', { exitCode, stderr })
    → EventBus が SyntheticEvent を生成、trigger loop に投入
      → 別の customTrigger が kind === 'synthetic' を match
        → { reaction: 'distressed' } を返す
          → persona の responses['distressed'] handler が発火
```

詳細: [critical-constraints.md](critical-constraints.md) §3

---

## Trigger 発火の 3 axes

[motion-effect-trigger-axes.md](motion-effect-trigger-axes.md) で定義。

| Axis | 主体 | 配置 | 例 |
|---|---|---|---|
| persona → motion + effect | persona | `customTriggers` + `responses` | idle → イタズラ |
| effect → motion | effect の機構 | EffectContext body API（**deferred**） | TextPhysics → character が屈む |
| event → state mutation | system 配線 | App.tsx inline trigger | `pre-tool-use` → body state を `thinking` に |

旧 system reaction trigger（`builtInTriggers`）は廃止済み。core が固定の event → reaction mapping を強要すると persona の個性が消えるため。

---

## 実装の具体例（bundled clai persona）

`bundled-packs/personas/clai/persona.ts` より抜粋:

### Custom trigger の定義

```typescript
customTriggers: [
  {
    id: "clai:error",
    match(event) {
      if (event.kind !== "hook-signal") return null;
      if (event.signal.name !== "post-tool-failure") return null;
      // Grep/Glob の benign failure は無視
      const toolName = (event.signal.payload as any)?.tool_name;
      if (["Grep", "Glob"].includes(toolName)) return null;
      return { reaction: "distressed", payload: event.signal.payload };
    },
  },
  {
    id: "clai:idle-shoot",
    match(event) {
      if (event.kind !== "idle") return null;
      if (event.durationMs < 90_000) return null;
      if (Math.random() >= 0.3) return null;
      return { reaction: "mischievous-shoot" };
    },
  },
]
```

### Response handler の定義

```typescript
responses: {
  distressed: {
    handlers: [{
      label: "frown-and-shake",
      handler: async (ctx) => {
        // Expression: 表情変更
        const expr = ctx.character.express({ kind: "mood", preset: "sad" }, 0.7);
        // Effect: 画面揺れ
        ctx.space.injectEffect({ kind: "screen-shake", intensity: 0.35, durationMs: 500 });
        // Timing: 待機後にクリーンアップ
        await ctx.time.after(2500);
        if (ctx.signal.aborted) return;
        expr.release(600);
      },
    }],
  },
}
```

---

## 主要ファイル一覧

| コンポーネント | ファイル | 責務 |
|---|---|---|
| Trigger / Event 型定義 | `src/sdk/reaction.d.ts` | DispatchEvent union、Trigger、TriggerMatch、ReactionEvent |
| EventBus | `src/runtime/event-bus/event-bus.ts` | Trigger dispatch engine（match + schedule + depth protection） |
| PersonaReflexDispatcher | `src/runtime/persona-reflex/persona-reflex-dispatcher.ts` | Active persona の reflex を bus に bridge |
| Perception | `src/core/perception/perception.ts` | 外部 event（PTY / hooks / idle）の収集 |
| Context 型定義 | `src/sdk/context.d.ts` | PersonaContext / AmenityContext の API 境界 |
| PersonaRegistry | `src/runtime/persona-registry/` | Single-active persona の状態管理 |
| CLAI persona | `bundled-packs/personas/clai/persona.ts` | Trigger + response の reference implementation |

---

## 関連 reference

### Decisions

- [critical-constraints.md](critical-constraints.md) — §3 Synthetic event、§4 Twin-trigger co-emission
- [motion-effect-trigger-axes.md](motion-effect-trigger-axes.md) — 3 axes の定義と system reaction trigger 廃止
- [hook-signals.md](hook-signals.md) — hook signal のタイミング契約と sent aura 事例

### Philosophy

- [docs/philosophy/PRESENCE_HARNESS.ja.md](../philosophy/PRESENCE_HARNESS.ja.md) — Twin-trigger co-emission、Synthetic event
- [docs/philosophy/INHABITED_CHARACTER_INTERFACE.ja.md](../philosophy/INHABITED_CHARACTER_INTERFACE.ja.md) — 観察の境界

---

## 改訂履歴

- 2026-05-08: 初版。分散していたトリガー・リアクションシステムの設計知識を統合 architecture overview として作成
