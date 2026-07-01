# Standard Hooks / Dispatch Events

> Pack 作者と `/charm` が標準 event 語彙を引くためのカタログ。
> 正本は [`src/sdk/reaction.d.ts`](../../src/sdk/reaction.d.ts)。
> この文書は自動生成ではない。`DispatchEvent` / `HookSignal` を変更したら一緒に更新する。

Charminal の反応 flow は固定の `hook -> reaction` 表ではない。

```text
observed / derived / synthetic event
  -> Trigger.match(event)
  -> ReactionType
  -> persona.reflex.responses[reaction]
```

Core は event を流すだけで、「その event をどう受け取るか」は persona / utility pack の trigger が決める。
これにより、同じ `post-tool-failure` でも persona によって `distressed` にするか、無視するか、別の custom reaction にするかを選べる。

---

## Event Classes

| Class | Meaning | Type |
|---|---|---|
| Observed | Runtime が外部 source から直接観測した event | `ObservedEvent` |
| Derived | Runtime が観測結果から pack 作者向けに生成した便利 event | `DerivedEvent` |
| Synthetic | Persona / utility handler が `ctx.emitEvent()` で announce した event | `SyntheticEvent` |

Pack の trigger は通常 `DispatchEvent` を受ける。上の分類は読みやすさのための整理で、match flow は同じ。

---

## Observed Events

| `event.kind` | Source | Payload | Typical use |
|---|---|---|---|
| `pty-output` | PTY の出力 text | `text`, `timestamp` | terminal 出力の pattern 検出 |
| `hook-signal` | Claude Code hook bridge | `signal`, `timestamp` | tool lifecycle / turn boundary の検出 |
| `user-input` | terminal への user input | `text`, `timestamp` | 打鍵・入力内容への反応 |
| `window` | Charminal window state | `change`, `timestamp` | focus / blur / resize への反応 |
| `scene-change` | active scene の切替 | `fromId`, `toId`, `timestamp` | scene 移行時の一時反応 |
| `charm-command` | `/charm` command | `command`, `timestamp` | command 実行への補助反応 |
| `loop-lifecycle` | 自律 agent loop の自己申告（MCP `loop_announce` / pack `ctx.loop.announce`） | `phase`, `agent`, `detail?`, `timestamp` | ループの進行・停滞・完了の観察（observation-only） |

`loop-lifecycle` の `phase` は `started` / `iterating` / `blocked-on-approval` /
`progress-milestone` / `failed` / `completed` の 6 種。`agent` は報告元の terminalAgent id
（`"claude"` / `"codex"` 等、pack 由来は `null`）を host が stamp する。Charminal は loop を
観察するだけで制御しない。詳細は [`docs/decisions/loop-presence-layer.md`](../decisions/loop-presence-layer.md)。

### Hook Signals

`hook-signal` は Claude Code / Codex の公式 hook lifecycle を kebab-case に写した event。
`signal.payload` は hook server が受け取った raw payload を保持する。

`PermissionRequest` や `TaskCompleted` などの汎用 agent lifecycle は、承認待ち UI・失敗反応・
subagent/compact 反応のための trigger であり、`loop-lifecycle` には自動変換しない。
`loop-lifecycle` は loop engineering 用の明示 signal として扱う。

| `event.signal.name` | Upstream hook | Timing | Typical use | Caution |
|---|---|---|---|---|
| `session-start` | `SessionStart` | session 開始・resume | session 初期化 reaction、resume 検出 | agent ごとに payload shape が違う |
| `pre-tool-use` | `PreToolUse` | tool 呼び出しの直前 | tool 実行検出、diagnostic aura、body state | tool 名の分類は downstream 側の解釈 |
| `post-tool-use` | `PostToolUse` | tool が正常完了した直後 | 完了検出、成功系 reaction | tool output は payload shape を確認して読む |
| `post-tool-failure` | `PostToolUseFailure` | tool が失敗した直後 | error reaction、失敗診断 | no-match など benign failure を除外する場合がある |
| `post-tool-batch` | `PostToolBatch` | parallel tool batch 完了 | batch 単位の progress reaction | Claude Code のみ |
| `permission-request` | `PermissionRequest` | approval prompt の直前 | 承認待ち UI、attention | loop lifecycle ではない |
| `permission-denied` | `PermissionDenied` | auto mode classifier が tool を拒否 | policy/denial reaction、attention clear | Claude Code のみ |
| `user-prompt-submit` | `UserPromptSubmit` | 次ターン処理開始境界 | thinking state への遷移 | Enter 押下瞬間ではない。前ターン応答分だけ遅れる |
| `stop` | `Stop` | Claude 応答完了 | idle state への遷移、tool activity clear | user 操作の瞬間ではなくturn終了 |
| `stop-failure` | `StopFailure` | API error で turn 終了 | failure reaction、alert | Claude Code のみ |
| `notification` | `Notification` | Claude notification 発行時 | warning / notice への反応 | 現状の hook server mapping を確認して使う |
| `subagent-start` / `subagent-stop` | `SubagentStart` / `SubagentStop` | subagent 開始・終了 | delegated work の反応 | 完了品質は別 signal で判断 |
| `task-created` / `task-completed` | `TaskCreated` / `TaskCompleted` | task 作成・完了 marker | task/subtask reaction | loop completion とは限らない |
| `pre-compact` / `post-compact` | `PreCompact` / `PostCompact` | compaction 前後 | context 管理 reaction | UI 表示は通常不要 |
| `elicitation` / `elicitation-result` | `Elicitation` / `ElicitationResult` | MCP user input request 前後 | MCP 入力要求 reaction | Claude Code のみ |
| `session-end` | `SessionEnd` | session 終了 | cleanup reaction | Claude Code のみ |

`user-prompt-submit` の遅延については [`docs/decisions/hook-signals.md`](../decisions/hook-signals.md) を参照。

---

## Derived Events

| `event.kind` | Generated from | Payload | Typical use | Caution |
|---|---|---|---|---|
| `idle` | 最後の activity から一定時間経過 | `durationMs`, `timestamp` | idle fidget、長時間沈黙への反応 | threshold は runtime 設定に依存 |
| `tool-activity` | `pre-tool-use` / `stop` | `activity`, `timestamp` | attention aura、body state、ambient UI | tool 名からの heuristic を含む |

### Tool Activity

| `activity` | Meaning |
|---|---|
| `reading` | Read / Glob / Grep / Search 系 tool と推定 |
| `writing` | Write / Edit 系 tool と推定 |
| `running` | Bash / Exec / Run 系 tool と推定 |
| `none` | tool activity の終了または clear |

`tool-activity` は raw hook より扱いやすい粒度にした derived event。
正確な upstream lifecycle が必要な場合は `hook-signal` を直接見る。

---

## Synthetic Events

`synthetic` は runtime が観測した外部 event ではなく、persona / utility handler が `ctx.emitEvent(name, payload)` で announce した event。

| Field | Meaning |
|---|---|
| `source` | runtime が付与する `{ type, packId }` |
| `name` | event 名。`<packId>:<eventName>` 推奨 |
| `payload` | handler が観察した事実 |
| `timestamp` | `ctx.emitEvent()` 呼び出し時刻 |

Handler から直接 reaction を emit する API はない。
何かを観察した handler は synthetic event で事実を announce し、別の trigger がそれを match して reaction に変換する。

```ts
{
  id: "deploy:failed",
  match(event) {
    if (event.kind !== "synthetic") return null;
    if (event.name !== "deploy:failed") return null;
    return { reaction: "distressed", payload: event.payload };
  },
}
```

---

## Trigger Authoring Notes

- `Trigger.match()` は同じ event に対して同じ答えを返す決定的な関数にする。
- 確率的な揺らぎは match ではなく handler の weighted selection / cooldown に置く。
- Core に `hook -> reaction` の固定 mapping を追加しない。persona の個性が消える。
- `post-tool-failure` はすべて user-visible error とは限らない。Grep no-match などは除外を検討する。
- user の Enter 押下瞬間に反応したい場合、`user-prompt-submit` ではなく terminal runtime の submit/input event を使う。

---

## Related Files

| File | Role |
|---|---|
| [`src/sdk/reaction.d.ts`](../../src/sdk/reaction.d.ts) | `DispatchEvent`, `HookSignal`, `Trigger`, `ReactionType` の正本 |
| [`src/core/perception/perception.ts`](../../src/core/perception/perception.ts) | PTY / hook / input / idle を `DispatchEvent` に変換 |
| [`src/runtime/event-bus/event-bus.ts`](../../src/runtime/event-bus/event-bus.ts) | trigger matching と synthetic event dispatch |
| [`docs/decisions/trigger-reaction-architecture.md`](../decisions/trigger-reaction-architecture.md) | trigger / reaction system の設計 |
| [`docs/decisions/hook-signals.md`](../decisions/hook-signals.md) | Claude Code hook signal の発火タイミング |
