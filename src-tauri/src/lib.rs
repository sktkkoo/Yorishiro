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
    state.spawn(app, cols, rows, cwd, &claude_bin, system_prompt, on_output)
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
            poll_hook_signals
        ])
        .setup(|app| {
            start_hook_server(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
