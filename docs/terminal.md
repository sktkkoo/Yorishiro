# Yorishiro Terminal

> Yorishiro の Terminal session（shell / coding agent）の設定と動作。実装上の正本は `src-tauri/src/pty.rs` および `src/runtime/user-pack-loader/config.ts`。

Yorishiro の Terminal は shell（zsh / bash / fish / pwsh）と coding agent（Claude Code / Codex / OpenCode）を session として走らせる。複数 session は tab として保持し、表示は active session だけに絞る。

> **現状（v0.0.1）**: §Session profile（shell / claude / codex bundled profile + `defaultProfile`）と §Shell integration（OSC 133 / 633 wrapper rc 注入 + `user.<shell>` chain + `init.<shell>` の emit）は実装済み（Phase B sub-1 / sub-2）。runtime は command 単位の status（command 開始 / 終了 / exit code）と command text / cwd metadata を保持する。公開 surface は command/status metadata に限定し、cwd は store only。`integration: false` profile での raw 起動も対応。pwsh integration は sub-2 では out of scope。

---

## Session profile

session の正体は profile で定義する。`~/.yorishiro/config.json` の `profiles[]` に書く。

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
| `id` | `string` | — | profile 識別子。session / tab を開く UI で選ぶ |
| `kind` | `"shell"` or `"agent"` | — | session の種別 |
| `command` | `string` | `kind=shell` のとき `$SHELL`、`agent` のとき `claude` or `codex` | spawn する binary |
| `args` | `string[]` | `[]` | command 引数 |
| `env` | `Record<string, string>` | `{}` | 追加 env |
| `cwd` | `string` | window の cwd | 起動 directory（`~` 展開可） |
| `agent` | `string` | — | `kind=agent` のとき必須（bundled は `claude` / `codex` / `opencode`） |
| `integration` | `boolean` | `true` | `false` で Yorishiro 側の instrumentation（OSC 133 / 633 / hook 注入）を skip（→ §統合を切る） |

未指定 / 不正 field は無視して default を使う。`profiles[]` 自体が壊れていても fatal error にはせず bundled fallback で起動する。

### Bundled profile

`profiles[]` を書かなくても、以下は常に使える：

- `shell` — `$SHELL` を起動、shell integration あり
- `claude` — Claude Code を起動、hook + `/yori:*` plugin 注入
- `codex` — Codex を起動、Yorishiro MCP config + `$yori-*` skill plugin + PTY 観察あり
- `opencode` — OpenCode を起動、Yorishiro MCP config + `/yori-*` command + TUI `system` theme + PTY 観察あり

User profile は同じ id を上書きできる。

---

## Session tabs

Yorishiro は session が 2 つ以上ある場合、active session の terminal だけを表示する。
非 active session の runtime / PTY / command metadata は維持され、tab 切り替えで再表示される。

- `Ctrl+Tab` / `Ctrl+Shift+Tab` / `Cmd+1` などの tab 操作で active session を切り替える。
- active session は keyboard focus / perception / tab indicator / layout / theme refresh の対象になる。
- tab indicator は session の状態を控えめに表示する。terminal 領域右上への独立した status badge は持たない。

UI pack が terminal を fullscreen / hidden / fixed position にする layout を出した場合も、対象は active terminal だけ。

---

## Terminal context selection

Terminal 上で `Option+Shift+drag` すると、ドラッグした矩形範囲の表示テキストを Yorishiro が
xterm.js buffer から抽出し、最新の「ユーザーが指し示した terminal context」として
保持する。これは PTY へ入力を書き込む操作ではなく、住人の perception / MCP 経路に
「ここを見て」という context を渡すための gesture。

AI は MCP tool `terminal_context_get` で最新の選択範囲を読める。未選択または空選択の
場合は `context: null` を返す。選択完了時には attention source
`terminal:user-selection` も短く発火する。

実装上は xterm.js の DOM ではなく Buffer API を読む。canvas / WebGL renderer でも
表示テキストは buffer に残るため、renderer には依存しない。

Command run が終わると、runtime は run の start marker / end marker と status metadata を
保持する。これは terminal 上に click target や badge を描画しない内部構造で、必要な経路だけが
同じ terminal context reference 形式（入力欄には固定形 `[#TermN]`）に変換できる。

MCP tool `terminal_runs_recent` は直近 command run の metadata だけを返す。command 文字列は
返すが、cwd と output text は返さない。user gesture 済みの reference がある run だけ
`referenceIds` を持ち、AI は必要な時だけ `terminal_context_get` でその reference
を解決できる。`referenceIds` は session-stamped な opaque id で、入力欄に挿入される
表示 marker（`[#TermN]`）とは別に session 越しの衝突を避ける。

失敗した run と遅い成功 run は workspace attention item になり、既存の attention aura と
Yori の最小表情反応にだけ接続される。普通の成功 run では反応しない。

---

## カスタマイズ

### 普段使ってる shell 設定（一切触らない）

User の `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish` / `$PROFILE` を Yorishiro は **一切編集しない**。Yorishiro が起動した shell でもそのまま読まれるので、oh-my-zsh / p10k / 自前 prompt / alias / env はすべてそのまま動く。User は Yorishiro の存在を意識しなくていい。

### Yorishiro 専用 tweak

「Yorishiro の中だけ別 prompt にしたい」「Yorishiro の中だけ alias を切り替えたい」用途には、`~/.yorishiro/shell/user.<shell>` を **user 自身が作る**。Yorishiro はこのファイルを作りもしないし上書きもしない。

```zsh
# ~/.yorishiro/shell/user.zsh の例
PROMPT="yorishiro %~ %# "
alias gco='git checkout'
export EDITOR=micro
unsetopt AUTO_CD

# OSC 133 hook を追加 / 上書きすることもできる（init.zsh の後で source されるため）
preexec_functions+=(my_extra_logger)
```

各 shell ごとに対応する file：

| shell | user 拡張点 |
|---|---|
| zsh | `~/.yorishiro/shell/user.zsh` |
| bash | `~/.yorishiro/shell/user.bash` |
| fish | `~/.yorishiro/shell/user.fish` |
| pwsh | `~/.yorishiro/shell/user.ps1` |

### Load 順

Yorishiro が shell を起動するときに以下の順で読まれる（zsh の例、他 shell も同様）：

```
1. user の ~/.zshrc                              ← 既存設定
2. ~/.yorishiro/shell/init.zsh                   ← Yorishiro 所有（OSC 133 / 633）
3. ~/.yorishiro/shell/user.zsh（あれば）         ← user 拡張
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

Yorishiro はこれを使って住人に session の状態を伝える。住人は「`cargo build` が 12 秒で成功した」「直前のコマンドが `rm -rf node_modules` だった」「2 分前から `npm test` がまだ走ってる」のような **machine-readable な状態** を読み取れるようになる。これがあるかないかで、住人が「さっきの test 落ちたね」と言えるか「なんか終わったかも」しか言えないかが分かれる。

OSC 633 の値は shell wrapper 側で byte escape する。制御文字、ESC、BEL、ST、`;`、`\`、
non-ASCII byte は `\xHH` に変換し、TS 側で decode する。Rust の `osc133.rs` は既存 activity
用途のまま維持し、command block 検出は front-end の xterm OSC handler が行う。

### Replay / live transport

WebView reload 後の attach では、Rust が replay bytes を `session_attach` / `pty_attach` の
invoke response (`{ attached, replay }`) でまとめて返す。live output は従来どおり raw
`Channel<ArrayBuffer>` で流す。これにより live の hot path は `InvokeResponseBody::Raw` のまま
で、front-end は replay 書き込み中の stale command block event を dispatch しない。

### どう挿入されるか

Yorishiro が shell を spawn する瞬間に、shell の init mechanism を経由して `~/.yorishiro/shell/init.<shell>` を読ませる。**user の rc は一切編集しない**。同意ダイアログも出ない（Yorishiro が起動した shell でしか effect が出ないため、terminal を開いた時点で implicit に consent している扱い。VSCode integrated terminal / Warp と同じ contract）。

| shell | 注入方法 |
|---|---|
| zsh | `ZDOTDIR` を Yorishiro の wrapper dir に向ける。wrapper の `.zshrc` が user の元 `.zshrc` → `init.zsh` → `user.zsh` を chain |
| bash | `bash --rcfile <wrapper>` で起動。wrapper が同じく chain |
| fish | `XDG_CONFIG_HOME` 経由、または `fish --init-command "source ..."` |
| pwsh | `pwsh -NoExit -File <wrapper>` |

結果：**Yorishiro が起動した shell でだけ OSC 133 / 633 が emit される**。Yorishiro を起動していない普通の terminal（iTerm 直起動など）には何の影響もない。

### Yorishiro 所有 file（編集不可）

`~/.yorishiro/shell/init.<shell>` は Yorishiro が所有する。`~/.yorishiro/` 初回作成時に生成され、Yorishiro 起動毎に **idempotent に上書き** される。

User がこれを編集しても次の Yorishiro 起動で上書きされる。理由：住人の status 読み取りは init.<shell> の emit 仕様に contract として依存していて、ここを user が変えると住人が状態を誤認する。

User がここを拡張 / 一部上書きしたい場合は **`user.<shell>` を使う**（init.<shell> の後で source されるため、hook 関数の追加も override も可能）。

---

## 統合を切る

「Yorishiro を terminal emulator として使うが、住人の介入は最小にしたい」場合、profile で `integration: false` を指定する：

```json
{
  "profiles": [
    { "id": "raw", "kind": "shell", "command": "$SHELL", "integration": false }
  ]
}
```

このとき：

- Wrapper rc を被せず、`$SHELL` を直接起動する
- `~/.yorishiro/shell/init.<shell>` も `user.<shell>` も読まれない
- Hook 注入もしない（`kind: agent` のときは hook 注入を skip）

住人は引き続き **PTY cell の観察** はする（terminal 上の表示を見ている状態は維持される）が、command 単位の status 遷移（終了 / exit code / cwd 変化など）は細かく追えなくなる。

---

## File 一覧

| Path | 所有 | 触られ方 |
|---|---|---|
| `~/.zshrc` / `~/.bashrc` / `~/.config/fish/config.fish` / `$PROFILE` | user | Yorishiro は一切触らない |
| `~/.yorishiro/config.json` | user | `profiles[]` などを定義。Yorishiro は read のみ |
| `~/.yorishiro/shell/init.<shell>` | Yorishiro | 起動毎に idempotent 上書き。user 編集は失われる |
| `~/.yorishiro/shell/user.<shell>` | user | Yorishiro は touch しない |
| `~/.yorishiro/shell/<wrapper-dir>/` | Yorishiro | shell init 注入用 wrapper。起動毎に再生成 |

---

## 関連 doc

- [`configuration.md`](configuration.md) — `~/.yorishiro/config.json` の他の field
- [`philosophy/PHILOSOPHY.ja.md`](philosophy/PHILOSOPHY.ja.md) — 「観察の境界」（住人は PTY を観察できるが書き込めない）
- [`decisions/explicit-over-implicit-ugc.md`](decisions/explicit-over-implicit-ugc.md) — explicit 設定を選ぶ判断
- [`decisions/bundled-pack-immutability.md`](decisions/bundled-pack-immutability.md) — Yorishiro 所有 / user 所有の境界
