# Charminal Configuration

> `~/.charminal/config.json` の user-facing 設定。実装上の parse / serialize 正本は `src/runtime/user-pack-loader/config.ts`。

Charminal は起動時に `~/.charminal/config.json` を読み、壊れている field や未知 field は無視して bundled fallback で起動する。空ファイル・不正 JSON も fatal error にはしない。

## Example

```json
{
  "terminalAgent": "codex",
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
| `terminalAgent` | `"claude"` or `"codex"` | `"claude"` | Terminal で自動起動する coding agent |
| `primaryPersona` | `string` or `null` | `null` | active persona pack の user pick。`null` なら bundled fallback |
| `activeScene` | `string` or `null` | `null` | active scene pack の user pick。`null` なら bundled fallback |
| `activeUi` | `string` or `null` | `null` | active UI pack の user pick。`null` なら UI pack なし |
| `mcpPort` | `number` | `18743` | Rust MCP server の listen port |
| `disabledPacks` | `string[]` | `[]` | rescue 用。指定 id の user pack を load しない |

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
