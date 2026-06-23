# Charminal Terminal

> Charminal の Terminal session（shell / coding agent）の設定と動作。実装上の正本は `src-tauri/src/pty.rs` および `src/runtime/user-pack-loader/config.ts`。

Charminal の Terminal は shell（zsh / bash / fish / pwsh）と coding agent（Claude Code / Codex / OpenCode）を session として走らせる。Pane を分割して複数 session を並べ、住人がそれら全体を観察できるようにすることを目指している。

> **現状（v0.0.1）**: §Session profile（shell / claude / codex bundled profile + `defaultProfile`）と §Shell integration（OSC 133 / 633 wrapper rc 注入 + `user.<shell>` chain + `init.<shell>` の emit）は実装済み（Phase B sub-1 / sub-2）。runtime は command 単位の status（command 開始 / 終了 / exit code）と command text / cwd metadata を保持する。公開 surface は command/status metadata に限定し、cwd は store only。固定 2-pane の paired workspace も実装済みで、default agent session と shell session を同時表示できる。`integration: false` profile での raw 起動も対応。pwsh integration は sub-2 では out of scope。

---

## Session profile

session の正体は profile で定義する。`~/.charminal/config.json` の `profiles[]` に書く。

```json
{
  "profiles": [
    { "id": "shell",     "kind": "shell", "command": "$SHELL" },
    { "id": "fish",      "kind": "shell", "command": "/opt/homebrew/bin/fish" },
    { "id": "nix-dev",   "kind": "shell", "command": "nix-shell", "args": ["--command", "zsh"], "cwd": "~/projects/foo" },
    { "id": "claude",    "kind": "agent", "agent": "claude" },
    { "id": "codex",     "kind": "agent", "agent": "codex" },
    { "id": "raw-shell", "kind": "shell", "command": "$SHELL", "integration": false }
  ]
}
```

### Profile fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `id` | `string` | — | profile 識別子。pane を開く UI で選ぶ |
| `kind` | `"shell"` or `"agent"` | — | session の種別 |
| `command` | `string` | `kind=shell` のとき `$SHELL`、`agent` のとき `claude` or `codex` | spawn する binary |
| `args` | `string[]` | `[]` | command 引数 |
| `env` | `Record<string, string>` | `{}` | 追加 env |
| `cwd` | `string` | window の cwd | 起動 directory（`~` 展開可） |
| `agent` | `string` | — | `kind=agent` のとき必須（bundled は `claude` / `codex` / `opencode`） |
| `integration` | `boolean` | `true` | `false` で Charminal 側の instrumentation（OSC 133 / 633 / hook 注入）を skip（→ §統合を切る） |

未指定 / 不正 field は無視して default を使う。`profiles[]` 自体が壊れていても fatal error にはせず bundled fallback で起動する。

### Bundled profile

`profiles[]` を書かなくても、以下は常に使える：

- `shell` — `$SHELL` を起動、shell integration あり
- `claude` — Claude Code を起動、hook + `/charm:*` plugin 注入
- `codex` — Codex を起動、Charminal MCP config + `$charm-*` skill plugin + PTY 観察あり
- `opencode` — OpenCode を起動、Charminal MCP config + `/charm-*` command + TUI `system` theme + PTY 観察あり

User profile は同じ id を上書きできる。

---

## Paired workspace

Charminal は session が 2 つ以上ある場合、固定 2-pane で terminal を同時表示する。

- 左 pane は default session（通常は coding agent）。
- 右 pane は active shell session。
- active が default session の場合は、右 pane に先頭の shell session を表示する。
- session が 1 つだけの場合は従来の single-terminal 表示に戻る。
- split 境界は 25-75% の範囲で drag / arrow key 調整できる。

`Ctrl+Tab` / `Ctrl+Shift+Tab` / `Cmd+1` などの tab 操作は active session を切り替える。active は keyboard focus / perception / tab indicator の対象で、visible は attach / layout / theme refresh の対象として別に扱われる。

UI pack が terminal を fullscreen / hidden / fixed position にする layout を出した場合、paired workspace は active terminal 1 枚に畳む。default layout では paired 表示を維持する。

---

## Terminal context selection

Terminal 上で `Option+Shift+drag` すると、ドラッグした矩形範囲の表示テキストを Charminal が
xterm.js buffer から抽出し、最新の「ユーザーが指し示した terminal context」として
保持する。これは PTY へ入力を書き込む操作ではなく、住人の perception / MCP 経路に
「ここを見て」という context を渡すための gesture。

AI は MCP tool `terminal_context_get` で最新の選択範囲を読める。未選択または空選択の
場合は `context: null` を返す。選択完了時には attention source
`terminal:user-selection` も短く発火する。

実装上は xterm.js の DOM ではなく Buffer API を読む。canvas / WebGL renderer でも
表示テキストは buffer に残るため、renderer には依存しない。

Command run が終わると、xterm buffer 内の終端行に小さな decoration badge（成功 / 失敗、
失敗時の exit code）が付く。badge を click すると、その run の start marker / end marker
から範囲を復元し、上と同じ terminal context reference を生成する。入力欄に入るのは
固定形 `[#TermN]` だけで、可変の output text は `terminal_context_get` の read 経路でのみ
解決される。

MCP tool `terminal_runs_recent` は直近 command run の metadata だけを返す。command 文字列は
返すが、cwd と output text は返さない。badge click など user gesture 済みの reference が
ある run だけ `referenceIds` を持ち、AI は必要な時だけ `terminal_context_get` でその reference
を解決できる。`referenceIds` は session-stamped な opaque id で、入力欄に挿入される
表示 marker（`[#TermN]`）とは別に session 越しの衝突を避ける。

失敗した run と遅い成功 run は workspace attention item になり、既存の attention aura と
CLAI の最小表情反応にだけ接続される。普通の成功 run では反応しない。

---

## カスタマイズ

### 普段使ってる shell 設定（一切触らない）

User の `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish` / `$PROFILE` を Charminal は **一切編集しない**。Charminal が起動した shell でもそのまま読まれるので、oh-my-zsh / p10k / 自前 prompt / alias / env はすべてそのまま動く。User は Charminal の存在を意識しなくていい。

### Charminal 専用 tweak

「Charminal の中だけ別 prompt にしたい」「Charminal の中だけ alias を切り替えたい」用途には、`~/.charminal/shell/user.<shell>` を **user 自身が作る**。Charminal はこのファイルを作りもしないし上書きもしない。

```zsh
# ~/.charminal/shell/user.zsh の例
PROMPT="charminal %~ %# "
alias gco='git checkout'
export EDITOR=micro
unsetopt AUTO_CD

# OSC 133 hook を追加 / 上書きすることもできる（init.zsh の後で source されるため）
preexec_functions+=(my_extra_logger)
```

各 shell ごとに対応する file：

| shell | user 拡張点 |
|---|---|
| zsh | `~/.charminal/shell/user.zsh` |
| bash | `~/.charminal/shell/user.bash` |
| fish | `~/.charminal/shell/user.fish` |
| pwsh | `~/.charminal/shell/user.ps1` |

### Load 順

Charminal が shell を起動するときに以下の順で読まれる（zsh の例、他 shell も同様）：

```
1. user の ~/.zshrc                              ← 既存設定
2. ~/.charminal/shell/init.zsh                   ← Charminal 所有（OSC 133 / 633）
3. ~/.charminal/shell/user.zsh（あれば）         ← user 拡張
```

`user.zsh` が一番最後に読まれるので、user は init.zsh で定義された hook を **追加も上書きも** できる。

---

## Shell integration（OSC 133 / 633）

### これは何か

Shell が「いま prompt を出した」「いま command を実行した」「いま終わった、exit code は N」を terminal に対して知らせる ANSI escape sequence の規約（OSC = Operating System Command）。VSCode integrated terminal / Warp / iTerm2 / kitty / WezTerm / Ghostty などはみんなこれを読んで、command 単位の navigation や status 表示を実現している。

command boundary の正本は OSC 133。定義は 4 種類：

| sequence | 意味 |
|---|---|
| `OSC 133 ; A ST` | これから prompt を描画する |
| `OSC 133 ; B ST` | prompt 描画完了、ここから user 入力 |
| `OSC 133 ; C ST` | user が Enter を押した、command 実行開始 |
| `OSC 133 ; D ; <exit_code> ST` | command 終了、exit code 付き |

command text / cwd metadata は VSCode 互換の OSC 633 extension で補助する：

| sequence | 意味 |
|---|---|
| `OSC 633 ; E ; <command> ST` | 次に実行される command text |
| `OSC 633 ; P ; Cwd=<path> ST` | 現在 cwd |

Charminal はこれを使って住人に session の状態を伝える。住人は「`cargo build` が 12 秒で成功した」「直前のコマンドが `rm -rf node_modules` だった」「2 分前から `npm test` がまだ走ってる」のような **machine-readable な状態** を読み取れるようになる。これがあるかないかで、住人が「さっきの test 落ちたね」と言えるか「なんか終わったかも」しか言えないかが分かれる。

OSC 633 の値は shell wrapper 側で byte escape する。制御文字、ESC、BEL、ST、`;`、`\`、
non-ASCII byte は `\xHH` に変換し、TS 側で decode する。Rust の `osc133.rs` は既存 activity
用途のまま維持し、command block 検出は front-end の xterm OSC handler が行う。

### Replay / live transport

WebView reload 後の attach では、Rust が replay bytes を `session_attach` / `pty_attach` の
invoke response (`{ attached, replay }`) でまとめて返す。live output は従来どおり raw
`Channel<ArrayBuffer>` で流す。これにより live の hot path は `InvokeResponseBody::Raw` のまま
で、front-end は replay 書き込み中の stale command block event を dispatch しない。

### どう挿入されるか

Charminal が shell を spawn する瞬間に、shell の init mechanism を経由して `~/.charminal/shell/init.<shell>` を読ませる。**user の rc は一切編集しない**。同意ダイアログも出ない（Charminal が起動した shell でしか effect が出ないため、terminal を開いた時点で implicit に consent している扱い。VSCode integrated terminal / Warp と同じ contract）。

| shell | 注入方法 |
|---|---|
| zsh | `ZDOTDIR` を Charminal の wrapper dir に向ける。wrapper の `.zshrc` が user の元 `.zshrc` → `init.zsh` → `user.zsh` を chain |
| bash | `bash --rcfile <wrapper>` で起動。wrapper が同じく chain |
| fish | `XDG_CONFIG_HOME` 経由、または `fish --init-command "source ..."` |
| pwsh | `pwsh -NoExit -File <wrapper>` |

結果：**Charminal が起動した shell でだけ OSC 133 / 633 が emit される**。Charminal を起動していない普通の terminal（iTerm 直起動など）には何の影響もない。

### Charminal 所有 file（編集不可）

`~/.charminal/shell/init.<shell>` は Charminal が所有する。`~/.charminal/` 初回作成時に生成され、Charminal 起動毎に **idempotent に上書き** される。

User がこれを編集しても次の Charminal 起動で上書きされる。理由：住人の status 読み取りは init.<shell> の emit 仕様に contract として依存していて、ここを user が変えると住人が状態を誤認する。

User がここを拡張 / 一部上書きしたい場合は **`user.<shell>` を使う**（init.<shell> の後で source されるため、hook 関数の追加も override も可能）。

---

## 統合を切る

「Charminal を terminal emulator として使うが、住人の介入は最小にしたい」場合、profile で `integration: false` を指定する：

```json
{
  "profiles": [
    { "id": "raw", "kind": "shell", "command": "$SHELL", "integration": false }
  ]
}
```

このとき：

- Wrapper rc を被せず、`$SHELL` を直接起動する
- `~/.charminal/shell/init.<shell>` も `user.<shell>` も読まれない
- Hook 注入もしない（`kind: agent` のときは hook 注入を skip）

住人は引き続き **PTY cell の観察** はする（terminal 上の表示を見ている状態は維持される）が、command 単位の status 遷移（終了 / exit code / cwd 変化など）は細かく追えなくなる。

---

## File 一覧

| Path | 所有 | 触られ方 |
|---|---|---|
| `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish` / `$PROFILE` | user | Charminal は一切触らない |
| `~/.charminal/config.json` | user | `profiles[]` などを定義。Charminal は read のみ |
| `~/.charminal/shell/init.<shell>` | Charminal | 起動毎に idempotent 上書き。user 編集は失われる |
| `~/.charminal/shell/user.<shell>` | user | Charminal は touch しない |
| `~/.charminal/shell/<wrapper-dir>/` | Charminal | shell init 注入用 wrapper。起動毎に再生成 |

---

## 関連 doc

- [`configuration.md`](configuration.md) — `~/.charminal/config.json` の他の field
- [`philosophy/PHILOSOPHY.ja.md`](philosophy/PHILOSOPHY.ja.md) — 「観察の境界」（住人は PTY を観察できるが書き込めない）
- [`decisions/explicit-over-implicit-ugc.md`](decisions/explicit-over-implicit-ugc.md) — explicit 設定を選ぶ判断
- [`decisions/bundled-pack-immutability.md`](decisions/bundled-pack-immutability.md) — Charminal 所有 / user 所有の境界
