# src-tauri/ — Rust IO layer overview

> このファイルは「**Rust 側のどこに何があるか**」を 1 画面で把握したい時に読む。対象：dev / AI。
> 上位 navigation は [docs/README.md](../docs/README.md)。

Charminal の **IO 境界層**。PTY / file system / hooks / MCP server。**設計判断は持たず、TypeScript 側 (`src/`) に委ねる**。Rust 側は OS との接続と資源 lifecycle のみ。

---

## Module map

```
src-tauri/src/
├── main.rs        — minimal entry, calls charminal_lib::run()
├── lib.rs         — Tauri app builder + #[tauri::command] 登録 + setup hook
├── pty.rs         — PTY lifecycle / RingBuffer / terminal agent launch / hook server (port 19001)
└── mcp/
    ├── mod.rs     — re-exports (4 lines)
    ├── server.rs  — MCP HTTP server (port 18743 default) / spawn / round-trip
    ├── tools.rs   — MCP tool 実装 (list_load_errors / list_packs / enable_pack / disable_pack / get_ui_state / set_ui_state)
    └── types.rs   — DTO 定義（TS と shared shape の document 役割）
```

合計 ~880 lines impl + ~260 lines test。

---

## 役割と責任分離

| Module | 責務 | TS 側との関係 |
|---|---|---|
| `pty.rs` | PTY spawn / I/O / resize / kill / replay (HMR 越し) / terminal agent launch / hook server | TS 側 perception primitive が PTY output を **read のみ** で受け取る。Claude / Codex の起動引数差分だけ Rust 側で吸収 |
| `mcp/server.rs` | MCP server の listen / round-trip dispatch | TS handler に request 投げて response を待つ async bridge |
| `mcp/tools.rs` | Rust-native (`list_load_errors`) と TS-delegated tools の宣言 | TS-delegated tool は実装が TS、Rust は schema 宣言と forwarding のみ |
| User layer commands (`lib.rs`) | `~/.charminal/` の watch / atomic write / pack scan / safe mode | TS が file 操作を呼び出すための typed API |
| SDK bundling (`lib.rs`) | `~/.charminal/sdk.d.ts` の startup 時生成 | user pack 開発時の IDE hint |
| Init script seeding (`lib.rs`) | `~/.charminal/init.js` を初回だけ template から生成、既存は touch しない | 起動時 hook / keyboard shortcut を書く user layer を barrier なく用意 |

---

## #[tauri::command] 一覧

PTY:
- `pty_spawn(agent, cols, rows, cwd?, system_prompt?, on_output)` / `pty_write(data)` / `pty_resize(cols, rows)` / `pty_kill()` / `pty_attach(cwd?, on_output) → bool` / `pty_detach()` / `poll_hook_signals() → Vec<String>`

User layer:
- `charminal_home_dir() → String` / `ensure_charminal_dirs()` / `list_user_packs() → Vec<UserPackEntry>`
- `read_charminal_file(path) → String` / `write_charminal_file_atomic(path, content)` / `stat_file_mtime(path) → u64`
- `is_safe_mode() → bool` / `read_last_startup_report() → String` / `user_init_script_path() → Option<String>`
- `watch_charminal_layer(on_event)` / `import_vrm(src) → String`

MCP:
- `mcp_tool_response(request_id, response)` — TS から MCP round-trip を解決

---

## Setup flow（lib.rs:run）

1. State 登録：`PtyState`、`WatcherState`
2. Hook server 起動：127.0.0.1:**19001**（Claude Code → Charminal の signal 受け）
3. MCP server spawn：`~/.charminal/config.json::mcpPort`、default **18743**（失敗しても crash せず stderr に log）
4. Plugins setup：opener、dialog
5. Tauri runloop へ

---

## 設計上守るもの

- **PTY は observation only**：`pty_write` は user typing に対応する write。**persona / harness から TS 側で `pty_write` を呼ばない** ([critical-constraints §1](../docs/decisions/critical-constraints.md))
- Terminal agent は `~/.charminal/config.json::terminalAgent` で `claude` / `codex` を選ぶ。設定 field は [docs/configuration.md](../docs/configuration.md)、設計判断は [docs/decisions/codex-terminal-agent.md](../docs/decisions/codex-terminal-agent.md)
- **MCP server failure ≠ Charminal crash**：MCP は rescue 用 tool 経路、本体には影響しない設計
- **File write は atomic**：tmp → rename pattern。partial write を user に見せない
- **Path scope check**：すべての `~/.charminal/` 操作は canonicalize + starts_with で escape を防ぐ

---

## Cargo dependencies（主要）

- `tauri` (2) + `tauri-plugin-opener` / `tauri-plugin-dialog` — desktop framework
- `portable-pty` (0.8) + `tokio` (1) — PTY と async runtime
- `rmcp` (1.5) + `axum` (0.8) + `schemars` (1) — MCP server
- `notify` (8.2) — `~/.charminal/` の filesystem watcher
- `serde` / `serde_json` / `uuid` — serialization と request id

---

## 自動生成 doc

```bash
npm run doc:rust   # cargo doc --no-deps --document-private-items
# 出力先: src-tauri/target/doc/charminal_lib/index.html
```

---

## 関連 doc

- 思想（IO 境界の哲学）：[docs/philosophy/INHABITED_CHARACTER_INTERFACE.md](../docs/philosophy/INHABITED_CHARACTER_INTERFACE.md)「観察の境界」
- 制約：[docs/decisions/critical-constraints.md](../docs/decisions/critical-constraints.md) §1 PTY observation only
- 内部設計記録（別 repo）：`../Charminal-design-record/2026-04-17-pty-connection-reference.md`、`2026-04-18-phase-1c-rescue-and-mcp.md`
