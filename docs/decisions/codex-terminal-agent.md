# Codex Terminal Agent Support

**Status**: active
**Last updated**: 2026-04-22

## TL;DR

Charminal の Terminal は `~/.charminal/config.json` の `terminalAgent` で `claude` / `codex` を選べる。未指定は従来通り `claude`。

Persona の prompt overlay は Claude Code では `--append-system-prompt`、Codex では `-c developer_instructions=...` で渡す。Codex の base instructions は置換しない。

## 何を決めたか

`terminalAgent` を user config の top-level field として追加した。

```json
{
  "terminalAgent": "codex"
}
```

Rust の PTY 層は `AgentKind` を受け取り、agent ごとに起動引数を分岐する。

- Claude Code: 既存 session があれば `-c`、hook settings、bundled plugin、MCP config、`--append-system-prompt`
- Codex: `--cd <cwd>`、persona prompt があれば `-c developer_instructions="<prompt>"`

Hook server と `/charm` plugin は現時点では Claude Code 専用。Codex でも PTY output / user input / idle の observation は動くが、Claude hook 由来の tool lifecycle event は入らない。

## なぜそう決めたか

Codex CLI は system prompt 置換ではなく、既存の Codex agent loop と config を尊重するのが安全。OpenAI の Codex agent loop 解説では、`developer_instructions` は optional な developer message として model input に入る。一方 `model_instructions_file` は base instructions の置換なので、Charminal の persona overlay には強すぎる。

OpenClaw は OpenClaw-owned system prompt を組み立て、provider contribution を差し込む設計を持つ。Charminal は Claude Code / Codex という外部 agent をそのまま住まわせる方針なので、外部 agent の基底 prompt を所有しない。必要なのは prompt 全体の再構築ではなく、persona の additive overlay。

## 検討したが却下した代替案

### Codex の `model_instructions_file` を使う

却下。Codex の base instructions を置換してしまい、Codex CLI の期待する作業規律・sandbox・tool guidance を壊す可能性が高い。

### project `AGENTS.md` を書き換える

却下。Charminal が user repo に instruction file を自動生成・変更すると、worktree に不要な diff を作り、project owner の coding-agent policy と衝突する。

### Claude / Codex を同一の「hook 対応 agent」として抽象化する

却下。Codex CLI には Claude Code hooks と同型の lifecycle hook がない。表面上の agent abstraction に寄せると、実際に観測できる event の違いが隠れて future bug になる。

## この決定の implication / 制約

- `terminalAgent` の切り替えは次の Terminal session 起動時に反映する。既存 PTY session へ注入し直さない。
- Codex support の初期範囲は「自動起動 + persona prompt overlay + PTY observation」。`/charm` 相当の Codex MCP / slash command integration は別決定にする。
- PTY observation-only 制約は変わらない。agent が Claude でも Codex でも、persona / utility から PTY に書き込む API は追加しない。

## 関連 reference

- source: `src-tauri/src/pty.rs`
- source: `src/runtime/user-pack-loader/config.ts`
- source: `src/runtime/terminal-runtime/terminal-runtime.ts`
- philosophy: `docs/philosophy/INHABITED_CHARACTER_INTERFACE.md「観察の境界」`
- OpenAI: [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- OpenClaw: [System Prompt](https://docs.openclaw.ai/concepts/system-prompt)

## 改訂履歴

- 2026-04-22: 初版。Codex CLI 0.122.0 の `--cd` / `-c developer_instructions=...` に合わせた初期対応。
