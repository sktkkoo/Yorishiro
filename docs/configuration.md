# Charminal Configuration

> `~/.charminal/config.json` の user-facing 設定。実装上の parse / serialize 正本は `src/runtime/user-pack-loader/config.ts`。

Charminal は起動時に `~/.charminal/config.json` を読み、壊れている field や未知 field は無視して bundled fallback で起動する。空ファイル・不正 JSON も fatal error にはしない。

## Example

```json
{
  "terminalAgent": "codex",
  "language": "auto",
  "primaryPersona": "my-persona",
  "activeScene": "quiet-room",
  "activeUi": "minimal-badge",
  "mcpPort": 18743,
  "disabledPacks": ["broken-pack"]
}
```

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `defaultProfile` | `string` or `null` | `null` | 起動時 default-session に使う profile id（`shell` / `claude` / `codex` または user `profiles[]` の id）。`null` なら `terminalAgent` を fallback |
| `terminalAgent` | `"claude"` or `"codex"` | `"claude"` | legacy。`defaultProfile` 未指定時に使う coding agent |
| `language` | `"auto"`, `"en"`, or `"ja"` | `"auto"` | UI / bundled persona fallback / global system prompt / `/charm:*` command prompts の言語 |
| `profiles` | `SessionProfile[]` | `[]` | user 定義の session profile（→ [terminal.md](terminal.md)） |
| `primaryPersona` | `string` or `null` | `null` | active persona pack の user pick。`null` なら bundled fallback |
| `activeScene` | `string` or `null` | `null` | active scene pack の user pick。`null` なら bundled fallback |
| `activeUi` | `string` or `null` | `null` | active UI pack の user pick。`null` なら UI pack なし |
| `mcpPort` | `number` | `18743` | Rust MCP server の listen port |
| `disabledPacks` | `string[]` | `[]` | rescue 用。指定 id の user pack を load しない |

### Language

`language` controls the user-facing language surfaces:

- UI labels
- bundled persona fallback (`primaryPersona: null`)
- global system prompt natural-language guidance
- `/charm:*` command prompt bodies
- first-run / settings prefill text

```json
{
  "language": "auto"
}
```

`auto` detects the WebView locale at startup. Japanese locales resolve to `ja`; all other locales resolve to `en`. Explicit values (`"en"` / `"ja"`) always win over detection.

Identifiers are not localized: command ids (`/charm:create`), MCP tool names (`journal_write`), config keys (`primaryPersona`), pack ids, SDK API names, and paths remain English / ASCII.

If `primaryPersona` is set, the language fallback does not override it. If `primaryPersona` is `null`, Charminal chooses `clai-ja` for Japanese and `clai-en` otherwise.

Changing language from the settings screen updates UI labels and bundled persona fallback immediately when possible. Existing agent terminal sessions keep the system prompt and `/charm:*` command language they were started with; those surfaces are refreshed on the next agent terminal launch / app restart.

### Default profile（shell を起動する）

通常 shell を Charminal で起動するには `defaultProfile: "shell"` を指定する：

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

`~/.charminal/packs/` 以下の pack ファイルは hot reload に対応しており、保存するだけでアプリを再起動せずに反映される。

ただし `init.js` など初期化時に一度だけ読まれるファイルは hot reload の対象外。変更後は Ctrl+R（Reload）で明示的に再読み込みする。hot reload がうまく効かない場合も Ctrl+R で確実に反映できる。

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
| `claude` | `claude` | `--append-system-prompt` | Claude Code hooks、`/charm` plugin、Charminal MCP config を session-scoped に渡す |
| `codex` | `codex --cd <cwd>` | `-c developer_instructions=...` | 初期対応は PTY output / user input / idle の observation のみ |

`terminalAgent` を変更しても、既に走っている PTY session には注入し直さない。新しい Terminal session から反映される。

Design rationale は [decisions/codex-terminal-agent.md](decisions/codex-terminal-agent.md)。

Terminal session 全体の設計（profile / shell integration / カスタマイズ）は [terminal.md](terminal.md)。
