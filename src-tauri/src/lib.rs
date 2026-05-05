mod journal;
mod mcp;
mod pty;
mod sessions;

use pty::{start_hook_server, AgentKind, PtyState};
use sessions::SessionRegistry;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

/// Cohabitation hours tracking の開始時刻を保持する managed state。
/// `Option` は終了時に `take()` して二重 save を防ぐため。
struct CohabitationStart(std::sync::Mutex<Option<std::time::Instant>>);

fn find_agent_binary(agent: AgentKind) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let binary_name = match agent {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
    };
    let candidates = [
        format!("{}/.local/bin/{}", home, binary_name),
        format!("{}/.cargo/bin/{}", home, binary_name),
        format!("/usr/local/bin/{}", binary_name),
        format!("/opt/homebrew/bin/{}", binary_name),
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }
    binary_name.to_string()
}

fn build_path_env() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let current = std::env::var("PATH").unwrap_or_default();
    format!(
        "{}/.local/bin:{}/.cargo/bin:/usr/local/bin:/opt/homebrew/bin:{}",
        home, home, current
    )
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    agent: AgentKind,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    system_prompt: Option<String>,
    on_output: Channel,
) -> Result<(), String> {
    let agent_bin = find_agent_binary(agent);
    let plugin_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p.join("resources").join("charminal-plugin"));
    state.spawn(
        app,
        cols,
        rows,
        cwd,
        agent,
        &agent_bin,
        system_prompt,
        plugin_dir,
        on_output,
    )
}

/// `~/.charminal/journal/memories.md` の全文を返す。ファイルがなければ空文字列。
#[tauri::command]
fn read_journal_memories() -> Result<String, String> {
    journal::read_memories()
}

#[tauri::command]
fn check_tutorial_done() -> bool {
    match charminal_home_path() {
        Ok(dir) => check_tutorial_done_impl(&dir),
        Err(_) => false,
    }
}

#[tauri::command]
fn mark_tutorial_done() -> Result<(), String> {
    let dir = charminal_home_path()?;
    mark_tutorial_done_impl(&dir)
}

#[tauri::command]
async fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    state.write_data(&data)
}

#[tauri::command]
async fn pty_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(cols, rows)
}

#[tauri::command]
async fn pty_kill(state: State<'_, PtyState>) -> Result<(), String> {
    state.kill()
}

/// Reconnect a new Channel to an existing PTY session (WebView HMR reload).
/// Returns true if the PTY was alive and attached; false means caller should spawn instead.
#[tauri::command]
async fn pty_attach(
    state: State<'_, PtyState>,
    cwd: Option<String>,
    on_output: Channel,
) -> Result<bool, String> {
    Ok(state.attach(cwd, on_output))
}

/// Disconnect the output channel without killing the PTY (WebView HMR cleanup).
#[tauri::command]
async fn pty_detach(state: State<'_, PtyState>) -> Result<(), String> {
    state.detach();
    Ok(())
}

/// Drain queued hook signals (polling fallback for when Tauri emit doesn't reach webview).
#[tauri::command]
async fn poll_hook_signals() -> Vec<String> {
    pty::drain_hook_signals()
}

// ─── Charminal home dir (~/.charminal/) ─────────────────────────────
//
// User が自分で pack を置く場所。Phase 1-a では以下の convention：
//
//   ~/.charminal/
//   ├── init.js                         # 起動時 entry (~= init.el)
//   ├── packs/
//   │   └── <pack-id>/<kind>.js         # kind ∈ {effect, persona, voice, body, scene, ui}
//   │       <pack-id>/ui.tsx            # Plan 4 MVP: user UI pack source
//   ├── config.json                     # 将来の宣言的設定
//   └── sdk.d.ts                        # Charminal が ship する IDE 用 type hint
//
// Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
// Internal design-record: 2026-04-18-user-layer-runtime.md

const PACK_KINDS: &[&str] = &["effect", "persona", "voice", "body", "scene", "ui"];

fn charminal_home_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    Ok(std::path::PathBuf::from(home).join(".charminal"))
}

/// `.tutorial-done` フラグの有無を返す。テスト用に charminal_dir を引数化。
fn check_tutorial_done_impl(charminal_dir: &Path) -> bool {
    charminal_dir.join(".tutorial-done").exists()
}

/// `.tutorial-done` フラグを作成する。テスト用に charminal_dir を引数化。
fn mark_tutorial_done_impl(charminal_dir: &Path) -> Result<(), String> {
    let path = charminal_dir.join(".tutorial-done");
    if path.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(charminal_dir).map_err(|e| format!("~/.charminal/ 作成失敗: {}", e))?;
    std::fs::write(&path, "").map_err(|e| format!(".tutorial-done 作成失敗: {}", e))?;
    Ok(())
}

/// user pack の entry を記述する。TS 側 loader に JSON で渡す。
#[derive(serde::Serialize)]
struct UserPackEntry {
    id: String,
    kind: String,
    #[serde(rename = "entryPath")]
    entry_path: String,
}

/// Absolute path to ~/.charminal/. Does not create it.
#[tauri::command]
async fn charminal_home_dir() -> Result<String, String> {
    Ok(charminal_home_path()?.to_string_lossy().to_string())
}

/// SDK `.d.ts` ファイル一式。compile 時に bundle に含める。
///
/// Phase 1-a では ensure_charminal_dirs() のたびに ~/.charminal/sdk.d.ts を
/// 上書きする（user は編集しない前提）。ファイル間の `import type { ... }
/// from "./..."` と `export * from "./..."` は single-file bundle では解決
/// できないので emit 時に drop する。
const SDK_DTS_PARTS: &[(&str, &str)] = &[
    ("reaction.d.ts", include_str!("../../src/sdk/reaction.d.ts")),
    ("context.d.ts", include_str!("../../src/sdk/context.d.ts")),
    ("persona.d.ts", include_str!("../../src/sdk/persona.d.ts")),
    ("utility.d.ts", include_str!("../../src/sdk/utility.d.ts")),
    ("effect.d.ts", include_str!("../../src/sdk/effect.d.ts")),
    ("scene.d.ts", include_str!("../../src/sdk/scene.d.ts")),
    (
        "scene-pack.d.ts",
        include_str!("../../src/sdk/scene-pack.d.ts"),
    ),
    ("ui-pack.d.ts", include_str!("../../src/sdk/ui-pack.d.ts")),
    ("index.d.ts", include_str!("../../src/sdk/index.d.ts")),
];

/// Detect `import ... from "./..."` and `export ... from "./..."` lines.
/// Relative cross-file module references become unresolvable once all parts
/// are flattened into a single d.ts, so they get stripped.
fn is_cross_file_module_line(line: &str) -> bool {
    let trimmed = line.trim_start();
    if !(trimmed.starts_with("import") || trimmed.starts_with("export")) {
        return false;
    }
    trimmed.contains("from \"./") || trimmed.contains("from './")
}

fn build_bundled_sdk_dts() -> String {
    let mut out = String::from(
        "/**\n\
         * Charminal SDK type hints — auto-bundled from src/sdk/*.d.ts at build time.\n\
         *\n\
         * Charminal overwrites this file on every startup; do not edit it directly.\n\
         * Pack sources can reference these types for IDE hints even when written in\n\
         * plain JavaScript (via JSDoc `@typedef` / `@type` annotations).\n\
         */\n\n",
    );
    for (name, src) in SDK_DTS_PARTS {
        out.push_str(&format!("// ---- {} ----\n\n", name));
        for line in src.lines() {
            if is_cross_file_module_line(line) {
                continue;
            }
            out.push_str(line);
            out.push('\n');
        }
        out.push('\n');
    }
    out
}

/// ~/.charminal/init.js が無いときに seed する雛形。
///
/// sdk.d.ts とは違い、init.js は user の編集対象なので「**存在しないとき
/// だけ** 書く」。user が編集した内容を Charminal が上書きすることは無い。
/// 詳細: docs/decisions/user-init-script-seed.md
const USER_INIT_TEMPLATE: &str = include_str!("../resources/user-init-template.js");

/// `~/.charminal/init.js` が無ければ template を write する。既存 file には
/// 絶対触れない（user が消したものを復活させず、編集も保護する）。test が
/// env var を触らずに済むよう home を引数化している。
fn seed_user_init_script_impl(home: &std::path::Path) -> Result<(), String> {
    let path = home.join("init.js");
    if path.exists() {
        return Ok(());
    }
    std::fs::write(&path, USER_INIT_TEMPLATE)
        .map_err(|e| format!("Failed to seed ~/.charminal/init.js: {}", e))
}

/// Create ~/.charminal/ + ~/.charminal/packs/ and refresh sdk.d.ts. Idempotent.
///
/// sdk.d.ts は user の IDE が「Charminal SDK の shape」を知るためのヒント
/// ファイル。毎起動で overwrite する（user は編集対象ではない）。
/// init.js は逆に、無ければ雛形を seed するが存在すれば触らない。
#[tauri::command]
async fn ensure_charminal_dirs() -> Result<(), String> {
    let home = charminal_home_path()?;
    std::fs::create_dir_all(home.join("packs"))
        .map_err(|e| format!("Failed to create ~/.charminal/packs: {}", e))?;
    std::fs::write(home.join("sdk.d.ts"), build_bundled_sdk_dts())
        .map_err(|e| format!("Failed to write ~/.charminal/sdk.d.ts: {}", e))?;
    seed_user_init_script_impl(&home)?;
    Ok(())
}

/// Scan ~/.charminal/packs/ and return discovered packs.
///
/// Convention: ~/.charminal/packs/<id>/<kind>.js where kind is one of PACK_KINDS.
/// UI packs also support ~/.charminal/packs/<id>/ui.tsx in Plan 4 MVP.
/// Multiple kind files in one pack directory produce multiple entries.
/// Missing directory returns empty vec (not an error).
#[tauri::command]
async fn list_user_packs() -> Result<Vec<UserPackEntry>, String> {
    let packs_dir = charminal_home_path()?.join("packs");
    discover_user_pack_entries(&packs_dir)
}

fn entry_file_for_kind(pack_dir: &Path, kind: &str) -> Option<PathBuf> {
    let js_entry = pack_dir.join(format!("{}.js", kind));
    if js_entry.is_file() {
        return Some(js_entry);
    }
    if kind == "ui" {
        let tsx_entry = pack_dir.join("ui.tsx");
        if tsx_entry.is_file() {
            return Some(tsx_entry);
        }
    }
    None
}

fn discover_user_pack_entries(packs_dir: &Path) -> Result<Vec<UserPackEntry>, String> {
    if !packs_dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let read =
        std::fs::read_dir(packs_dir).map_err(|e| format!("Failed to read packs dir: {}", e))?;
    for pack_dir_entry in read.flatten() {
        let pack_dir = pack_dir_entry.path();
        if !pack_dir.is_dir() {
            continue;
        }
        let id = pack_dir_entry.file_name().to_string_lossy().to_string();
        if id.starts_with('.') {
            continue;
        }
        for kind in PACK_KINDS {
            if let Some(entry_file) = entry_file_for_kind(&pack_dir, kind) {
                entries.push(UserPackEntry {
                    id: id.clone(),
                    kind: (*kind).to_string(),
                    entry_path: entry_file.to_string_lossy().to_string(),
                });
            }
        }
    }
    Ok(entries)
}

/// Read a text file from inside ~/.charminal/. Rejects paths outside the scope.
#[tauri::command]
async fn read_charminal_file(relative_path: String) -> Result<String, String> {
    let home = charminal_home_path()?;
    let full = home.join(&relative_path);
    let canonical_home = home
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize home: {}", e))?;
    let canonical_full = full
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;
    if !canonical_full.starts_with(&canonical_home) {
        return Err("Path escapes ~/.charminal/".into());
    }
    std::fs::read_to_string(&canonical_full).map_err(|e| format!("Read failed: {}", e))
}

// ─── Phase 1-c: safe-mode / atomic write / load-report ─────────────
//
// user pack layer の rescue 経路。design-record 2026-04-18-phase-1c-rescue-and-mcp.md
// Section 4.1 / 4.2 / 4.3 を参照。

/// env var の値（`Option<&str>`）から safe-mode bool を判定する pure helper。
/// test で env を直接触らないよう引数化する。
fn is_safe_mode_value(value: Option<&str>) -> bool {
    value == Some("1")
}

/// CHARMINAL_SAFE_MODE env var を読み、`'1'` のときのみ true を返す。
/// TS 側 runtime-wire が起動時に invoke する。
#[tauri::command]
async fn is_safe_mode() -> Result<bool, String> {
    let raw = std::env::var("CHARMINAL_SAFE_MODE").ok();
    Ok(is_safe_mode_value(raw.as_deref()))
}

/// `~/.charminal/<relative>` に atomic に text を書き出す実装本体。
/// テスト用に home を引数化する。
fn write_charminal_file_atomic_impl(
    relative_path: &str,
    content: &str,
    home_root: &Path,
) -> Result<(), String> {
    let charminal = home_root.join(".charminal");
    std::fs::create_dir_all(&charminal)
        .map_err(|e| format!("Failed to ensure ~/.charminal: {}", e))?;

    let target = charminal.join(relative_path);

    // path traversal 対策：target の親が canonical な charminal の中にあることを確認。
    // target 自体はまだ存在しない可能性があるので、親 dir を canonicalize する。
    let parent = target
        .parent()
        .ok_or_else(|| "target has no parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("Failed to ensure parent: {}", e))?;
    let canonical_parent = parent
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize parent: {}", e))?;
    let canonical_charminal = charminal
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize home: {}", e))?;
    if !canonical_parent.starts_with(&canonical_charminal) {
        return Err("Path escapes ~/.charminal/".into());
    }

    // .tmp に書いて rename で atomic に差し替える。同一 filesystem 内なので
    // rename は POSIX / APFS で atomic。
    let tmp = target.with_extension(format!(
        "{}.tmp",
        target.extension().and_then(|s| s.to_str()).unwrap_or("tmp")
    ));
    std::fs::write(&tmp, content).map_err(|e| format!("Failed to write tmp: {}", e))?;
    std::fs::rename(&tmp, &target).map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(())
}

/// ~/.charminal/<relative> に atomic に text を書く。
/// TS 側から config.json / last-startup.json の write に使う。
#[tauri::command]
async fn write_charminal_file_atomic(relative_path: String, content: String) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    write_charminal_file_atomic_impl(&relative_path, &content, Path::new(&home))
}

/// `~/.charminal/last-startup.json` を読む実装本体。テスト用に home 引数化。
/// MCP `list_load_errors` tool から crate 内参照するため pub(crate)。
pub(crate) fn read_last_startup_report_impl(home_root: &Path) -> Result<String, String> {
    let path = home_root.join(".charminal").join("last-startup.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Read failed: {}", e))
}

/// `~/.charminal/last-startup.json` を読む。不在 → 空文字列。
/// MCP `list_load_errors` と TS 側 debug から使う。
#[tauri::command]
async fn read_last_startup_report() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    read_last_startup_report_impl(Path::new(&home))
}

/// `~/.charminal/init.js` があればパスを返す、なければ None。
/// 起動時に user's init.el 相当として load する対象。
#[tauri::command]
async fn user_init_script_path() -> Result<Option<String>, String> {
    let init_path = charminal_home_path()?.join("init.js");
    if init_path.is_file() {
        Ok(Some(init_path.to_string_lossy().to_string()))
    } else {
        Ok(None)
    }
}

/// MCP server が emit した `mcp:tool-request` を TS 側 handler が処理した
/// 結果を受け取る。rmcp の tool handler が await していた oneshot channel に
/// 値を流して round-trip を完結させる。
///
/// Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.5
#[tauri::command]
async fn mcp_tool_response(request_id: String, response: serde_json::Value) -> Result<(), String> {
    mcp::server::resolve_pending_response(&request_id, response)
}

// ─── User layer file watcher (Phase 1-b) ────────────────────────────
//
// `~/.charminal/**` を recursive に監視し、debounced event を TS 層の Channel
// に流す。TS 側は event を受けて対応 pack を cache-bust + re-import + registry
// 経由で replace する。hot reload の主動脈。
//
// Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
// Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-b: File watcher + hot reload」

/// TS 層に送る 1 event。`mtimeMs` は receiver が import URL の `?v=` に混ぜる
/// cache-bust key になる（removed の場合は 0）。
#[derive(Clone, serde::Serialize)]
struct CharminalLayerEvent {
    path: String,
    kind: String,
    #[serde(rename = "mtimeMs")]
    mtime_ms: u64,
}

/// File 1 枚の pending event（最後に届いた kind が勝つ）。
type PendingMap = Arc<Mutex<HashMap<PathBuf, notify::EventKind>>>;

struct WatcherHandle {
    /// Drop 時に OS watcher を畳む。
    _watcher: notify::RecommendedWatcher,
    /// Debouncer thread に停止を伝える。
    stop_tx: std::sync::mpsc::Sender<()>,
    /// Debouncer thread。`take()` 時に join してクリーンに畳む。
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Drop for WatcherHandle {
    fn drop(&mut self) {
        let _ = self.stop_tx.send(());
        if let Some(handle) = self.thread.take() {
            let _ = handle.join();
        }
    }
}

pub struct WatcherState {
    inner: Mutex<Option<WatcherHandle>>,
}

impl WatcherState {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }
}

impl Default for WatcherState {
    fn default() -> Self {
        Self::new()
    }
}

/// notify の EventKind を TS 層の文字列に落とす。受け取る必要のない kind は None。
fn layer_event_label(kind: &notify::EventKind) -> Option<&'static str> {
    use notify::EventKind::{Create, Modify, Remove};
    match kind {
        Create(_) => Some("created"),
        Modify(_) => Some("modified"),
        Remove(_) => Some("removed"),
        _ => None,
    }
}

/// File の mtime を ms 単位で返す。読めない場合は 0（removed event の fallback）。
fn path_mtime_ms(path: &Path) -> u64 {
    let Ok(metadata) = std::fs::metadata(path) else {
        return 0;
    };
    let Ok(modified) = metadata.modified() else {
        return 0;
    };
    modified
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 与えられた scope 内に `path` が収まることを確認し、mtime を ms で返す。
/// 本関数は `stat_file_mtime` の pure 実装——cargo test で scope 挙動を verify
/// するため tauri ランタイムから分離してある。
fn stat_mtime_in_scope(path: &Path, scope: &Path) -> Result<u64, String> {
    let canonical_scope = scope
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize scope: {}", e))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;
    if !canonical_path.starts_with(&canonical_scope) {
        return Err("Path escapes scope".into());
    }
    let metadata = std::fs::metadata(&canonical_path).map_err(|e| format!("Stat failed: {}", e))?;
    let modified = metadata
        .modified()
        .map_err(|e| format!("No mtime available: {}", e))?;
    let since_epoch = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|e| format!("mtime before epoch: {}", e))?;
    Ok(since_epoch.as_millis() as u64)
}

/// 指定 path の mtime を ms 単位で返す。`~/.charminal/` 外の path は拒否。
///
/// TS 層は watcher event で受け取った path を改めて stat することで、watcher の
/// 届ける mtime が古い場合の fallback とする（import URL の cache-bust 用途）。
#[tauri::command]
async fn stat_file_mtime(path: String) -> Result<u64, String> {
    let home = charminal_home_path()?;
    stat_mtime_in_scope(&PathBuf::from(path), &home)
}

/// `~/.charminal/` 配下を watch し、debounced file event を Channel で TS 層に流す。
///
/// 二重呼び出し時は旧 watcher を drop で畳む。`debounce` は 150ms——macOS の
/// fsevent は save 1 回で複数 event を吐くため、path ごとに last-wins で coalesce
/// する。
#[tauri::command]
async fn watch_charminal_layer(
    state: State<'_, WatcherState>,
    on_event: Channel<CharminalLayerEvent>,
) -> Result<(), String> {
    use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};

    let home = charminal_home_path()?;
    std::fs::create_dir_all(home.join("packs"))
        .map_err(|e| format!("Failed to ensure ~/.charminal/packs: {}", e))?;

    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_cb = pending.clone();

    let mut watcher = RecommendedWatcher::new(
        move |res: notify::Result<Event>| match res {
            Ok(event) => {
                let mut guard = match pending_cb.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                for path in event.paths.iter() {
                    guard.insert(path.clone(), event.kind);
                }
            }
            Err(e) => {
                eprintln!("[watch_charminal_layer] notify error: {}", e);
            }
        },
        Config::default(),
    )
    .map_err(|e| format!("Failed to create watcher: {}", e))?;

    watcher
        .watch(&home, RecursiveMode::Recursive)
        .map_err(|e| format!("Failed to watch {}: {}", home.display(), e))?;

    let canonical_home = home
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize ~/.charminal/: {}", e))?;

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let pending_bg = pending.clone();
    let channel = on_event;

    let thread = std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(150));
        if matches!(
            stop_rx.try_recv(),
            Ok(()) | Err(std::sync::mpsc::TryRecvError::Disconnected)
        ) {
            break;
        }
        let drained: Vec<(PathBuf, notify::EventKind)> = {
            let mut guard = match pending_bg.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            guard.drain().collect()
        };
        for (path, kind) in drained {
            let Some(label) = layer_event_label(&kind) else {
                continue;
            };
            // 削除済み path は canonicalize できないので非正規化 path を scope
            // チェックする。上位 dir の存在を scope に対して相対比較するだけ。
            let in_scope = path.canonicalize().map_or_else(
                |_| path.starts_with(&canonical_home) || path.starts_with(&home),
                |canonical| canonical.starts_with(&canonical_home),
            );
            if !in_scope {
                continue;
            }
            let payload = CharminalLayerEvent {
                path: path.to_string_lossy().to_string(),
                kind: label.to_string(),
                mtime_ms: path_mtime_ms(&path),
            };
            if let Err(e) = channel.send(payload) {
                eprintln!("[watch_charminal_layer] channel send failed: {}", e);
                break;
            }
        }
    });

    let mut guard = state
        .inner
        .lock()
        .map_err(|e| format!("WatcherState poisoned: {}", e))?;
    // 旧 handle は drop で watcher / thread が畳まれる。
    *guard = Some(WatcherHandle {
        _watcher: watcher,
        stop_tx,
        thread: Some(thread),
    });
    Ok(())
}

/// VRM file import: copy to $APPDATA/avatars/ and return the destination path.
#[tauri::command]
async fn import_vrm(app: AppHandle, src: String) -> Result<String, String> {
    let src_path = std::path::Path::new(&src);
    if !src_path.exists() {
        return Err("File not found".into());
    }
    let file_name = src_path
        .file_name()
        .ok_or("Invalid file path")?
        .to_string_lossy()
        .to_string();

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get AppData: {}", e))?;
    let avatars_dir = app_data.join("avatars");
    std::fs::create_dir_all(&avatars_dir)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let dest = avatars_dir.join(&file_name);
    std::fs::copy(&src, &dest).map_err(|e| format!("Copy failed: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // SessionRegistry を先に Arc 化して PtyState と Tauri managed state の両方
    // が同じ instance を share する。registry が PtyState 内の `default-session`
    // PtySession を所有し、別途 Tauri command（A-5 で追加予定の `session_*`）
    // も同じ registry に access できる。
    let registry = Arc::new(SessionRegistry::new());
    let pty_state = PtyState::new(Arc::clone(&registry));

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(pty_state)
        .manage(registry)
        .manage(WatcherState::new())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_attach,
            pty_detach,
            import_vrm,
            poll_hook_signals,
            charminal_home_dir,
            ensure_charminal_dirs,
            list_user_packs,
            read_charminal_file,
            is_safe_mode,
            write_charminal_file_atomic,
            read_last_startup_report,
            user_init_script_path,
            watch_charminal_layer,
            stat_file_mtime,
            mcp_tool_response,
            read_journal_memories,
            check_tutorial_done,
            mark_tutorial_done
        ])
        .setup(|app| {
            start_hook_server(app.handle().clone());
            let mcp_handle = app.handle().clone();
            match mcp::spawn_server(mcp_handle) {
                Ok(port) => {
                    eprintln!("[charminal-mcp] listening on localhost:{}", port);
                }
                Err(err) => {
                    eprintln!("[charminal-mcp] startup skipped: {}", err);
                }
            }

            // Cohabitation hours tracking 開始
            let start = journal::cohabitation::start_tracking();
            app.manage(CohabitationStart(std::sync::Mutex::new(Some(start))));

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // 終了時に cohabitation hours を保存
                let start_state: State<'_, CohabitationStart> = app.state();
                let start = start_state
                    .0
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .take();
                if let Some(start) = start {
                    // TODO: active persona id は将来的に runtime state から取得する。
                    // 暫定で "clai" を使う。
                    let persona_id = "clai";
                    if let Err(err) = journal::cohabitation::save_hours(start, persona_id) {
                        eprintln!("[cohabitation] 保存失敗: {}", err);
                    }
                }
            }
        });
}

#[cfg(test)]
mod sdk_bundle_tests {
    use super::{build_bundled_sdk_dts, is_cross_file_module_line};

    #[test]
    fn drops_relative_import_and_export_lines() {
        assert!(is_cross_file_module_line(
            "import type { EffectContext } from \"./context\";"
        ));
        assert!(is_cross_file_module_line("export * from \"./reaction\";"));
        assert!(!is_cross_file_module_line(
            "import type { X } from \"some-package\";"
        ));
        assert!(!is_cross_file_module_line(
            "export type ReactionType = StandardReactionType | (string & {});"
        ));
    }

    #[test]
    fn bundle_contains_key_types_and_omits_cross_refs() {
        let bundle = build_bundled_sdk_dts();
        assert!(bundle.contains("export interface EffectDefinition"));
        assert!(bundle.contains("export interface PersonaDefinition"));
        assert!(bundle.contains("export interface EffectContext"));
        assert!(bundle.contains("export interface UiPackDefinition"));
        assert!(!bundle.contains("from \"./reaction\""));
        assert!(!bundle.contains("from \"./context\""));
    }
}

#[cfg(test)]
mod user_pack_discovery_tests {
    use super::discover_user_pack_entries;
    use std::fs;
    use std::path::PathBuf;

    fn fresh_packs_dir(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-pack-discovery-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("create tmp dir");
        tmp
    }

    #[test]
    fn discovers_ui_tsx_when_ui_js_is_absent() {
        let packs = fresh_packs_dir("ui-tsx");
        let pack_dir = packs.join("my-ui");
        fs::create_dir_all(&pack_dir).expect("create pack dir");
        fs::write(pack_dir.join("ui.tsx"), "export default {};\n").expect("write ui.tsx");

        let entries = discover_user_pack_entries(&packs).expect("discover ok");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "my-ui");
        assert_eq!(entries[0].kind, "ui");
        assert!(entries[0].entry_path.ends_with("/my-ui/ui.tsx"));

        let _ = fs::remove_dir_all(&packs);
    }

    #[test]
    fn prefers_ui_js_over_ui_tsx_for_compatibility() {
        let packs = fresh_packs_dir("ui-js-precedence");
        let pack_dir = packs.join("my-ui");
        fs::create_dir_all(&pack_dir).expect("create pack dir");
        fs::write(pack_dir.join("ui.js"), "export default {};\n").expect("write ui.js");
        fs::write(pack_dir.join("ui.tsx"), "export default {};\n").expect("write ui.tsx");

        let entries = discover_user_pack_entries(&packs).expect("discover ok");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "ui");
        assert!(entries[0].entry_path.ends_with("/my-ui/ui.js"));

        let _ = fs::remove_dir_all(&packs);
    }
}

#[cfg(test)]
mod layer_scope_tests {
    use super::{
        is_safe_mode_value, layer_event_label, read_last_startup_report_impl, stat_mtime_in_scope,
        write_charminal_file_atomic_impl,
    };
    use std::fs;
    use std::path::PathBuf;

    fn fresh_dir(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-phase1b-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("create tmp dir");
        tmp
    }

    #[test]
    fn stat_mtime_in_scope_returns_positive_mtime_for_file_inside_scope() {
        let root = fresh_dir("inside");
        let file = root.join("hello.js");
        fs::write(&file, "export default 1;\n").expect("write file");

        let mtime = stat_mtime_in_scope(&file, &root).expect("stat ok");
        assert!(mtime > 0, "expected mtime to be positive, got {}", mtime);

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn stat_mtime_in_scope_rejects_file_outside_scope() {
        let scope = fresh_dir("scope");
        let sibling = fresh_dir("sibling");
        let outside = sibling.join("outside.js");
        fs::write(&outside, "x\n").expect("write file");

        let result = stat_mtime_in_scope(&outside, &scope);
        assert!(
            result.is_err(),
            "expected scope rejection, got {:?}",
            result
        );

        let _ = fs::remove_dir_all(&scope);
        let _ = fs::remove_dir_all(&sibling);
    }

    #[test]
    fn stat_mtime_in_scope_rejects_nonexistent_file() {
        let scope = fresh_dir("missing-file");
        let phantom = scope.join("does-not-exist.js");

        let result = stat_mtime_in_scope(&phantom, &scope);
        assert!(
            result.is_err(),
            "expected error for missing file, got {:?}",
            result
        );

        let _ = fs::remove_dir_all(&scope);
    }

    #[test]
    fn layer_event_label_maps_create_modify_remove_and_ignores_the_rest() {
        use notify::event::{
            AccessKind, CreateKind, DataChange, ModifyKind, RemoveKind, RenameMode,
        };
        use notify::EventKind;

        assert_eq!(
            layer_event_label(&EventKind::Create(CreateKind::File)),
            Some("created"),
        );
        assert_eq!(
            layer_event_label(&EventKind::Modify(ModifyKind::Data(DataChange::Any))),
            Some("modified"),
        );
        assert_eq!(
            layer_event_label(&EventKind::Modify(ModifyKind::Name(RenameMode::Any))),
            Some("modified"),
        );
        assert_eq!(
            layer_event_label(&EventKind::Remove(RemoveKind::File)),
            Some("removed"),
        );
        assert_eq!(layer_event_label(&EventKind::Access(AccessKind::Any)), None,);
        assert_eq!(layer_event_label(&EventKind::Any), None);
        assert_eq!(layer_event_label(&EventKind::Other), None);
    }

    // ─── Phase 1-c: safe-mode / atomic write / load-report ────────

    #[test]
    fn detect_safe_mode_reads_charminal_safe_mode_env_var() {
        // 子スレッドで env var を設定して判定。test 並列実行で global 状態を
        // 汚さないよう、判定 helper 関数は env var 値を引数として受ける形にする。
        assert!(is_safe_mode_value(Some("1")));
        assert!(!is_safe_mode_value(Some("0")));
        assert!(!is_safe_mode_value(Some("")));
        assert!(!is_safe_mode_value(Some("true")));
        assert!(!is_safe_mode_value(None));
    }

    #[test]
    fn write_charminal_file_atomic_writes_file_and_rejects_path_traversal() {
        let tmp_home = fresh_dir("atomic-write");
        std::env::set_var("HOME", &tmp_home);

        // valid path inside ~/.charminal/ should succeed
        let result =
            write_charminal_file_atomic_impl("last-startup.json", "{\"ok\":true}", &tmp_home);
        assert!(result.is_ok(), "expected ok, got {:?}", result);

        let written =
            std::fs::read_to_string(tmp_home.join(".charminal").join("last-startup.json"))
                .expect("read written file");
        assert_eq!(written, "{\"ok\":true}");

        // path traversal must be rejected
        let bad = write_charminal_file_atomic_impl("../escape.txt", "nope", &tmp_home);
        assert!(bad.is_err(), "expected traversal rejection, got {:?}", bad);

        let _ = std::fs::remove_dir_all(&tmp_home);
    }

    #[test]
    fn read_last_startup_report_returns_empty_string_when_file_missing() {
        let tmp_home = fresh_dir("missing-report");
        let result = read_last_startup_report_impl(&tmp_home);
        assert_eq!(result.unwrap(), "");
        let _ = std::fs::remove_dir_all(&tmp_home);
    }

    #[test]
    fn read_last_startup_report_returns_file_contents_when_present() {
        let tmp_home = fresh_dir("present-report");
        let charminal = tmp_home.join(".charminal");
        std::fs::create_dir_all(&charminal).expect("mkdir");
        std::fs::write(charminal.join("last-startup.json"), "{\"saved\":true}")
            .expect("write fixture");

        let result = read_last_startup_report_impl(&tmp_home);
        assert_eq!(result.unwrap(), "{\"saved\":true}");

        let _ = std::fs::remove_dir_all(&tmp_home);
    }
}

#[cfg(test)]
mod user_init_seed_tests {
    use super::{seed_user_init_script_impl, USER_INIT_TEMPLATE};
    use std::fs;
    use std::path::PathBuf;

    fn fresh_home(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-init-seed-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("create tmp home");
        tmp
    }

    #[test]
    fn seeds_template_when_init_js_missing() {
        let home = fresh_home("missing");

        seed_user_init_script_impl(&home).expect("seed ok");

        let written = fs::read_to_string(home.join("init.js")).expect("read seeded file");
        assert_eq!(written, USER_INIT_TEMPLATE);

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn preserves_existing_init_js_content() {
        let home = fresh_home("existing");
        let existing = "// user's handcrafted init — don't touch\n";
        fs::write(home.join("init.js"), existing).expect("write fixture");

        seed_user_init_script_impl(&home).expect("seed ok");

        let after = fs::read_to_string(home.join("init.js")).expect("read");
        assert_eq!(after, existing);

        let _ = fs::remove_dir_all(&home);
    }
}

#[cfg(test)]
mod tutorial_tests {
    use std::fs;
    use std::path::PathBuf;

    fn fresh_dir(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-tutorial-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("create tmp dir");
        tmp
    }

    #[test]
    fn check_returns_false_when_no_flag() {
        let dir = fresh_dir("check-false");
        let result = super::check_tutorial_done_impl(&dir);
        assert!(!result);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mark_creates_flag_and_check_returns_true() {
        let dir = fresh_dir("mark-then-check");
        super::mark_tutorial_done_impl(&dir).expect("mark ok");
        assert!(dir.join(".tutorial-done").exists());
        assert!(super::check_tutorial_done_impl(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mark_is_idempotent() {
        let dir = fresh_dir("mark-idempotent");
        super::mark_tutorial_done_impl(&dir).expect("mark 1");
        super::mark_tutorial_done_impl(&dir).expect("mark 2");
        assert!(super::check_tutorial_done_impl(&dir));
        let _ = fs::remove_dir_all(&dir);
    }
}
