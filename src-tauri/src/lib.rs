mod pty;

use pty::{start_hook_server, PtyState};
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

/// Create ~/.charminal/ and ~/.charminal/packs/ if missing. Idempotent.
#[tauri::command]
async fn ensure_charminal_dirs() -> Result<(), String> {
    let home = charminal_home_path()?;
    std::fs::create_dir_all(home.join("packs"))
        .map_err(|e| format!("Failed to create ~/.charminal/packs: {}", e))?;
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
            user_init_script_path
        ])
        .setup(|app| {
            start_hook_server(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
