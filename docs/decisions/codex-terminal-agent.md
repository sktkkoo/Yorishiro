# Codex Terminal Agent Support

**Status**: active
**Last updated**: 2026-07-11

## TL;DR

Yorishiro の Terminal は `~/.yorishiro/config.json` の `terminalAgent` で `claude` / `codex` を選べる。未指定は従来通り `claude`。

Persona の prompt overlay は Claude Code では `--append-system-prompt`、Codex では `-c developer_instructions=...` で渡す。Codex の base instructions は置換しない。Yorishiro MCP server は session-scoped config override で渡し、`$yori-*` は Codex の user skill discovery location に生成する。

## 何を決めたか

`terminalAgent` を user config の top-level field として追加した。

```json
{
  "terminalAgent": "codex"
}
```

Rust の PTY 層は `AgentKind` を受け取り、agent ごとに起動引数を分岐する。

- Claude Code: 既存 session があれば `-c`、hook settings、bundled plugin、MCP config、`--append-system-prompt`
- Codex: process cwd、Yorishiro MCP config、`~/.agents/skills/` の Yorishiro user skills、persona prompt があれば `-c developer_instructions="<prompt>"`

Hook server は現時点では Claude Code 専用。Codex でも Yorishiro MCP tools、`$yori-*` skills、PTY output / user input / idle の observation は動くが、Claude hook 由来の tool lifecycle event は入らない。

Codex の Yorishiro entrypoint は `/yori:*` slash command ではなく `$yori-*` skill。起動準備時に `~/.agents/skills/yori*/` へ user skill として生成する。コマンドファイルは Claude Code の YAML frontmatter 形式から Codex の `yori-*/SKILL.md` 形式に自動変換される。生成ディレクトリには管理 marker を置き、次回生成時は Yorishiro 管理分だけを置き換える。

plugin cache 直接配置 + `-c plugins."yori@yorishiro-local".enabled=true` 方式は、Codex 0.144.1 では marketplace catalog / install state が無いため plugin が発見されず、さらに正規 install では skill 名が `yori:yori-*` に namespace されて `$yori-*` 契約と一致しないため廃止した。user skill は namespace なしで `$yori` / `$yori-create` を公開できる。

## なぜそう決めたか

Codex CLI は system prompt 置換ではなく、既存の Codex agent loop と config を尊重するのが安全。OpenAI の Codex agent loop 解説では、`developer_instructions` は optional な developer message として model input に入る。一方 `model_instructions_file` は base instructions の置換なので、Yorishiro の persona overlay には強すぎる。

OpenClaw は OpenClaw-owned system prompt を組み立て、provider contribution を差し込む設計を持つ。Yorishiro は Claude Code / Codex という外部 agent をそのまま住まわせる方針なので、外部 agent の基底 prompt を所有しない。必要なのは prompt 全体の再構築ではなく、persona の additive overlay。

## 検討したが却下した代替案

### Codex の `model_instructions_file` を使う

却下。Codex の base instructions を置換してしまい、Codex CLI の期待する作業規律・sandbox・tool guidance を壊す可能性が高い。

### project `AGENTS.md` を書き換える

却下。Yorishiro が user repo に instruction file を自動生成・変更すると、worktree に不要な diff を作り、project owner の coding-agent policy と衝突する。

### Claude / Codex を同一の「hook 対応 agent」として抽象化する

却下。Codex CLI には Claude Code hooks と同型の lifecycle hook がない。表面上の agent abstraction に寄せると、実際に観測できる event の違いが隠れて future bug になる。

## この決定の implication / 制約

- `terminalAgent` の切り替えは次の Terminal session 起動時に反映する。既存 PTY session へ注入し直さない。
- Codex support の範囲は「自動起動 + persona prompt overlay + Yorishiro MCP + `$yori-*` skills + PTY observation」。Claude Code hook 由来の tool lifecycle event は対象外。
- Codex の Yorishiro MCP は `~/.codex/config.toml` を変更せず、起動時の `-c` config override で注入する。skills は `~/.agents/skills/` に生成するため、一度生成した後は Yorishiro 外の Codex からも見える。
- PTY observation-only 制約は変わらない。agent が Claude でも Codex でも、persona / amenity から PTY に書き込む API は追加しない。

## 関連 reference

- source: `src-tauri/src/pty.rs`
- decision: [agent-adapter.md](agent-adapter.md) — Codex を含む全 agent の adapter 抽象化 (2026-05-26 以降)
- source: `src/runtime/user-pack-loader/config.ts`
- source: `src/runtime/terminal-runtime/terminal-runtime.ts`
- philosophy: `docs/philosophy/PHILOSOPHY.ja.md「観察の境界」`
- OpenAI: [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/)
- OpenClaw: [System Prompt](https://docs.openclaw.ai/concepts/system-prompt)

## 改訂履歴

- 2026-07-11: Codex 0.144.1 の plugin discovery と namespace を実機確認し、`$yori-*` を `~/.agents/skills/` の user skills として生成する方式へ変更。旧 `yorishiro-local` plugin cache は生成時に削除する。
- 2026-05-26: TerminalAgent trait + capability flag への refactor を [agent-adapter.md](agent-adapter.md) で実施。本 doc は 2-agent 時代の決定として保持し、capability flag (`lifecycle_hooks: false`) の宣言根拠として参照される。
- 2026-05-28: Codex CLI は Yorishiro custom slash command を認識しないため、Codex entrypoint を `$yori-*` skills としてインストールする方針に修正。
- 2026-05-19: marketplace config override 方式を廃止し、Codex プラグインキャッシュ直接インストール + skill 形式変換（YAML frontmatter → `skills/yori-*/SKILL.md`）に切替。
- 2026-05-19: Codex 起動時に Yorishiro local marketplace plugin を session-scoped config として渡し、`$yori-*` skills を Codex でも使えるようにした。Claude Code hooks は引き続き Claude Code 専用。
- 2026-05-14: Codex 起動時に Yorishiro MCP server を session-scoped config として渡す方針を追記。
- 2026-04-22: 初版。Codex CLI 0.122.0 の `--cd` / `-c developer_instructions=...` に合わせた初期対応。
