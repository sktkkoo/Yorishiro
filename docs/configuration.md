# Yorishiro Configuration

> `~/.yorishiro/config.json` の user-facing 設定。実装上の parse / serialize 正本は `src/runtime/user-pack-loader/config.ts`。

Yorishiro は起動時に `~/.yorishiro/config.json` を読み、壊れている field や未知 field は無視して bundled fallback で起動する。空ファイル・不正 JSON も fatal error にはしない。

同棲時間などの runtime state は `config.json` には置かない。`~/.yorishiro/cohabitation.json` は `total_hours` / `last_shutdown` / `per_persona` を保存する内部 state で、user-facing 設定でも rollback snapshot の対象でもない。

## Example

```json
{
  "terminalAgent": "codex",
  "language": "auto",
  "primaryPersona": "my-persona",
  "activeScene": "simple-room",
  "sceneByProject": {
    "/Users/me/work/project-a": "misty-grasslands"
  },
  "activeUi": "minimal-badge",
  "motionIntensity": 1.85,
  "mcpPort": 18743,
  "disabledPacks": ["broken-pack"]
}
```

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `defaultProfile` | `string` or `null` | `null` | 起動時 default-session に使う profile id（`shell` / `claude` / `codex` / `opencode` または user `profiles[]` の id）。`null` なら `terminalAgent` を fallback |
| `terminalAgent` | `"claude"`, `"codex"`, or `"opencode"` | `"claude"` | legacy。`defaultProfile` 未指定時に使う coding agent |
| `language` | `"auto"`, `"en"`, or `"ja"` | `"auto"` | UI / bundled persona fallback / global system prompt / Yorishiro command/skill prompts の言語 |
| `profiles` | `SessionProfile[]` | `[]` | user 定義の session profile（→ [terminal.md](terminal.md)） |
| `primaryPersona` | `string` or `null` | `null` | active persona pack の user pick。`null` なら bundled fallback |
| `activeScene` | `string` or `null` | `null` | global active scene fallback。current project に `sceneByProject` entry がない時の user pick。`null` なら bundled fallback |
| `sceneByProject` | `{ [projectRoot: string]: string }` | `{}` | 正規化された project root ごとの active scene override。現在の project root に entry があれば `activeScene` より優先 |
| `activeUi` | `string` or `null` | `null` | active UI pack の user pick。`null` なら UI pack なし |
| `motionIntensity` | `number` (`0.0`–`3.0`) | `1.0` | idle procedural motion（呼吸 / sway / head drift / posture）の振幅ノブ。`1.0` は従来どおり、`0` 付近はほぼ静止、上端は opt-in のオーバーアクション |
| `mcpPort` | `number` | `18743` | Rust MCP server の listen port |
| `disabledPacks` | `string[]` | `[]` | rescue 用。指定 id の user pack を load しない |
| `journalCallback` | `"normal"`, `"rare"`, or `"off"` | `"normal"` | journal callback（セッション開始時の記憶想起）の頻度ノブ。`rare` は日常の想起をせず節目と久しぶりの起動だけに絞り、`off` で無効化。Rust 側が config.json を直接読む |

### Journal callback

`journalCallback` は、agent session の開始時に住人の過去の journal（`~/.yorishiro/journal/`）から記憶を最大 1 件、会話の背景情報として届ける機能の頻度ノブ。発火は決定論的ルールで、優先順位は「ちょうど一年前 / ちょうどひと月前の記憶 > 数日ぶりの起動 > 最近の記憶（昨日〜数日前）」。届いた記憶に触れるかどうかは住人が判断する。`normal` でも発火はセッションあたり最大 1 回・1 日 1 回・同じ記憶は約 3 週間空く。journal を書かない日が続くと最近の記憶は自然に沈黙し、次に届くのは節目だけになる。`rare` は最近の記憶を想起せず、節目と久しぶりの起動だけに絞る。

### Scene selection

Scene selection is resolved in this order:

1. `sceneByProject[projectRoot]`
2. `activeScene`
3. bundled fallback

`projectRoot` は起動 cwd / フォルダ picker の選択先から解決される正規化 path。Git repository 配下では repository workdir、linked worktree では main worktree の root に折りたたまれる。Git repository ではない通常ディレクトリはそのディレクトリ自身が root になる。

Settings の Scene dropdown と MCP `scene.activate` は、current project root が解決できている場合は `sceneByProject` を更新する。project entry を cleared にすると、その場で `activeScene` に fallback する。project root が解決できない場合だけ `activeScene` を直接更新する。

```json
{
  "activeScene": "simple-room",
  "sceneByProject": {
    "/Users/me/work/project-a": "misty-grasslands"
  }
}
```

### Motion intensity

`motionIntensity` は Body built-in の idle procedural motion だけをスケールする。VRMA clip / persona reaction / lip-sync / startle・flinch などの生理反射はこの設定では変えない。

```json
{
  "motionIntensity": 1.85
}
```

設定画面の「Motion Intensity」スライダー、UI pack SDK の `ctx.app.setMotionIntensity(value)`、MCP tool の `motion_intensity_set` は同じ config field と runtime setter に到達する。`1.0` は default なので serialize 時に省略される。

### Language

`language` controls the user-facing language surfaces:

- UI labels
- bundled persona fallback (`primaryPersona: null`)
- global system prompt natural-language guidance
- Yorishiro command/skill prompt bodies（Claude Code は `/yori:*`、Codex は `$yori-*`、OpenCode は `/yori-*`）
- first-run / settings prefill text

```json
{
  "language": "auto"
}
```

`auto` detects the WebView locale at startup. Japanese locales resolve to `ja`; all other locales resolve to `en`. Explicit values (`"en"` / `"ja"`) always win over detection.

Identifiers are not localized: command ids (`/yori:create` / `$yori-create` / `/yori-create`), MCP tool names (`journal_write`), config keys (`primaryPersona`), pack ids, SDK API names, and paths remain English / ASCII.

If `primaryPersona` is set, the language fallback does not override it. If `primaryPersona` is `null`, Yorishiro chooses `clai-ja` for Japanese and `clai-en` otherwise.

Changing language from the settings screen updates UI labels and bundled persona fallback immediately when possible. Existing agent terminal sessions keep the system prompt and Yorishiro command/skill language they were started with; those surfaces are refreshed on the next agent terminal launch / app restart.

### Default profile（shell を起動する）

通常 shell を Yorishiro で起動するには `defaultProfile: "shell"` を指定する：

```json
{
  "defaultProfile": "shell"
}
```

`shell` は bundled profile で、`$SHELL`（unset なら `/bin/sh`）を起動する。Phase B sub-1 では plain spawn のみで OSC 133 / wrapper rc は無し。Phase B sub-2 で wrapper rc 経由の OSC 133 emission を追加する（→ [terminal.md](terminal.md)）。

`profiles[]` で user 定義 profile を追加すれば、それも `defaultProfile` から指せる：

```json
{
  "defaultProfile": "fish-dev",
  "profiles": [
    { "id": "fish-dev", "kind": "shell", "command": "/opt/homebrew/bin/fish", "cwd": "~/dev" }
  ]
}
```

## Pack の hot reload

`~/.yorishiro/packs/` 以下の pack ファイルは hot reload に対応しており、保存するだけでアプリを再起動せずに反映される。

`init.js` も hot reload に対応する。保存すると Yorishiro が自動で再実行し、`ctx.registerShortcut` で登録したショートカットは再読込のたびに解除＆再登録される（アプリ再起動も Ctrl+R も不要）。保存内容に構文 / 実行エラーがある場合は、直前の動いていた `init.js` を保持したまま window title に `— init.js reload failed` を表示してエラーを log に残す。修正して保存し直せば自動で再試行される。手書きの `window.addEventListener` / timer を使う場合は `ctx.onDispose` で後始末を登録すると、再読込での二重化を防げる。

## Terminal Agent

`terminalAgent` は Terminal に住む coding agent を選ぶ。

```json
{
  "terminalAgent": "codex"
}
```

未指定、空文字、不明な値はすべて `"claude"` として扱う。

Agent ごとの違い：

| Agent | 起動 | Prompt overlay | Hook / command support |
|---|---|---|---|
| `claude` | `claude` | `--append-system-prompt` | Claude Code hooks、`/yori:*` plugin、Yorishiro MCP config を session-scoped に渡す |
| `codex` | `codex` | `-c developer_instructions=...` | Yorishiro MCP config と `$yori-*` skill plugin を session-scoped に渡す。Yorishiro reminder は prompt overlay に追記する。Claude hooks は非対応 |
| `opencode` | `opencode` | temp markdown file を `agent.build.prompt` / `agent.plan.prompt` の `{file:...}` 参照で渡す | Yorishiro MCP config と `/yori-*` command を `OPENCODE_CONFIG_CONTENT` で渡す。TUI theme は temp `tui.json` + `OPENCODE_TUI_CONFIG` で `system` にする。Yorishiro reminder は agent prompt に追記する。Claude hooks / session resume は非対応 |

Claude Code hooks は cross-agent contract ではない。Codex / OpenCode が独自の
lifecycle hook や plugin event を持つ場合でも、Yorishiro は Claude Code hooks
と完全互換であるとは扱わない。共通化する挙動は Claude hook の emulate ではなく、
agent ごとの capability として明示的に実装する。hook-based reminder
（`UserPromptSubmit` で毎ターン `additionalContext` を返す仕組み）は Claude Code 専用。
Codex / OpenCode には同じ reminder hook は動かないが、起動時の prompt overlay に
active reminder（journal / voice）を追記する。設定変更は既存 PTY session には反映せず、
新しい Terminal session から反映される。

`terminalAgent` を変更しても、既に走っている PTY session には注入し直さない。新しい Terminal session から反映される。

`defaultProfile` が agent profile（`claude` / `codex` / `opencode` や user `profiles[]` の agent profile）を指している場合は、起動 agent はそちらが優先される。このとき Settings の Agent dropdown は実際に起動する agent を表示したうえで操作不可になり、「起動 agent は defaultProfile で固定中」と注記する。agent を切り替えるには `defaultProfile` を編集する（dropdown は `terminalAgent` のみを書き換えるため、固定中は効かない）。

#### `opencode` の known limitation

OpenCode は v1.0 以降を推奨する。Yorishiro v0.5 の OpenCode adapter は
`OPENCODE_CONFIG_CONTENT` env var に inline JSON を渡して、Yorishiro MCP server
と `/yori-*` command を session-scoped に注入する。persona overlay は temp
markdown file を `agent.build.prompt` / `agent.plan.prompt` の `{file:...}` 参照で渡す。
この方式は project-local
`opencode.json` を session 中だけ置換するため、user の project-local OpenCode
設定は無視される。project-local 設定との deep-merge は v0.6 以降の scope。

OpenCode TUI の color theme は temp `tui.json` に `{ "theme": "system" }` を書き、
`OPENCODE_TUI_CONFIG` でその path を渡す。さらに scene 切替時は OpenCode が提供する
`SIGUSR2` refresh hook を active OpenCode process に送り、panel / input 色を terminal
palette から再サンプルさせる。Yorishiro は user の
`~/.config/opencode/tui.json` や project-local TUI config を書き換えない。ただし
OpenCode から見る TUI config path は Yorishiro session 中だけ temp file に差し替わるため、
user の OpenCode TUI config との deep-merge はしない。

OpenCode の Unicode rendering（CJK 全角、結合文字、Cyrillic、icon glyph 等）は
OpenCode 本体の TUI 実装に依存する。Yorishiro は xterm.js 上で OpenCode を
起動するだけで、OpenCode 上流の rendering issue を Yorishiro 側で workaround
しない。

Design rationale は [decisions/agent-adapter.md](decisions/agent-adapter.md) と [decisions/codex-terminal-agent.md](decisions/codex-terminal-agent.md)。

Terminal session 全体の設計（profile / shell integration / カスタマイズ）は [terminal.md](terminal.md)。
