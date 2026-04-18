mod pty;

use pty::{start_hook_server, PtyState};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Manager, State};

fn find_claude_binary() -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    let candidates = [
        format!("{}/.local/bin/claude", home),
        format!("{}/.cargo/bin/claude", home),
        "/usr/local/bin/claude".to_string(),
        "/opt/homebrew/bin/claude".to_string(),
    ];
    for path in &candidates {
        if std::path::Path::new(path).exists() {
            return path.clone();
        }
    }
    "claude".to_string()
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
async fn pty_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    system_prompt: Option<String>,
    on_output: Channel,
) -> Result<(), String> {
    let claude_bin = find_claude_binary();
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
        &claude_bin,
        system_prompt,
        plugin_dir,
        on_output,
    )
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
//   │   └── <pack-id>/<kind>.js         # kind ∈ {effect, persona, voice, body, scene}
//   ├── config.json                     # 将来の宣言的設定
//   └── sdk.d.ts                        # Charminal が ship する IDE 用 type hint
//
// Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
// Internal design-record: 2026-04-18-user-layer-runtime.md

const PACK_KINDS: &[&str] = &["effect", "persona", "voice", "body", "scene"];

fn charminal_home_path() -> Result<std::path::PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    Ok(std::path::PathBuf::from(home).join(".charminal"))
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
    ("harness.d.ts", include_str!("../../src/sdk/harness.d.ts")),
    ("effect.d.ts", include_str!("../../src/sdk/effect.d.ts")),
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

/// Create ~/.charminal/ + ~/.charminal/packs/ and refresh sdk.d.ts. Idempotent.
///
/// sdk.d.ts は user の IDE が「Charminal SDK の shape」を知るためのヒント
/// ファイル。毎起動で overwrite する（user は編集対象ではない）。
#[tauri::command]
async fn ensure_charminal_dirs() -> Result<(), String> {
    let home = charminal_home_path()?;
    std::fs::create_dir_all(home.join("packs"))
        .map_err(|e| format!("Failed to create ~/.charminal/packs: {}", e))?;
    std::fs::write(home.join("sdk.d.ts"), build_bundled_sdk_dts())
        .map_err(|e| format!("Failed to write ~/.charminal/sdk.d.ts: {}", e))?;
    Ok(())
}

/// Scan ~/.charminal/packs/ and return discovered packs.
///
/// Convention: ~/.charminal/packs/<id>/<kind>.js where kind is one of PACK_KINDS.
/// Multiple kind files in one pack directory produce multiple entries.
/// Missing directory returns empty vec (not an error).
#[tauri::command]
async fn list_user_packs() -> Result<Vec<UserPackEntry>, String> {
    let packs_dir = charminal_home_path()?.join("packs");
    if !packs_dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    let read =
        std::fs::read_dir(&packs_dir).map_err(|e| format!("Failed to read packs dir: {}", e))?;
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
            let entry_file = pack_dir.join(format!("{}.js", kind));
            if entry_file.is_file() {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::new())
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
            user_init_script_path,
            watch_charminal_layer,
            stat_file_mtime
        ])
        .setup(|app| {
            start_hook_server(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
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
        assert!(!bundle.contains("from \"./reaction\""));
        assert!(!bundle.contains("from \"./context\""));
    }
}

#[cfg(test)]
mod layer_scope_tests {
    use super::{layer_event_label, stat_mtime_in_scope};
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
}
