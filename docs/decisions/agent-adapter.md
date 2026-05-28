# Terminal Agent Adapter

**Status**: active
**Last updated**: 2026-05-26

## TL;DR

Charminal が住まわせる外部 coding agent (Claude Code / Codex / OpenCode / 将来の追加) を **`TerminalAgent` trait + capability flag set** で抽象化する。`AgentKind { Claude, Codex }` enum は撤去し、各 agent は `src-tauri/src/sessions/agent_adapter/<agent>.rs` の adapter として独立する。

Capability flag (`persona_overlay` / `mcp_injection` / `plugins` / `lifecycle_hooks` / `session_resume`) は **意味論を均すためではなく、ある／ない を declare する** ためにある。Claude Code の hook を他 agent でも完全互換として emulate する方向は明示的に避ける（[codex-terminal-agent.md](codex-terminal-agent.md) の却下案を継承）。

第三の adapter として **OpenCode** を同時に足す。OpenCode は OSS で multi-provider (Anthropic / OpenAI / Google / Ollama 等) を受けるため、local LLM を Charminal に住まわせる経路を将来 OpenCode 経由で開く前提条件になる。

## 何を決めたか

### 1. Rust 側に `TerminalAgent` trait を導入する

```rust
// src-tauri/src/sessions/agent_adapter/mod.rs
pub trait TerminalAgent: Send + Sync {
    fn id(&self) -> &'static str;
    fn display_name(&self) -> &'static str;
    fn binary_name(&self) -> &'static str;
    fn capabilities(&self) -> AgentCapabilities;
    fn build_launch_args(&self, ctx: &LaunchContext) -> Result<LaunchArgs, String>;
    fn has_existing_session(&self, _cwd: Option<&Path>) -> bool { false }
}
```

各 adapter は `agent_adapter/claude.rs` / `codex.rs` / `opencode.rs` の sub-module に閉じる。`pty_session.rs` の `match agent { Claude => ..., Codex => ... }` は撤去し、`agent_adapter::lookup(&id)?.build_launch_args(&ctx)?` の **1 行 dispatch** にする。

### 2. Capability flag は「ある／ない」を declare する

```rust
pub struct AgentCapabilities {
    pub persona_overlay: bool,    // 起動時に persona prompt overlay を注入できるか
    pub mcp_injection: bool,      // 起動時に Charminal MCP server を注入できるか
    pub plugins: bool,            // Charminal command/skill entrypoint を bundle できるか
    pub lifecycle_hooks: bool,    // PreToolUse / PostToolUse / UserPromptSubmit 同等を emit するか
    pub session_resume: bool,     // 既存 session を cwd から検出して resume できるか
}
```

| Agent | persona_overlay | mcp_injection | plugins | lifecycle_hooks | session_resume |
|---|---|---|---|---|---|
| Claude Code | ✓ | ✓ | ✓ | ✓ | ✓ |
| Codex | ✓ | ✓ | ✓ | ✗ | ✓ |
| OpenCode | ✓ | ✓ | ✓ | ✗ | ✗ |

Capability flag は **意味論を揃えるためではない**。Codex / OpenCode が独自の lifecycle hook や plugin event を持つ場合でも、Charminal はそれを Claude Code hook の完全互換 contract とは扱わない。共通化する挙動は Claude hook を emulate するのではなく、agent ごとの注入経路として明示的に実装する。

特に Claude Code の全 hook（例: `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / tool blocking / tool rewrite / `additionalContext` 注入）は cross-agent contract ではない。Charminal reminder は Claude では hook settings 経由で毎ターン `additionalContext` として注入し、Codex / OpenCode では起動時の prompt overlay に同じ active reminder を追記する。これは hook parity ではなく、agent ごとの prompt 注入である。

### 3. Built-in only — user pack で adapter を足せない

agent adapter は Rust 本体で bake in する。`~/.charminal/agents/<id>.toml` のような user-declared adapter manifest は今回追加しない。

理由：

- adapter は **binary spawn + env + temp file 書き込み** を行う。security 境界として user code が触れる場所ではない（[critical-constraints.md](critical-constraints.md) §1 PTY observation のために必要な絶対信頼境界）
- bundled-packs の immutability stance と consistent ([feedback_bundled_pack_immutability](../../../../.claude/projects/-Users-user-Charminal/memory/feedback_bundled_pack_immutability.md))

将来 user-declared adapter を許す場合は別 decision を起こす。

### 4. `terminalAgent` config field の値域は string に widen する

```jsonc
// ~/.charminal/config.json
{
  "terminalAgent": "opencode"
}
```

`TerminalAgent` TS 型を `"claude" | "codex"` から `string` に widen する。

`config.ts` の parse は pure / async-free 境界なので、Tauri command の `list_supported_agents()` はここでは呼ばない。代わりに `KNOWN_AGENT_IDS` を Rust `agent_adapter::registered_agents()` の TS-side mirror として持ち、既知 id だけを config から受け付ける。未知 id は `"claude"` fallback（tolerant parsing は config.ts の既存原則）。

adapter を追加するときは、Rust registry、`KNOWN_AGENT_IDS`、bundled profiles を同時に更新する。Diagnostics / health check は `list_supported_agents()` を使って Rust registry の実値を表示するが、config parse の validation source ではない。

### 5. OpenCode v1 adapter の scope

OpenCode CLI は session-scoped CLI flag が薄い (`--prompt` は run-mode、`--mcp` 無し)。runtime config の inject 経路は **`OPENCODE_CONFIG_CONTENT` env var に inline JSON を渡す** こと。TUI theme は別 config なので、temp `tui.json` を `OPENCODE_TUI_CONFIG` で渡す。

v1 OpenCode adapter は：

- ✓ persona overlay (temp markdown を書き出して `agent.build.prompt` / `agent.plan.prompt` の `{file:...}` 参照に渡す)
- ✓ MCP injection (`mcp.charminal = { type: "remote", url: "..." }`)
- ✓ Charminal command plugin（`OPENCODE_CONFIG_CONTENT.command` で `/charm-*` を session-scoped に渡す）
- ✓ TUI theme bridge（temp `tui.json` + `OPENCODE_TUI_CONFIG` で `theme: "system"` を session-scoped に渡す）
- ✗ session resume（session storage path 未確認）
- ✗ Claude-Code-style lifecycle hooks（OpenCode plugin events は存在し得るが Claude hook 完全互換として扱わない）

OpenCode の TUI theme bridge は、起動時の temp config だけでなく scene 変更 / terminal attach 時の
`SIGUSR2` refresh signal も使う。これは PTY input ではなく、OpenCode TUI に terminal palette を
再サンプルさせる固定の process-control signal である。Charminal は prompt / command / key input を
signal payload に載せず、adapter の `theme_refresh()` が opt-in した agent にだけ送る。agent / persona /
user pack へ任意 signal API は公開しない（[critical-constraints §1](critical-constraints.md)）。

**known limitations**:

- `OPENCODE_CONFIG_CONTENT` は project-local `opencode.json` を **置換** するため、Charminal session 中は user の project-local 設定が無視される。v2 で deep-merge 対応する。
- `OPENCODE_TUI_CONFIG` は TUI config path を Charminal session 中だけ temp file に差し替える。user の OpenCode config file は書き換えないが、user TUI config との deep-merge はしない。
- Unicode rendering (CJK 全角 / 結合文字 / Cyrillic / icon glyph 等) の品質は OpenCode 本体の TUI 実装に依存する。Charminal の xterm.js は VS Code と同じ xterm.js core なので、xterm.js 系で報告された OpenCode 上流 issue (例: [#2920](https://github.com/sst/opencode/issues/2920) は v1.0 で fix 済、[#2013](https://github.com/sst/opencode/issues/2013) ほか) の状況に追従する。本件は Charminal 側で workaround しない (OpenCode 上流の責務)。最低 OpenCode v1.0 以降の利用を `docs/configuration.md` で推奨する。

## なぜそう決めたか

### 抽象化を先に入れる理由

Claude/Codex の 2 case しか無い状態で 3 つ目を足すと、refactor は **後付け** になり「claude+codex 形に固定化した adapter で 3 つ目を無理矢理 fit する」事故が起きやすい。`AgentKind { Claude, Codex }` enum + match 5 〜 10 箇所は典型的な「2 case までは enum、3 case 以上は trait」境界に既に来ている。

### opencode を 3 つ目に選んだ理由

- **multi-provider 設計**: Anthropic / OpenAI / Google / Ollama を持つので、**Charminal で local LLM を住まわせる経路** に直結する（aider 等の単機能 agent より総合度が高い）
- **形が Claude/Codex と十分違う**: session-scoped CLI flag が薄く、env var + file-based 設定が主経路。Claude+Codex 形に abstraction を固定化させない gravitational mass がある
- **OSS で観察可能**: Charminal の philosophy「観察するが干渉しない」に最も合う設計の agent

Gemini CLI も候補だったが、Claude Code に最も形が近いため abstraction stress test として弱い。aider は file-edit oriented で UX 軸が違いすぎ、Charminal の terminal-as-room metaphor との fit が未確認。

### Codex / OpenCode の hook 等価機能は今回扱わない理由

Codex / OpenCode にはそれぞれ独自の hook / plugin event surface があり得るが、Claude Code hook の全 event・全 payload・全 decision semantics と同一ではない。特に `additionalContext` の注入タイミング、tool blocking、tool rewrite、turn boundary は agent ごとに異なる。

これは **adapter abstraction とは独立の investment** で、混ぜると本件の scope が膨らみ過ぎる。capability flag で `lifecycle_hooks: false` を declare して、Codex / OpenCode 側で hook が必要な機能が Claude hook parity に依存しない設計にしておく。Charminal reminder は例外的に hook ではなく prompt overlay で渡す。将来 hook 相当を実装する場合も「Claude hook の互換実装」ではなく、`user_prompt_context` / `tool_lifecycle_events` / `tool_blocking` などの細かい per-agent capability として追加する。

## 検討したが却下した代替案

### A. `AgentKind` enum を拡張するだけ (Claude / Codex / OpenCode の 3 variant)

却下。3 case 以上は trait + dispatch が cleaner。enum 拡張は user-installable adapter を将来許す path を closed にしてしまう。

### B. User pack で agent adapter を定義可能にする

却下（少なくとも v1）。Adapter は binary spawn + env を扱う security 境界。bundled immutability stance と consistent に built-in only にする。需要が出たら別 decision を起こす。

### C. Hook 意味論を全 agent で揃える (Claude の hook を Codex / OpenCode で emulate)

却下（既に [codex-terminal-agent.md](codex-terminal-agent.md) で却下済の方針を継承）。Capability flag は意味論を揃えるためではなく declare するためにある。

### D. AgentDescriptor を Rust の trait ではなく TOML manifest + Lua script で declare

却下。Lua interpreter を持ち込む overhead に対して得るものが小さい。Rust trait は cargo test で型レベル検証ができ、性能も spawn overhead に紛れる範囲。

## この決定の implication / 制約

- **`terminalAgent: "opencode"` は v0.5 以降の config として valid**。v0.4 までの config は無効値で warn + claude fallback。
- **TS の `setTerminalAgent("claude" | "codex")` SDK API は string に widen される breaking change**。public SDK は Phase 0 で stabilize していないため許容するが、changelog に記載する。
- **opencode 起動時、user の project-local `opencode.json` は無視される** (v1 known limitation)。v2 で deep-merge 対応。document Both in `docs/configuration.md` と Settings UI の help text。
- **Claude Code hooks は cross-agent contract ではない**。Codex / OpenCode 限定の persona に `lifecycle_hooks` 依存の trigger を書くと sink される（adapter `capabilities().lifecycle_hooks == false` で declare 済）。Charminal reminder は Codex / OpenCode では prompt overlay に追記されるが、Claude の `UserPromptSubmit` hook と同じ毎ターン `additionalContext` ではない。
- PTY observation-only 制約は **全 adapter で不変** ([critical-constraints §1](critical-constraints.md))。adapter は CLI 引数 / env / temp config file の書き換えのみで、PTY write 経路は型レベルで存在しない。

## 関連 reference

- source: `src-tauri/src/sessions/agent_adapter/mod.rs` (新規)
- source: `src-tauri/src/sessions/pty_session.rs` (refactor: SpawnSpec::Agent dispatch を 1 行化)
- source: `src/runtime/sessions/profiles.ts` (bundled profile に opencode 追加)
- source: `src/runtime/user-pack-loader/config.ts` (`TerminalAgent` 型 widen)
- decision: [codex-terminal-agent.md](codex-terminal-agent.md) (前段の 2-agent decision)
- decision: [critical-constraints.md](critical-constraints.md) §1 PTY observation only
- philosophy: [INHABITED_CHARACTER_INTERFACE.ja.md「観察の境界」](../philosophy/INHABITED_CHARACTER_INTERFACE.ja.md)
- internal design-record (非公開): `specs/2026-05-26-terminal-agent-adapter.md`、`plans/2026-05-26-terminal-agent-adapter.md`、`handoffs/2026-05-26-terminal-agent-adapter-handoff.md`
- OpenCode docs: [opencode.ai/docs/cli](https://opencode.ai/docs/cli/), [opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers/), [opencode.ai/docs/rules](https://opencode.ai/docs/rules/)

## 改訂履歴

- 2026-05-26: 初版。`AgentKind` enum を撤去し `TerminalAgent` trait + capability flag に refactor、OpenCode adapter を同時投入。
