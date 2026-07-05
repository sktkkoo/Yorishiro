mod bundled_examples_gen;
mod history;
mod journal;
mod mcp;
mod pty;
mod sessions;
mod tts;

use pty::{start_hook_server, PtyState};
use sessions::{AttachResult, SessionRegistry, SpawnSpec};
use std::collections::{BTreeSet, HashMap};
use std::ffi::OsStr;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

/// Cohabitation hours tracking の開始時刻を保持する managed state。
/// `Option` は終了時に `take()` して二重 save を防ぐため。
struct CohabitationStart(std::sync::Mutex<Option<std::time::Instant>>);

#[derive(Clone, Default, serde::Serialize)]
struct McpServerStatusSnapshot {
    port: Option<u16>,
    error: Option<String>,
}

#[derive(Default)]
struct McpServerStatus(Mutex<McpServerStatusSnapshot>);

static LOCALIZED_PLUGIN_DIR_LOCK: Mutex<()> = Mutex::new(());

#[cfg(test)]
pub(crate) static TEST_HOME_ENV_LOCK: Mutex<()> = Mutex::new(());

/// cross-platform な home directory 取得。Windows では USERPROFILE を返す。
pub(crate) fn home_dir_or_err() -> Result<std::path::PathBuf, String> {
    dirs::home_dir().ok_or_else(|| "home directory not found".to_string())
}

/// `~` / `~/...` を home directory に展開する。それ以外のパスはそのまま返す。
fn expand_tilde(path: &str, home: &Path) -> PathBuf {
    if path == "~" {
        home.to_path_buf()
    } else if let Some(rest) = path.strip_prefix("~/") {
        home.join(rest)
    } else {
        PathBuf::from(path)
    }
}

/// media folder の scope 追加先が広すぎる（root or home 全体）か。正規化済み path を渡す前提。
///
/// `mediaFolders` は user-owned config だが、`/` や `$HOME` 全体を asset protocol scope に
/// 開くと、CSP 越えの XSS や system_exec 経由の config 改竄から FS 広域を webview が読める
/// 二次経路になる。ルート級だけを拒否する（深い任意 path・外部ドライブは許容）。
fn is_too_broad_media_scope(folder: &Path, home: &Path) -> bool {
    (folder.has_root() && folder.parent().is_none()) || folder == home
}

/// `~/.yorishiro/config.json` の `mediaFolders` を読み、asset protocol scope に追加する。
/// field 未指定時は `["~/Music"]` を default として扱う。
fn register_media_folder_scopes(app: &tauri::App) {
    let home = dirs::home_dir().unwrap_or_default();
    let canonical_home = home.canonicalize().unwrap_or_else(|_| home.clone());
    let config_path = yorishiro_home_path_under(&home).join("config.json");

    let folders: Vec<PathBuf> = if config_path.is_file() {
        match std::fs::read_to_string(&config_path) {
            Ok(text) => {
                let parsed: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
                match parsed.get("mediaFolders").and_then(|v| v.as_array()) {
                    Some(arr) => arr
                        .iter()
                        .filter_map(|v| v.as_str())
                        .map(|s| expand_tilde(s, &home))
                        .collect(),
                    // field 未指定 → default
                    None => vec![home.join("Music")],
                }
            }
            Err(_) => vec![home.join("Music")],
        }
    } else {
        vec![home.join("Music")]
    };

    let scope = app.asset_protocol_scope();
    for folder in &folders {
        if folder.is_dir() {
            let canonical_folder = match folder.canonicalize() {
                Ok(path) => path,
                Err(e) => {
                    eprintln!(
                        "[media-folders] scope 正規化失敗: {} — {}",
                        folder.display(),
                        e
                    );
                    continue;
                }
            };
            if is_too_broad_media_scope(&canonical_folder, &canonical_home) {
                eprintln!(
                    "[media-folders] 広すぎる scope を拒否: {}",
                    canonical_folder.display()
                );
                continue;
            }
            if let Err(e) = scope.allow_directory(&canonical_folder, true) {
                eprintln!(
                    "[media-folders] scope 追加失敗: {} — {}",
                    canonical_folder.display(),
                    e
                );
            }
        }
    }
}

#[cfg(test)]
mod media_scope_tests {
    use super::is_too_broad_media_scope;
    use std::path::Path;

    #[test]
    fn rejects_filesystem_root() {
        assert!(is_too_broad_media_scope(
            Path::new("/"),
            Path::new("/home/u")
        ));
    }

    #[test]
    fn rejects_home_itself() {
        assert!(is_too_broad_media_scope(
            Path::new("/home/u"),
            Path::new("/home/u")
        ));
    }

    #[test]
    fn accepts_subdir_of_home() {
        assert!(!is_too_broad_media_scope(
            Path::new("/home/u/Music"),
            Path::new("/home/u")
        ));
    }

    #[test]
    fn accepts_external_media_dir() {
        assert!(!is_too_broad_media_scope(
            Path::new("/Volumes/ext/music"),
            Path::new("/home/u")
        ));
    }
}

// ─── system.exec ────────────────────────────────────────────────

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SystemExecOptions {
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
    timeout_ms: Option<u64>,
    input: Option<String>,
    quiet: Option<bool>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemExecResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
    duration_ms: u64,
}

#[cfg(windows)]
struct WindowsJobHandle(usize);

#[cfg(windows)]
impl Drop for WindowsJobHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = windows_sys::Win32::Foundation::CloseHandle(self.0 as _);
        }
    }
}

#[cfg(windows)]
fn create_kill_on_close_job(child: &std::process::Child) -> Option<WindowsJobHandle> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return None;
        }

        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if configured == 0 {
            let _ = CloseHandle(job);
            return None;
        }

        let assigned = AssignProcessToJobObject(job, child.as_raw_handle() as _);
        if assigned == 0 {
            let _ = CloseHandle(job);
            return None;
        }

        Some(WindowsJobHandle(job as usize))
    }
}

#[cfg(windows)]
fn kill_windows_process_tree(child_id: u32, job: Option<WindowsJobHandle>) {
    if job.is_some() {
        drop(job);
        return;
    }

    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &child_id.to_string()])
        .output();
}

#[tauri::command]
async fn system_exec(
    pack_id: String,
    command: String,
    options: Option<SystemExecOptions>,
) -> Result<SystemExecResult, String> {
    use std::process::{Command, Stdio};
    use std::time::Instant;

    let opts = options.unwrap_or(SystemExecOptions {
        cwd: None,
        env: None,
        timeout_ms: None,
        input: None,
        quiet: None,
    });
    let quiet = opts.quiet.unwrap_or(false);

    if !quiet {
        let cmd_display: String = command.chars().take(120).collect();
        let cmd_truncated = cmd_display.len() < command.len();
        eprintln!(
            "[system-exec] pack={} cmd={}{}",
            pack_id,
            cmd_display,
            if cmd_truncated { "…" } else { "" }
        );
    }

    let shell = if cfg!(windows) { "cmd" } else { "sh" };
    let shell_flag = if cfg!(windows) { "/C" } else { "-c" };

    let mut cmd = Command::new(shell);
    cmd.arg(shell_flag).arg(&command);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());

    // 新 process group で起動（timeout 時に子プロセスごと kill するため）
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    // Charminal の PATH を継承
    cmd.env("PATH", build_path_env());

    if let Some(cwd) = &opts.cwd {
        cmd.current_dir(cwd);
    }
    if let Some(env) = &opts.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }
    let input_data = opts.input.clone();
    if input_data.is_some() {
        cmd.stdin(Stdio::piped());
    }

    let start = Instant::now();

    let mut child = cmd.spawn().map_err(|e| format!("spawn failed: {e}"))?;
    #[cfg(windows)]
    let windows_job = create_kill_on_close_job(&child);

    let timeout_ms = opts.timeout_ms.unwrap_or(30_000);
    let child_id = child.id();
    let result = tokio::task::spawn_blocking(move || {
        let deadline = start + Duration::from_millis(timeout_ms);

        // stdin / stdout / stderr を全て concurrent に処理（deadlock 防止）。
        // 各 drain thread は deadline を共有し、背景プロセスが pipe を保持しても
        // timeout で抜ける。
        let stdin_handle = input_data.and_then(|data| {
            child.stdin.take().map(|stdin| {
                std::thread::spawn(move || {
                    use std::io::Write;
                    let mut stdin = stdin;
                    let _ = stdin.write_all(data.as_bytes());
                })
            })
        });
        let stdout_handle = child.stdout.take().map(|r| {
            let dl = deadline;
            std::thread::spawn(move || {
                let mut s = String::new();
                let mut r = r;
                let mut buf = [0u8; 8192];
                loop {
                    if Instant::now() >= dl {
                        break;
                    }
                    match std::io::Read::read(&mut r, &mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        }
                        Err(_) => break,
                    }
                }
                s
            })
        });
        let stderr_handle = child.stderr.take().map(|r| {
            let dl = deadline;
            std::thread::spawn(move || {
                let mut s = String::new();
                let mut r = r;
                let mut buf = [0u8; 8192];
                loop {
                    if Instant::now() >= dl {
                        break;
                    }
                    match std::io::Read::read(&mut r, &mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            s.push_str(&String::from_utf8_lossy(&buf[..n]));
                        }
                        Err(_) => break,
                    }
                }
                s
            })
        });

        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    // shell 終了後、背景プロセスが pipe FD を保持して
                    // drain thread を block するのを防ぐため process group を kill。
                    #[cfg(unix)]
                    {
                        unsafe {
                            libc::kill(-(child_id as i32), libc::SIGKILL);
                        }
                    }
                    #[cfg(windows)]
                    {
                        kill_windows_process_tree(child_id, windows_job);
                    }

                    if let Some(h) = stdin_handle {
                        let _ = h.join();
                    }
                    let stdout = stdout_handle
                        .and_then(|h| h.join().ok())
                        .unwrap_or_default();
                    let stderr = stderr_handle
                        .and_then(|h| h.join().ok())
                        .unwrap_or_default();
                    return Ok(SystemExecResult {
                        exit_code: status.code().unwrap_or(-1),
                        stdout,
                        stderr,
                        duration_ms: start.elapsed().as_millis() as u64,
                    });
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        // process tree ごと kill
                        #[cfg(unix)]
                        {
                            unsafe {
                                libc::kill(-(child_id as i32), libc::SIGKILL);
                            }
                        }
                        #[cfg(windows)]
                        {
                            kill_windows_process_tree(child_id, windows_job);
                        }
                        let _ = child.wait();
                        return Err(format!("timeout after {timeout_ms}ms"));
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(e) => return Err(format!("wait failed: {e}")),
            }
        }
    })
    .await
    .map_err(|e| format!("task join failed: {e}"))?;

    match &result {
        Ok(r) => {
            if !quiet || r.exit_code != 0 {
                eprintln!(
                    "[system-exec] pack={} exit={} duration={}ms",
                    pack_id, r.exit_code, r.duration_ms
                );
            }
        }
        Err(e) => eprintln!("[system-exec] pack={} error={}", pack_id, e),
    }

    result
}

fn build_path_env() -> String {
    let home = dirs::home_dir().unwrap_or_default();
    let home = home.to_string_lossy();
    let current = std::env::var("PATH").unwrap_or_default();
    let sep = if cfg!(windows) { ";" } else { ":" };
    // adapter 固有の install dir（例: OpenCode の ~/.opencode/bin）を先頭に積む。
    // generic 層は agent 固有 location を直書きしない。
    let mut dirs: Vec<String> = crate::sessions::agent_adapter::all_extra_path_dirs()
        .iter()
        .map(|dir| dir.to_string_lossy().into_owned())
        .collect();
    if cfg!(windows) {
        dirs.push(format!("{}\\.cargo\\bin", home));
    } else {
        dirs.push(format!("{}/.local/bin", home));
        dirs.push(format!("{}/.cargo/bin", home));
        dirs.push("/usr/local/bin".to_string());
        dirs.push("/opt/homebrew/bin".to_string());
    }
    dirs.push(current);
    dirs.join(sep)
}

fn command_candidate_names(command: &str) -> Vec<String> {
    if !cfg!(windows) || Path::new(command).extension().is_some() {
        return vec![command.to_string()];
    }
    let pathext = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    pathext
        .split(';')
        .filter(|ext| !ext.trim().is_empty())
        .map(|ext| format!("{}{}", command, ext.to_ascii_lowercase()))
        .chain(std::iter::once(command.to_string()))
        .collect()
}

fn resolve_command_path_impl(command: &str) -> Option<String> {
    if command.trim().is_empty() || command.contains('/') || command.contains('\\') {
        return None;
    }
    let path_env = build_path_env();
    let candidates = command_candidate_names(command);
    for dir in std::env::split_paths(&path_env) {
        for candidate in &candidates {
            let path = dir.join(candidate);
            if path.is_file() {
                return Some(path.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn canonicalize_cwd(cwd: &Path) -> Result<PathBuf, String> {
    cwd.canonicalize()
        .map_err(|e| format!("cwd canonicalize failed: {} — {}", cwd.display(), e))
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn gitdir_from_file(git_file: &Path) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(git_file).ok()?;
    let path = raw.trim().strip_prefix("gitdir:")?.trim();
    if path.is_empty() {
        return None;
    }
    let path = Path::new(path);
    let git_dir = if path.is_absolute() {
        path.to_path_buf()
    } else {
        git_file.parent()?.join(path)
    };
    Some(canonical_or_self(&git_dir))
}

fn sibling_workdir_pointing_to_git_dir(git_dir: &Path) -> Option<PathBuf> {
    let parent = git_dir.parent()?;
    let canonical_git_dir = canonical_or_self(git_dir);
    for entry in std::fs::read_dir(parent).ok()? {
        let path = entry.ok()?.path();
        if !path.is_dir() {
            continue;
        }
        let git_file = path.join(".git");
        if !git_file.is_file() {
            continue;
        }
        if gitdir_from_file(&git_file).as_ref() == Some(&canonical_git_dir) {
            return Some(canonical_or_self(&path));
        }
    }
    None
}

fn main_workdir_from_worktree_repo(repo: &git2::Repository) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(repo.path().join("commondir")).ok()?;
    let path = Path::new(raw.trim());
    if path.as_os_str().is_empty() {
        return None;
    }
    // git2 0.19 には Repository::commondir wrapper が無いため、linked worktree の
    // commondir file を使って common git dir を解決する。これは `.git` という directory
    // 名には依存しない。
    let common_git_dir = if path.is_absolute() {
        path.to_path_buf()
    } else {
        repo.path().join(path)
    };
    let common_git_dir = canonical_or_self(&common_git_dir);
    if let Some(workdir) = sibling_workdir_pointing_to_git_dir(&common_git_dir) {
        return Some(workdir);
    }
    let main_repo = git2::Repository::open(common_git_dir).ok()?;
    main_repo.workdir().map(canonical_or_self)
}

fn resolve_project_root_impl(cwd: &Path) -> Result<PathBuf, String> {
    let canonical_cwd = canonicalize_cwd(cwd)?;
    let Ok(repo) = git2::Repository::discover(&canonical_cwd) else {
        return Ok(canonical_cwd);
    };

    // Bare repo / workdir 不明は「project root を確定できない」扱いで cwd に degrade。
    if repo.is_bare() || repo.workdir().is_none() {
        return Ok(canonical_cwd);
    }

    // linked worktree は本体 repo の working directory に畳む。
    if repo.is_worktree() {
        if let Some(main_workdir) = main_workdir_from_worktree_repo(&repo) {
            return Ok(main_workdir);
        }
        return Ok(canonical_cwd);
    }

    let Some(workdir) = repo.workdir() else {
        return Ok(canonical_cwd);
    };
    Ok(canonical_or_self(workdir))
}

fn normalized_plugin_language(language: &str) -> &'static str {
    if language == "ja" {
        "ja"
    } else {
        "en"
    }
}

fn copy_file_to_dir(src: &Path, dest_dir: &Path) -> Result<(), String> {
    let file_name = src
        .file_name()
        .ok_or_else(|| format!("invalid resource path: {}", src.display()))?;
    std::fs::copy(src, dest_dir.join(file_name))
        .map(|_| ())
        .map_err(|e| format!("copy {} failed: {}", src.display(), e))
}

fn copy_markdown_files_to_dir(src_dir: &Path, dest_dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src_dir)
        .map_err(|e| format!("read {} failed: {}", src_dir.display(), e))?
    {
        let path = entry
            .map_err(|e| format!("read command dir entry failed: {}", e))?
            .path();
        if path.extension().and_then(|ext| ext.to_str()) == Some("md") {
            copy_file_to_dir(&path, dest_dir)?;
        }
    }
    Ok(())
}

fn parse_command_markdown(content: &str) -> (String, String) {
    let mut description = String::new();
    let mut in_frontmatter = false;
    let mut frontmatter_end = 0;

    for (i, line) in content.lines().enumerate() {
        let trimmed = line.trim();
        if i == 0 && trimmed == "---" {
            in_frontmatter = true;
            continue;
        }
        if in_frontmatter {
            if trimmed == "---" {
                in_frontmatter = false;
                frontmatter_end = i;
                continue;
            }
            if let Some(desc) = trimmed.strip_prefix("description:") {
                description = desc.trim().trim_matches('"').to_string();
            }
        }
    }

    let lines_vec: Vec<&str> = content.lines().collect();
    let mut body_start = if frontmatter_end > 0 {
        frontmatter_end + 1
    } else {
        0
    };
    while body_start < lines_vec.len() {
        let trimmed = lines_vec[body_start].trim();
        if trimmed.is_empty() || trimmed == "$ARGUMENTS" || trimmed == "---" {
            body_start += 1;
        } else {
            break;
        }
    }

    let body: String = lines_vec[body_start..].join("\n");
    (description, body)
}

fn rewrite_charm_slash_commands_for_codex(input: &str) -> String {
    let mut out = input.to_string();
    for (slash, skill) in [
        ("/charm:create", "$charm-create"),
        ("/charm:update", "$charm-update"),
        ("/charm:help", "$charm-help"),
        ("/charm:shortcut", "$charm-shortcut"),
        ("/charm:tutorial", "$charm-tutorial"),
        ("/charm:*", "$charm-*"),
    ] {
        out = out.replace(slash, skill);
    }
    out
}

/// Claude Code 形式（YAML frontmatter）のコマンド .md を Codex skill に変換。
/// Codex では Charminal custom slash command は使わず、`$charm-*` skill を入口にする。
fn convert_command_to_codex_skill(content: &str, command_name: &str) -> String {
    let (description, body) = parse_command_markdown(content);
    let skill_name = format!("charm-{}", command_name);
    let body = rewrite_charm_slash_commands_for_codex(&body);

    if description.is_empty() {
        format!(
            "---\nname: {}\ndescription: Charminal {}\n---\n\n# {}\n\n$ARGUMENTS\n\n---\n\n{}",
            skill_name, command_name, skill_name, body
        )
    } else {
        format!(
            "---\nname: {}\ndescription: {}\n---\n\n# {}\n\n$ARGUMENTS\n\n---\n\n{}",
            skill_name, description, skill_name, body
        )
    }
}

fn codex_entrypoint_skill(language: &str) -> &'static str {
    if language == "ja" {
        r#"---
name: charm
description: Charminal の pack 作成・編集・ショートカット・チュートリアル入口
---

# Charminal

Codex CLI では Charminal の custom slash command は使えないため、Codex では `$charm` と専用 skill を入口にする。

- `$charm-create ...`: 新しい pack を作る。
- `$charm-update ...`: 既存 pack を編集・調整する。
- `$charm-shortcut ...`: ショートカットを追加・編集する。
- `$charm-tutorial`: 初回チュートリアルを開始する。
- `$charm-help`: Charminal commands / skills と pack の基本を説明する。
"#
    } else {
        r#"---
name: charm
description: Charminal entry point for pack creation, editing, shortcuts, and tutorials
---

# Charminal

Codex CLI does not recognize Charminal custom slash commands as built-in commands, so Charminal uses `$charm` and dedicated skills as the Codex entry point.

- `$charm-create ...`: Create a new pack.
- `$charm-update ...`: Edit or tune an existing pack.
- `$charm-shortcut ...`: Add or edit shortcuts.
- `$charm-tutorial`: Run the first-use tutorial.
- `$charm-help`: Explain Charminal commands / skills and pack basics.
"#
    }
}

fn write_codex_skill_files(src_dir: &Path, skills_dir: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src_dir)
        .map_err(|e| format!("read {} failed: {}", src_dir.display(), e))?
    {
        let entry = entry.map_err(|e| format!("read command dir entry failed: {}", e))?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
            continue;
        }
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("read {} failed: {}", path.display(), e))?;
        let command_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown");
        let skill_name = format!("charm-{}", command_name);
        let skill_dir = skills_dir.join(&skill_name);
        std::fs::create_dir_all(&skill_dir)
            .map_err(|e| format!("codex skill dir create failed: {}", e))?;
        let converted = convert_command_to_codex_skill(&content, command_name);
        std::fs::write(skill_dir.join("SKILL.md"), converted)
            .map_err(|e| format!("write codex skill {} failed: {}", path.display(), e))?;
    }
    Ok(())
}

fn write_codex_plugin_cache(
    cache_root: &Path,
    codex_plugin_json: &Path,
    source_commands: &Path,
    language: &str,
) -> Result<(), String> {
    let cache_meta = cache_root.join(".codex-plugin");
    let stale_commands = cache_root.join("commands");
    let cache_skills = cache_root.join("skills");

    std::fs::create_dir_all(&cache_meta)
        .map_err(|e| format!("codex cache meta dir create failed: {}", e))?;
    if stale_commands.exists() {
        std::fs::remove_dir_all(&stale_commands)
            .map_err(|e| format!("codex cache commands cleanup failed: {}", e))?;
    }
    if cache_skills.exists() {
        std::fs::remove_dir_all(&cache_skills)
            .map_err(|e| format!("codex cache skills cleanup failed: {}", e))?;
    }
    std::fs::create_dir_all(&cache_skills)
        .map_err(|e| format!("codex cache skills dir create failed: {}", e))?;

    copy_file_to_dir(codex_plugin_json, &cache_meta)?;
    let entry_skill_dir = cache_skills.join("charm");
    std::fs::create_dir_all(&entry_skill_dir)
        .map_err(|e| format!("codex entry skill dir create failed: {}", e))?;
    std::fs::write(
        entry_skill_dir.join("SKILL.md"),
        codex_entrypoint_skill(language),
    )
    .map_err(|e| format!("write codex entry skill failed: {}", e))?;
    write_codex_skill_files(source_commands, &cache_skills)?;

    Ok(())
}

/// Codex プラグインキャッシュに charm プラグインをインストール。
/// `~/.codex/plugins/cache/yorishiro-local/charm/current/` に配置する。
#[cfg(not(test))]
fn install_codex_plugin_to_cache(
    codex_plugin_json: &Path,
    source_commands: &Path,
    language: &str,
) -> Result<(), String> {
    let Some(home) = dirs::home_dir() else {
        return Ok(());
    };
    let codex_dir = home.join(".codex");
    if !codex_dir.exists() {
        return Ok(());
    }
    let cache_root = codex_dir
        .join("plugins")
        .join("cache")
        .join("yorishiro-local")
        .join("charm")
        .join("current");
    write_codex_plugin_cache(&cache_root, codex_plugin_json, source_commands, language)
}

#[cfg(test)]
fn install_codex_plugin_to_cache(
    _codex_plugin_json: &Path,
    _source_commands: &Path,
    _language: &str,
) -> Result<(), String> {
    Ok(())
}

fn prepare_localized_plugin_dir_at(
    resource_root: &Path,
    target_root: &Path,
    language: &str,
) -> Result<(), String> {
    let language = normalized_plugin_language(language);
    let source_commands = resource_root.join(format!("commands-{}", language));
    if !source_commands.is_dir() {
        return Err(format!(
            "localized command directory not found: {}",
            source_commands.display()
        ));
    }

    // Claude Code は runtime 側の commands/*.md を読む。source は
    // commands-{language} から選び、起動ごとに runtime-plugin/commands へ展開する。
    let target_plugin_meta = target_root.join(".claude-plugin");
    let target_commands = target_root.join("commands");
    std::fs::create_dir_all(&target_plugin_meta)
        .map_err(|e| format!("runtime plugin meta dir create failed: {}", e))?;
    if target_commands.exists() {
        std::fs::remove_dir_all(&target_commands)
            .map_err(|e| format!("runtime plugin commands cleanup failed: {}", e))?;
    }
    std::fs::create_dir_all(&target_commands)
        .map_err(|e| format!("runtime plugin commands dir create failed: {}", e))?;

    copy_file_to_dir(
        &resource_root.join(".claude-plugin").join("plugin.json"),
        &target_plugin_meta,
    )?;
    copy_markdown_files_to_dir(&source_commands, &target_commands)?;

    // Codex: プラグインキャッシュに直接インストール。
    // Codex は ~/.codex/plugins/cache/<marketplace>/<plugin>/<hash>/ から
    // プラグインを発見する。-c config override の marketplace 登録だけでは
    // キャッシュへのインストールが行われず発見されない。
    if let Err(e) = install_codex_plugin_to_cache(
        &resource_root.join(".codex-plugin").join("plugin.json"),
        &source_commands,
        language,
    ) {
        eprintln!(
            "[prepare_localized_plugin_dir] codex cache install failed (non-fatal): {}",
            e
        );
    }

    Ok(())
}

/// resolved language に対応する agent plugin runtime dir を生成する。
/// `~/.yorishiro/runtime-plugin/` は Charminal 管理領域で、起動ごとに上書きしてよい。
#[tauri::command]
fn prepare_localized_plugin_dir(app: AppHandle, language: String) -> Result<String, String> {
    let _guard = LOCALIZED_PLUGIN_DIR_LOCK
        .lock()
        .map_err(|e| format!("runtime plugin dir lock poisoned: {}", e))?;
    let resource_root = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir failed: {}", e))?
        .join("resources")
        .join("charminal-plugin");
    let target_root = home_dir_or_err()?.join(".yorishiro").join("runtime-plugin");
    prepare_localized_plugin_dir_at(&resource_root, &target_root, &language)?;
    Ok(target_root.to_string_lossy().to_string())
}

/// 任意 session id で PTY を spawn する。session_id を省略した legacy 呼び出し
/// （旧 single-pane flow）は default-session を作る。caller が明示的に id を
/// 渡せば multi-pane で session を並列に持てる。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
async fn session_spawn(
    app: AppHandle,
    state: State<'_, PtyState>,
    session_id: Option<String>,
    spec: SpawnSpec,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    on_output: Channel,
) -> Result<(), String> {
    // Agent variant のときだけ Tauri resource path から plugin_dir を差し込む。
    // Claude Code では --plugin-dir、Codex では local marketplace root として使う。
    let final_spec = match spec {
        SpawnSpec::Agent {
            agent,
            command,
            system_prompt,
            plugin_dir,
            ..
        } => {
            let plugin_dir = plugin_dir.or_else(|| {
                app.path()
                    .resource_dir()
                    .ok()
                    .map(|p| p.join("resources").join("charminal-plugin"))
            });
            SpawnSpec::Agent {
                agent,
                command,
                system_prompt,
                plugin_dir,
            }
        }
        shell @ SpawnSpec::Shell { .. } => shell,
    };
    let id = session_id.unwrap_or_else(|| sessions::DEFAULT_SESSION_ID.to_string());
    state.spawn(app, &id, cols, rows, cwd, &final_spec, on_output)
}

#[tauri::command]
async fn session_destroy(state: State<'_, PtyState>, session_id: String) -> Result<(), String> {
    state.kill(&session_id)
}

#[tauri::command]
async fn session_write(
    state: State<'_, PtyState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state.write_data(&session_id, &data)
}

#[tauri::command]
async fn session_resize(
    state: State<'_, PtyState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.resize(&session_id, cols, rows)
}

#[tauri::command]
async fn session_refresh_theme(
    state: State<'_, PtyState>,
    session_id: String,
) -> Result<(), String> {
    state.refresh_theme(&session_id)
}

#[tauri::command]
async fn session_attach(
    state: State<'_, PtyState>,
    session_id: String,
    cwd: Option<String>,
    on_output: Channel,
) -> Result<AttachResult, String> {
    Ok(state.attach(&session_id, cwd, on_output))
}

#[tauri::command]
async fn session_detach(state: State<'_, PtyState>, session_id: String) -> Result<(), String> {
    state.detach(&session_id);
    Ok(())
}

#[tauri::command]
async fn session_list(
    registry: State<'_, std::sync::Arc<sessions::SessionRegistry>>,
) -> Result<Vec<sessions::SessionDescriptor>, String> {
    Ok(registry.list())
}

/// `~/.yorishiro/journal/memories.md` の全文を返す。ファイルがなければ空文字列。
#[tauri::command]
fn read_journal_memories() -> Result<String, String> {
    journal::read_memories()
}

/// 直近 N 日分の journal エントリを返す。
#[tauri::command]
fn read_journal_recent(days: usize) -> Result<Vec<journal::JournalEntry>, String> {
    journal::read_recent(days)
}

#[tauri::command]
fn check_tutorial_done() -> bool {
    match yorishiro_home_path() {
        Ok(dir) => check_tutorial_done_impl(&dir),
        Err(_) => false,
    }
}

#[tauri::command]
fn mark_tutorial_done() -> Result<(), String> {
    let dir = yorishiro_home_path()?;
    mark_tutorial_done_impl(&dir)
}

// ─── Legacy pty_* commands ────────────────────────────────────────
//
// session_id を取らない旧 API。default-session に固定 dispatch する shim。
// 既存 caller (terminal-runtime.ts など) が C-1-3 で session_* に乗り換えれば
// この群は削除できる。

#[tauri::command]
async fn pty_write(state: State<'_, PtyState>, data: String) -> Result<(), String> {
    state.write_data(sessions::DEFAULT_SESSION_ID, &data)
}

#[tauri::command]
async fn pty_resize(state: State<'_, PtyState>, cols: u16, rows: u16) -> Result<(), String> {
    state.resize(sessions::DEFAULT_SESSION_ID, cols, rows)
}

#[tauri::command]
async fn pty_kill(state: State<'_, PtyState>) -> Result<(), String> {
    state.kill(sessions::DEFAULT_SESSION_ID)
}

/// Reconnect a new Channel to the default-session PTY (WebView HMR reload).
/// Returns replay bytes in the invoke response so live Channel output can stay raw.
#[tauri::command]
async fn pty_attach(
    state: State<'_, PtyState>,
    cwd: Option<String>,
    on_output: Channel,
) -> Result<AttachResult, String> {
    Ok(state.attach(sessions::DEFAULT_SESSION_ID, cwd, on_output))
}

/// Disconnect the output channel without killing the default-session PTY (WebView HMR cleanup).
#[tauri::command]
async fn pty_detach(state: State<'_, PtyState>) -> Result<(), String> {
    state.detach(sessions::DEFAULT_SESSION_ID);
    Ok(())
}

/// Drain queued hook signals (polling fallback for when Tauri emit doesn't reach webview).
#[tauri::command]
async fn poll_hook_signals() -> Vec<String> {
    pty::drain_hook_signals()
}

// ─── Charminal home dir (~/.yorishiro/) ─────────────────────────────
//
// User が自分で pack を置く場所。Phase 1-a では以下の convention：
//
//   ~/.yorishiro/
//   ├── init.js                         # 起動時 entry (~= init.el)
//   ├── packs/
//   │   └── <pack-id>/<kind>.js         # kind ∈ {effect, persona, voice, body, scene, ui}
//   │       <pack-id>/ui.tsx            # Plan 4 MVP: user UI pack source
//   ├── config.json                     # 将来の宣言的設定
//   ├── sdk.d.ts                        # Charminal が ship する IDE 用 type hint
//   └── sdk-guide.md                    # Charminal が ship する pack 作者向け narrative ガイド
//
// Philosophy: docs/philosophy/PHILOSOPHY.md「生きた系」
// Internal design-record: 2026-04-18-user-layer-runtime.md

const PACK_KINDS: &[&str] = &[
    "effect",
    "persona",
    "voice",
    "body",
    "scene",
    "ui",
    "ambient-ui",
    "amenity",
];

pub(crate) fn yorishiro_home_path() -> Result<std::path::PathBuf, String> {
    Ok(yorishiro_home_path_under(&home_dir_or_err()?))
}

fn yorishiro_home_path_under(home_root: &Path) -> PathBuf {
    home_root.join(".yorishiro")
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
    std::fs::create_dir_all(charminal_dir).map_err(|e| format!("~/.yorishiro/ 作成失敗: {}", e))?;
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
    source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    manifest: Option<UserPackManifestSummary>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct UserPackManifestSummary {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    entry: String,
    #[serde(rename = "executionClass", skip_serializing_if = "Option::is_none")]
    execution_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    author: Option<String>,
    /// 能力ラダーの sandbox 宣言。Rust 側は素通しし、検証は TS（pack-execution-policy）が行う。
    #[serde(skip_serializing_if = "Option::is_none")]
    sandbox: Option<serde_json::Value>,
}

/// Absolute path to ~/.yorishiro/. Does not create it.
#[tauri::command]
async fn charminal_home_dir() -> Result<String, String> {
    Ok(yorishiro_home_path()?.to_string_lossy().to_string())
}

/// Resolve a command through Charminal's launch PATH. Used by first-run health
/// checks to explain missing Claude Code / Codex binaries before PTY spawn.
#[tauri::command]
async fn resolve_command_path(command: String) -> Result<Option<String>, String> {
    Ok(resolve_command_path_impl(&command))
}

/// cwd を canonicalize し、git repo なら project root、linked worktree なら本体 repo root に解決する。
#[tauri::command]
async fn resolve_project_root(cwd: String) -> Result<String, String> {
    resolve_project_root_impl(Path::new(&cwd)).map(|p| p.to_string_lossy().to_string())
}

/// 登録済み terminal agent adapter の一覧を返す。
#[tauri::command]
fn list_supported_agents() -> Vec<sessions::agent_adapter::AgentDescriptor> {
    sessions::agent_adapter::descriptors()
}

/// Return the MCP server startup result captured during Tauri setup.
#[tauri::command]
async fn mcp_server_status(
    state: State<'_, McpServerStatus>,
) -> Result<McpServerStatusSnapshot, String> {
    state
        .0
        .lock()
        .map(|status| status.clone())
        .map_err(|_| "mcp status lock poisoned".to_string())
}

/// SDK `.d.ts` ファイル一式。compile 時に bundle に含める。
///
/// Phase 1-a では ensure_charminal_dirs() のたびに ~/.yorishiro/sdk.d.ts を
/// 上書きする（user は編集しない前提）。ファイル間の `import type { ... }
/// from "./..."` と `export * from "./..."` は single-file bundle では解決
/// できないので emit 時に drop する。
const SDK_DTS_PARTS: &[(&str, &str)] = &[
    ("reaction.d.ts", include_str!("../../src/sdk/reaction.d.ts")),
    ("context.d.ts", include_str!("../../src/sdk/context.d.ts")),
    ("history.d.ts", include_str!("../../src/sdk/history.d.ts")),
    ("persona.d.ts", include_str!("../../src/sdk/persona.d.ts")),
    ("amenity.d.ts", include_str!("../../src/sdk/amenity.d.ts")),
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

/// Pack 作者向け narrative ガイド（`src/sdk/README.md`）を compile 時に bundle へ含め、
/// 起動時に `~/.yorishiro/sdk-guide.md` として書き出す。
///
/// production の packaged app には source tree（`src/sdk/`）が無いため、住人 AI が
/// `read_bundled_pack_source` でも届かないこの narrative を読めるよう、`sdk.d.ts`
/// （型のみ）と同じ要領で `~/.yorishiro/` に並べる。型の shape は `sdk.d.ts`、
/// idiom や設計意図の散文はこちらが担う。
///
/// 先頭に do-not-edit の markdown コメントを付ける（`sdk.d.ts` の header と対称。
/// 毎起動で overwrite される）。README 内の相対リンクは `~/.yorishiro/` からは
/// 解決しないが、目的は narrative 本文なので許容する。
fn build_bundled_sdk_guide() -> String {
    let mut out = String::from(
        "<!--\n\
         Charminal SDK guide — auto-bundled from src/sdk/README.md at build time.\n\
         Charminal overwrites this file on every startup; do not edit it directly.\n\
         Relative links in this document point at the Charminal source tree and may\n\
         not resolve from ~/.yorishiro/.\n\
         -->\n\n",
    );
    out.push_str(include_str!("../../src/sdk/README.md"));
    out
}

/// ~/.yorishiro/init.js が無いときに seed する雛形。
///
/// sdk.d.ts とは違い、init.js は user の編集対象なので「**存在しないとき
/// だけ** 書く」。user が編集した内容を Charminal が上書きすることは無い。
/// 詳細: docs/decisions/user-init-script-seed.md
const USER_INIT_TEMPLATE: &str = include_str!("../resources/user-init-template.js");

/// `~/.yorishiro/init.js` が無ければ template を write する。既存 file には
/// 絶対触れない（user が消したものを復活させず、編集も保護する）。test が
/// env var を触らずに済むよう home を引数化している。
fn seed_user_init_script_impl(home: &std::path::Path) -> Result<(), String> {
    let path = home.join("init.js");
    if path.exists() {
        return Ok(());
    }
    std::fs::write(&path, USER_INIT_TEMPLATE)
        .map_err(|e| format!("Failed to seed ~/.yorishiro/init.js: {}", e))
}

/// Create ~/.yorishiro/ + ~/.yorishiro/packs/ and refresh sdk.d.ts / sdk-guide.md.
/// Idempotent.
///
/// sdk.d.ts（型の shape）と sdk-guide.md（pack 作者向け narrative）は user の IDE /
/// 住人 AI が Charminal SDK を知るためのヒントファイル。毎起動で overwrite する
/// （user は編集対象ではない）。init.js は逆に、無ければ雛形を seed するが存在すれば
/// 触らない。
#[tauri::command]
async fn ensure_charminal_dirs() -> Result<(), String> {
    let home = yorishiro_home_path()?;
    std::fs::create_dir_all(home.join("packs"))
        .map_err(|e| format!("Failed to create ~/.yorishiro/packs: {}", e))?;
    std::fs::write(home.join("sdk.d.ts"), build_bundled_sdk_dts())
        .map_err(|e| format!("Failed to write ~/.yorishiro/sdk.d.ts: {}", e))?;
    std::fs::write(home.join("sdk-guide.md"), build_bundled_sdk_guide())
        .map_err(|e| format!("Failed to write ~/.yorishiro/sdk-guide.md: {}", e))?;
    seed_user_init_script_impl(&home)?;
    // shell integration files (init.zsh / wrapper rc / etc) — idempotent。
    // 失敗しても他の dir 作成は完了しているので fatal にはせず log のみ。
    if let Err(e) = sessions::ensure_shell_files(&home) {
        eprintln!("[ensure_charminal_dirs] shell integration files: {}", e);
    }
    let home_root = home_dir_or_err().ok();
    if let Some(home_root) = home_root.as_ref() {
        if let Err(e) = history::ensure_snapshot_repo_impl(home_root) {
            eprintln!("[history] ensure snapshot repo failed: {}", e);
        }
    }

    // 起動時 baseline snapshot（once-per-process）。spec §0。失敗しても起動は止めない。
    // 直前 baseline から実変更が無い短時間の reload ではスキップしてノイズを減らす。
    static BASELINE_DONE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !BASELINE_DONE.swap(true, std::sync::atomic::Ordering::SeqCst) {
        if let Some(home_root) = home_root.as_ref() {
            if !history::should_skip_baseline(home_root, 60_000) {
                match history::snapshot_create_impl(home_root, "startup-baseline", None) {
                    Ok(seq) => {
                        // 直前 startup の clean 判定を advisory ラベルとして付ける（spec §0）。
                        // 自動 restore の根拠にはしない（あくまで表示用）。
                        if let Some(clean) = history::is_last_startup_clean(home_root) {
                            if let Err(e) = history::tag_startup_clean(home_root, seq, clean) {
                                eprintln!("[history] tag startup_clean failed: {}", e);
                            }
                        }
                    }
                    Err(e) => eprintln!("[history] baseline snapshot failed: {}", e),
                }
            }
        }
    }
    Ok(())
}

/// Scan ~/.yorishiro/packs/ and return discovered packs.
///
/// Convention: ~/.yorishiro/packs/<id>/<kind>.js where kind is one of PACK_KINDS.
/// UI / scene packs also support runtime-transpiled .tsx entries.
/// Multiple kind files in one pack directory produce multiple entries.
/// Missing directory returns empty vec (not an error).
#[tauri::command]
async fn list_user_packs() -> Result<Vec<UserPackEntry>, String> {
    let packs_dir = yorishiro_home_path()?.join("packs");
    discover_user_pack_entries(&packs_dir)
}

fn entry_file_for_kind(pack_dir: &Path, kind: &str) -> Option<PathBuf> {
    let js_entry = pack_dir.join(format!("{}.js", kind));
    if js_entry.is_file() {
        return Some(js_entry);
    }
    if kind == "ui" || kind == "scene" {
        let tsx_entry = pack_dir.join(format!("{}.tsx", kind));
        if tsx_entry.is_file() {
            return Some(tsx_entry);
        }
    }
    None
}

fn read_user_pack_manifest_summary(pack_dir: &Path) -> Option<UserPackManifestSummary> {
    let path = pack_dir.join("manifest.json");
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<UserPackManifestSummary>(&text).ok()
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
        let manifest = read_user_pack_manifest_summary(&pack_dir);
        for kind in PACK_KINDS {
            if let Some(entry_file) = entry_file_for_kind(&pack_dir, kind) {
                entries.push(UserPackEntry {
                    id: id.clone(),
                    kind: (*kind).to_string(),
                    entry_path: entry_file.to_string_lossy().to_string(),
                    source: "local",
                    manifest: manifest.as_ref().map(|m| UserPackManifestSummary {
                        id: m.id.clone(),
                        kind: m.kind.clone(),
                        entry: m.entry.clone(),
                        execution_class: m.execution_class.clone(),
                        description: m.description.clone(),
                        author: m.author.clone(),
                        sandbox: m.sandbox.clone(),
                    }),
                });
            }
        }
    }
    Ok(entries)
}

/// Read a text file from inside ~/.yorishiro/. Rejects paths outside the scope.
#[tauri::command]
async fn read_charminal_file(relative_path: String) -> Result<String, String> {
    let home = yorishiro_home_path()?;
    let full = home.join(&relative_path);
    let canonical_home = home
        .canonicalize()
        .map_err(|e| format!("Failed to canonicalize home: {}", e))?;
    let canonical_full = full
        .canonicalize()
        .map_err(|e| format!("File not found: {}", e))?;
    if !canonical_full.starts_with(&canonical_home) {
        return Err("Path escapes ~/.yorishiro/".into());
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

/// YORISHIRO_SAFE_MODE env var を読み、`'1'` のときのみ true を返す。
/// TS 側 runtime-wire が起動時に invoke する。
#[tauri::command]
async fn is_safe_mode() -> Result<bool, String> {
    let raw = std::env::var("YORISHIRO_SAFE_MODE").ok();
    Ok(is_safe_mode_value(raw.as_deref()))
}

/// `~/.yorishiro/<relative>` に atomic に text を書き出す実装本体。
/// テスト用に home を引数化する。
fn write_charminal_file_atomic_impl(
    relative_path: &str,
    content: &str,
    home_root: &Path,
) -> Result<(), String> {
    let charminal = yorishiro_home_path_under(home_root);
    std::fs::create_dir_all(&charminal)
        .map_err(|e| format!("Failed to ensure ~/.yorishiro: {}", e))?;

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
        return Err("Path escapes ~/.yorishiro/".into());
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

/// ~/.yorishiro/<relative> に atomic に text を書く。
/// TS 側から config.json / last-startup.json の write に使う。
#[tauri::command]
async fn write_charminal_file_atomic(relative_path: String, content: String) -> Result<(), String> {
    let home = home_dir_or_err()?;
    write_charminal_file_atomic_impl(&relative_path, &content, &home)
}

/// `~/.yorishiro/last-startup.json` を読む実装本体。テスト用に home 引数化。
/// MCP `list_load_errors` tool から crate 内参照するため pub(crate)。
pub(crate) fn read_last_startup_report_impl(home_root: &Path) -> Result<String, String> {
    let path = yorishiro_home_path_under(home_root).join("last-startup.json");
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("Read failed: {}", e))
}

/// `~/.yorishiro/last-startup.json` を読む。不在 → 空文字列。
/// MCP `list_load_errors` と TS 側 debug から使う。
#[tauri::command]
async fn read_last_startup_report() -> Result<String, String> {
    let home = home_dir_or_err()?;
    read_last_startup_report_impl(&home)
}

// ─── Bundled pack ソース取得 ─────────────────────────────────────────
//
// bundled-packs/ のソースコードを production binary に埋め込み、
// Tauri command 経由で取得できるようにする。AI agent（MCP 経由）や
// pack 作成 wizard が「既存 bundled pack のソースを例として参照する」
// ときに使う。ファイル内容は build.rs が自動生成する
// bundled_examples_gen.rs の include_str! で compile 時に確定する。

#[derive(serde::Serialize)]
struct BundledExampleFileResponse {
    path: String,
    content: String,
}

#[derive(serde::Serialize)]
struct BundledExamplePackResponse {
    id: String,
    kind: String,
    files: Vec<BundledExampleFileResponse>,
}

/// 指定 ID の bundled pack のソースファイル一式を返す。
/// 存在しない ID の場合は利用可能な ID リストを含むエラーを返す。
#[tauri::command]
async fn read_bundled_pack_source(id: String) -> Result<BundledExamplePackResponse, String> {
    use bundled_examples_gen::BUNDLED_EXAMPLES;

    for pack in BUNDLED_EXAMPLES {
        if pack.id == id {
            return Ok(BundledExamplePackResponse {
                id: pack.id.to_string(),
                kind: pack.kind.to_string(),
                files: pack
                    .files
                    .iter()
                    .map(|f| BundledExampleFileResponse {
                        path: f.path.to_string(),
                        content: f.content.to_string(),
                    })
                    .collect(),
            });
        }
    }

    let available: Vec<&str> = BUNDLED_EXAMPLES.iter().map(|p| p.id).collect();
    Err(format!(
        "Pack '{}' not found. Available: {:?}",
        id, available
    ))
}

/// 全 bundled pack の ID・kind ペア一覧を返す（ソース本文は含まない）。
#[tauri::command]
async fn list_bundled_pack_sources() -> Vec<BundledExamplePackResponse> {
    use bundled_examples_gen::BUNDLED_EXAMPLES;

    BUNDLED_EXAMPLES
        .iter()
        .map(|p| BundledExamplePackResponse {
            id: p.id.to_string(),
            kind: p.kind.to_string(),
            files: Vec::new(),
        })
        .collect()
}

/// `~/.yorishiro/init.js` があればパスを返す、なければ None。
/// 起動時に user's init.el 相当として load する対象。
#[tauri::command]
async fn user_init_script_path() -> Result<Option<String>, String> {
    let init_path = yorishiro_home_path()?.join("init.js");
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
// `~/.yorishiro/**` を recursive に監視し、debounced event を TS 層の Channel
// に流す。TS 側は event を受けて対応 pack を cache-bust + re-import + registry
// 経由で replace する。hot reload の主動脈。
//
// Philosophy: docs/philosophy/PHILOSOPHY.md「生きた系」
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

/// watcher-settled snapshot が index へ書き込まれた後に UI へ知らせる event。
#[derive(Clone, serde::Serialize)]
struct HistorySnapshotCreatedEvent {
    seq: u64,
    changed: Option<Vec<String>>,
}

/// File 1 枚の pending event（最後に届いた kind が勝つ）。
type PendingMap = Arc<Mutex<HashMap<PathBuf, notify::EventKind>>>;
type LayerEventFingerprint = (&'static str, u64);
type WatcherSnapshotSignature = Option<Vec<String>>;

const WATCHER_SNAPSHOT_DUPLICATE_WINDOW: Duration = Duration::from_millis(750);
const RESTORE_WATCHER_QUIET_WINDOW: Duration = Duration::from_secs(5);

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
    use notify::event::ModifyKind;
    use notify::EventKind::{Create, Modify, Remove};
    match kind {
        Create(_) => Some("created"),
        // snapshot 作成中の source read が atime 等の metadata-only modify として
        // 通知される環境がある。content/name 変更だけ hot-reload と snapshot 対象にする。
        Modify(ModifyKind::Data(_) | ModifyKind::Name(_) | ModifyKind::Any | ModifyKind::Other) => {
            Some("modified")
        }
        Modify(ModifyKind::Metadata(_)) => None,
        Remove(_) => Some("removed"),
        _ => None,
    }
}

/// path が ~/.yorishiro/{.history,.yorishiro-snapshots,.staging,tmp} 配下なら true（watcher で drop 対象）。
pub(crate) fn is_history_internal_path(charminal_home: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(charminal_home) else {
        return false;
    };
    matches!(
        rel.components().next(),
        Some(std::path::Component::Normal(seg))
            if seg == ".history" || seg == ".yorishiro-snapshots" || seg == ".staging" || seg == "tmp"
    )
}

fn is_snapshot_ignored_component(seg: &OsStr) -> bool {
    let name = seg.to_string_lossy();
    name == ".DS_Store" || name.ends_with(".resttmp")
}

fn is_user_pack_id(seg: &OsStr) -> bool {
    let id = seg.to_string_lossy();
    !id.starts_with('.') && !id.ends_with(".resttmp")
}

fn has_snapshot_ignored_component(charminal_home: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(charminal_home) else {
        return false;
    };
    rel.components().any(|component| {
        matches!(
            component,
            std::path::Component::Normal(seg) if is_snapshot_ignored_component(seg)
        )
    })
}

/// path が watcher trigger 対象（`packs/**` か top-level `init.js`）の変更なら
/// true。watcher-settled で自動 snapshot を撮るかどうかの判定に使う。
/// `.history`/`.staging`/`tmp`/`journal`/`sdk.d.ts`/`sdk-guide.md`/`last-startup.json` 等は false。
pub(crate) fn is_snapshot_relevant_path(charminal_home: &Path, path: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(charminal_home) else {
        return false;
    };
    if has_snapshot_ignored_component(charminal_home, path) {
        return false;
    }
    let mut comps = rel.components();
    match comps.next() {
        Some(std::path::Component::Normal(seg)) if seg == "packs" => match comps.next() {
            None => false,
            Some(std::path::Component::Normal(id)) => is_user_pack_id(id),
            _ => false,
        },
        // init.js は top-level の単一成分のみ対象。
        // config.json は git-tracked だが watcher trigger target ではない。
        Some(std::path::Component::Normal(seg)) if seg == "init.js" => comps.next().is_none(),
        _ => false,
    }
}

/// 変更 path から「変わった pack/ファイル」の帰属トークンを導出する（Scope C）。
/// `packs/<id>/...` → "<id>"、top-level `init.js` → その名前、
/// それ以外（packs 直下のみ・対象外 path）→ None。is_snapshot_relevant_path と対。
/// config.json は git-tracked だが watcher trigger target ではない。
pub(crate) fn snapshot_scope_token(charminal_home: &Path, path: &Path) -> Option<String> {
    if has_snapshot_ignored_component(charminal_home, path) {
        return None;
    }
    let rel = path.strip_prefix(charminal_home).ok()?;
    let mut comps = rel.components();
    match comps.next()? {
        std::path::Component::Normal(seg) if seg == "packs" => match comps.next() {
            Some(std::path::Component::Normal(id)) if is_user_pack_id(id) => {
                Some(id.to_string_lossy().to_string())
            }
            _ => None,
        },
        std::path::Component::Normal(seg) if seg == "init.js" => {
            comps.next().is_none().then(|| "init.js".to_string())
        }
        _ => None,
    }
}

/// settle バースト内の変更 path 群を watcher snapshot の `changed` field に変換する。
/// 同一 pack の複数 file は 1 要素へ dedup し、帰属できる path が無ければ None。
pub(crate) fn collect_changed_scopes<I, P>(charminal_home: &Path, paths: I) -> Option<Vec<String>>
where
    I: IntoIterator<Item = P>,
    P: AsRef<Path>,
{
    let changed_scopes: BTreeSet<String> = paths
        .into_iter()
        .filter_map(|path| snapshot_scope_token(charminal_home, path.as_ref()))
        .collect();
    if changed_scopes.is_empty() {
        None
    } else {
        Some(changed_scopes.into_iter().collect())
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

/// watcher の重複通知を path / label / mtime で間引く。
///
/// snapshot 作成が live source を読むだけで同じ mtime の modify 通知を返す環境が
/// あるため、snapshot 判定前に同一 fingerprint を落として再帰 snapshot を防ぐ。
fn should_emit_layer_event(
    last: &mut HashMap<PathBuf, LayerEventFingerprint>,
    path: &Path,
    label: &'static str,
    mtime_ms: u64,
) -> bool {
    let fingerprint = (label, mtime_ms);
    if last.get(path).copied() == Some(fingerprint) {
        return false;
    }
    last.insert(path.to_path_buf(), fingerprint);
    true
}

fn should_create_watcher_snapshot(
    last: &mut Option<(WatcherSnapshotSignature, Instant)>,
    changed: &WatcherSnapshotSignature,
    now: Instant,
) -> bool {
    if let Some((last_changed, last_at)) = last.as_ref() {
        if last_changed == changed
            && now.duration_since(*last_at) < WATCHER_SNAPSHOT_DUPLICATE_WINDOW
        {
            return false;
        }
    }
    *last = Some((changed.clone(), now));
    true
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

/// 指定 path の mtime を ms 単位で返す。`~/.yorishiro/` 外の path は拒否。
///
/// TS 層は watcher event で受け取った path を改めて stat することで、watcher の
/// 届ける mtime が古い場合の fallback とする（import URL の cache-bust 用途）。
#[tauri::command]
async fn stat_file_mtime(path: String) -> Result<u64, String> {
    let home = yorishiro_home_path()?;
    stat_mtime_in_scope(&PathBuf::from(path), &home)
}

/// `~/.yorishiro/` 配下を watch し、debounced file event を Channel で TS 層に流す。
///
/// 二重呼び出し時は旧 watcher を drop で畳む。`debounce` は 150ms——macOS の
/// fsevent は save 1 回で複数 event を吐くため、path ごとに last-wins で coalesce
/// する。
#[tauri::command]
async fn watch_charminal_layer(
    app: AppHandle,
    state: State<'_, WatcherState>,
    on_event: Channel<CharminalLayerEvent>,
) -> Result<(), String> {
    use notify::{Config, Event, RecommendedWatcher, RecursiveMode, Watcher};

    let home = yorishiro_home_path()?;
    std::fs::create_dir_all(home.join("packs"))
        .map_err(|e| format!("Failed to ensure ~/.yorishiro/packs: {}", e))?;

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
        .map_err(|e| format!("Failed to canonicalize ~/.yorishiro/: {}", e))?;

    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    let pending_bg = pending.clone();
    let channel = on_event;
    let app_handle = app.clone();

    let thread = std::thread::spawn(move || {
        let mut last_emitted: HashMap<PathBuf, LayerEventFingerprint> = HashMap::new();
        let mut last_watcher_snapshot: Option<(WatcherSnapshotSignature, Instant)> = None;
        loop {
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
            // この settle バーストに watcher trigger 対象（packs/** / init.js）の
            // 変更が含まれていたかを記録する。含まれていれば末尾で 1 枚だけ撮る。
            let mut snapshot_relevant = false;
            let mut changed_paths: Vec<PathBuf> = Vec::new();
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
                if is_history_internal_path(&home, &path) {
                    // snapshot store / staging / scratch の内部書き込みは TS に流さない。
                    continue;
                }
                let mtime_ms = path_mtime_ms(&path);
                if !should_emit_layer_event(&mut last_emitted, &path, label, mtime_ms) {
                    continue;
                }
                if is_snapshot_relevant_path(&home, &path) {
                    snapshot_relevant = true;
                    changed_paths.push(path.clone());
                }
                let payload = CharminalLayerEvent {
                    path: path.to_string_lossy().to_string(),
                    kind: label.to_string(),
                    mtime_ms,
                };
                if let Err(e) = channel.send(payload) {
                    eprintln!("[watch_charminal_layer] channel send failed: {}", e);
                    break;
                }
            }
            // 確定バーストに snapshot 対象変更があれば、settle 後の状態を 1 枚撮る。
            // snapshot は .yorishiro-snapshots/ へ書くので is_history_internal_path
            // filter により watcher へ戻らない（無限ループ無し）。
            // home（=~/.yorishiro）の parent が HOME（snapshot_*_impl の home_root）。
            if snapshot_relevant {
                if let Some(home_root) = home.parent() {
                    if history::restore_quiet_period_active(
                        home_root,
                        RESTORE_WATCHER_QUIET_WINDOW.as_millis() as u64,
                    ) {
                        continue;
                    }
                    let changed = collect_changed_scopes(&home, changed_paths.iter());
                    if !should_create_watcher_snapshot(
                        &mut last_watcher_snapshot,
                        &changed,
                        Instant::now(),
                    ) {
                        continue;
                    }
                    let event_changed = changed.clone();
                    match history::snapshot_create_with_changed_impl(
                        home_root,
                        "watcher-settled",
                        None,
                        changed,
                    ) {
                        Ok(seq) => {
                            let event = HistorySnapshotCreatedEvent {
                                seq,
                                changed: event_changed,
                            };
                            if let Err(e) =
                                app_handle.emit("charminal:history-snapshot-created", event)
                            {
                                eprintln!("[history] watcher-settled event emit failed: {}", e);
                            }
                        }
                        Err(e) => eprintln!("[history] watcher-settled snapshot failed: {}", e),
                    }
                }
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

/// `path` の拡張子が `.vrm`（大文字小文字無視）かどうか。
///
/// import_vrm は任意 path を AppData/avatars/ にコピーするため、拡張子を絞らないと
/// `~/.ssh/id_rsa` 等の任意ファイルを assetProtocol scope 内へ複製できてしまう。
fn has_vrm_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.eq_ignore_ascii_case("vrm"))
        .unwrap_or(false)
}

fn validate_vrm_glb_header(file: &mut std::fs::File, file_size: u64) -> Result<(), String> {
    let mut header = [0_u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| "VRM ファイルのGLBヘッダーを読み取れません".to_string())?;

    if &header[0..4] != b"glTF" {
        return Err("VRM ファイルのGLBヘッダーが不正です".into());
    }

    let version = u32::from_le_bytes(header[4..8].try_into().expect("header slice length"));
    if version != 2 {
        return Err(format!("未対応のGLBバージョンです: {}", version));
    }

    let declared_len = u32::from_le_bytes(header[8..12].try_into().expect("header slice length"));
    if u64::from(declared_len) != file_size {
        return Err("VRM ファイルのGLBサイズ宣言が不正です".into());
    }

    Ok(())
}

fn open_vrm_import_source(src_path: &Path) -> Result<(std::fs::File, String), String> {
    let meta = std::fs::symlink_metadata(src_path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "File not found".to_string()
        } else {
            format!("Failed to inspect file: {}", e)
        }
    })?;

    let file_type = meta.file_type();
    if file_type.is_symlink() {
        return Err("シンボリックリンクは VRM import できません".into());
    }
    if !file_type.is_file() {
        return Err("VRM import source must be a regular file".into());
    }
    if !has_vrm_extension(src_path) {
        return Err("VRM ファイル（.vrm）ではありません".into());
    }

    let file_name = src_path
        .file_name()
        .ok_or("Invalid file path")?
        .to_string_lossy()
        .to_string();

    let mut file =
        std::fs::File::open(src_path).map_err(|e| format!("Failed to open VRM: {}", e))?;
    validate_vrm_glb_header(&mut file, meta.len())?;
    file.seek(SeekFrom::Start(0))
        .map_err(|e| format!("Failed to rewind VRM: {}", e))?;

    Ok((file, file_name))
}

/// VRM file import: copy to $APPDATA/avatars/ and return the destination path.
#[tauri::command]
async fn import_vrm(app: AppHandle, src: String) -> Result<String, String> {
    let src_path = std::path::Path::new(&src);
    let (mut src_file, file_name) = open_vrm_import_source(src_path)?;

    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get AppData: {}", e))?;
    let avatars_dir = app_data.join("avatars");
    std::fs::create_dir_all(&avatars_dir)
        .map_err(|e| format!("Failed to create directory: {}", e))?;

    let dest = avatars_dir.join(&file_name);
    let mut dest_file = std::fs::File::create(&dest).map_err(|e| format!("Copy failed: {}", e))?;
    std::io::copy(&mut src_file, &mut dest_file).map_err(|e| format!("Copy failed: {}", e))?;

    Ok(dest.to_string_lossy().to_string())
}

#[cfg(test)]
mod import_vrm_tests {
    use super::{has_vrm_extension, open_vrm_import_source};
    use std::fs;
    use std::path::{Path, PathBuf};

    fn tmp_dir(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-import-vrm-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("mkdir");
        tmp
    }

    fn minimal_glb_bytes() -> Vec<u8> {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"glTF");
        bytes.extend_from_slice(&2_u32.to_le_bytes());
        bytes.extend_from_slice(&12_u32.to_le_bytes());
        bytes
    }

    #[test]
    fn accepts_vrm_extension() {
        assert!(has_vrm_extension(Path::new("/some/dir/avatar.vrm")));
    }

    #[test]
    fn accepts_vrm_extension_case_insensitive() {
        assert!(has_vrm_extension(Path::new("/some/dir/Avatar.VRM")));
    }

    #[test]
    fn rejects_non_vrm_extension() {
        assert!(!has_vrm_extension(Path::new("/home/user/.ssh/id_rsa")));
        assert!(!has_vrm_extension(Path::new("/some/dir/photo.png")));
    }

    #[test]
    fn rejects_missing_extension() {
        assert!(!has_vrm_extension(Path::new("/some/dir/noext")));
    }

    #[test]
    fn validates_regular_vrm_glb_source() {
        let dir = tmp_dir("regular");
        let path = dir.join("avatar.vrm");
        fs::write(&path, minimal_glb_bytes()).expect("write");

        let (_file, file_name) = open_vrm_import_source(&path).expect("valid source");
        assert_eq!(file_name, "avatar.vrm");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_non_glb_vrm_file() {
        let dir = tmp_dir("non-glb");
        let path = dir.join("avatar.vrm");
        fs::write(&path, b"not a glb").expect("write");

        let result = open_vrm_import_source(&path);
        assert!(result.is_err(), "GLB ではない .vrm は拒否されるべき");

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_directory_named_vrm() {
        let dir = tmp_dir("directory");
        let path = dir.join("avatar.vrm");
        fs::create_dir_all(&path).expect("mkdir");

        let result = open_vrm_import_source(&path);
        assert!(result.is_err(), "directory は import できてはならない");

        let _ = fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_named_vrm() {
        use std::os::unix::fs::symlink;

        let dir = tmp_dir("symlink");
        let target = dir.join("secret");
        let link = dir.join("avatar.vrm");
        fs::write(&target, minimal_glb_bytes()).expect("write");
        symlink(&target, &link).expect("symlink");

        let result = open_vrm_import_source(&link);
        assert!(result.is_err(), "symlink は import できてはならない");

        let _ = fs::remove_dir_all(&dir);
    }
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .manage(pty_state)
        .manage(registry)
        .manage(WatcherState::new())
        .manage(tts::TtsState::new())
        .manage(McpServerStatus::default())
        .invoke_handler(tauri::generate_handler![
            prepare_localized_plugin_dir,
            resolve_command_path,
            resolve_project_root,
            list_supported_agents,
            mcp_server_status,
            session_spawn,
            session_destroy,
            session_write,
            session_resize,
            session_refresh_theme,
            session_attach,
            session_detach,
            session_list,
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
            read_journal_recent,
            check_tutorial_done,
            mark_tutorial_done,
            tts::tts_speak,
            tts::tts_stop,
            tts::tts_synthesize,
            read_bundled_pack_source,
            list_bundled_pack_sources,
            history::snapshot_create,
            history::snapshot_list,
            history::snapshot_restore,
            history::snapshot_prune,
            system_exec
        ])
        .setup(|app| {
            if let Err(e) = pty::ensure_reminder_script() {
                eprintln!("[reminder] script 配置失敗: {e}");
            }
            start_hook_server(app.handle().clone());
            let mcp_handle = app.handle().clone();
            match mcp::spawn_server(mcp_handle) {
                Ok(port) => {
                    if let Ok(mut status) = app.state::<McpServerStatus>().0.lock() {
                        *status = McpServerStatusSnapshot {
                            port: Some(port),
                            error: None,
                        };
                    }
                    eprintln!("[yorishiro-mcp] listening on localhost:{}", port);
                }
                Err(err) => {
                    if let Ok(mut status) = app.state::<McpServerStatus>().0.lock() {
                        *status = McpServerStatusSnapshot {
                            port: None,
                            error: Some(err.clone()),
                        };
                    }
                    eprintln!("[yorishiro-mcp] startup skipped: {}", err);
                }
            }

            // config.json の mediaFolders を asset protocol scope に追加
            register_media_folder_scopes(app);

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
                    let persona_id = "clai-ja";
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

    #[test]
    fn guide_contains_narrative_and_do_not_edit_header() {
        let guide = super::build_bundled_sdk_guide();
        // src/sdk/README.md の narrative がそのまま載っている
        assert!(guide.contains("@charminal/sdk"));
        assert!(guide.contains("twin-trigger co-emission"));
        // 自動生成・編集禁止の注記が markdown コメントとして先頭に付く
        assert!(guide.starts_with("<!--"));
        assert!(guide.contains("do not edit"));
    }
}

#[cfg(test)]
mod user_pack_discovery_tests {
    use super::{discover_user_pack_entries, entry_file_for_kind};
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

    #[test]
    fn discovers_scene_tsx_when_scene_js_is_absent() {
        let packs = fresh_packs_dir("scene-tsx");
        let pack_dir = packs.join("my-room");
        fs::create_dir_all(&pack_dir).expect("create pack dir");
        fs::write(pack_dir.join("scene.tsx"), "export default {};\n").expect("write scene.tsx");

        let entry = entry_file_for_kind(&pack_dir, "scene").expect("scene entry");
        assert!(entry.ends_with("scene.tsx"));

        let entries = discover_user_pack_entries(&packs).expect("discover ok");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, "my-room");
        assert_eq!(entries[0].kind, "scene");
        assert!(entries[0].entry_path.ends_with("/my-room/scene.tsx"));

        let _ = fs::remove_dir_all(&packs);
    }

    #[test]
    fn prefers_scene_js_over_scene_tsx_for_compatibility() {
        let packs = fresh_packs_dir("scene-js-precedence");
        let pack_dir = packs.join("my-room");
        fs::create_dir_all(&pack_dir).expect("create pack dir");
        fs::write(pack_dir.join("scene.js"), "export default {};\n").expect("write scene.js");
        fs::write(pack_dir.join("scene.tsx"), "export default {};\n").expect("write scene.tsx");

        let entry = entry_file_for_kind(&pack_dir, "scene").expect("scene entry");
        assert!(entry.ends_with("scene.js"));

        let entries = discover_user_pack_entries(&packs).expect("discover ok");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "scene");
        assert!(entries[0].entry_path.ends_with("/my-room/scene.js"));

        let _ = fs::remove_dir_all(&packs);
    }

    #[test]
    fn includes_manifest_execution_class_summary_when_present() {
        let packs = fresh_packs_dir("manifest-summary");
        let pack_dir = packs.join("my-effect");
        fs::create_dir_all(&pack_dir).expect("create pack dir");
        fs::write(pack_dir.join("effect.js"), "export default {};\n").expect("write effect.js");
        fs::write(
            pack_dir.join("manifest.json"),
            r#"{
              "id": "my-effect",
              "type": "effect",
              "version": "0.1.0",
              "charminalVersion": "^0.1.0",
              "executionClass": "trusted-main-thread-js",
              "entry": "effect.js"
            }"#,
        )
        .expect("write manifest");

        let entries = discover_user_pack_entries(&packs).expect("discover ok");

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].source, "local");
        let manifest = entries[0].manifest.as_ref().expect("manifest summary");
        assert_eq!(manifest.id, "my-effect");
        assert_eq!(manifest.kind, "effect");
        assert_eq!(manifest.entry, "effect.js");
        assert_eq!(
            manifest.execution_class.as_deref(),
            Some("trusted-main-thread-js")
        );

        let _ = fs::remove_dir_all(&packs);
    }

    #[test]
    fn includes_manifest_sandbox_summary_when_present() {
        let packs = fresh_packs_dir("manifest-sandbox-summary");
        let pack_dir = packs.join("my-effect");
        fs::create_dir_all(&pack_dir).expect("create pack dir");
        fs::write(pack_dir.join("effect.js"), "export default {};\n").expect("write effect.js");
        fs::write(
            pack_dir.join("manifest.json"),
            r#"{
              "id": "my-effect",
              "type": "effect",
              "version": "0.1.0",
              "charminalVersion": "^0.1.0",
              "executionClass": "trusted-main-thread-js",
              "sandbox": { "backend": "wasm" },
              "entry": "effect.js"
            }"#,
        )
        .expect("write manifest");

        let entries = discover_user_pack_entries(&packs).expect("discover ok");
        let manifest = entries[0].manifest.as_ref().expect("manifest summary");
        let sandbox = manifest.sandbox.as_ref().expect("sandbox passthrough");
        assert_eq!(sandbox["backend"], "wasm");

        let _ = fs::remove_dir_all(&packs);
    }
}

#[cfg(test)]
mod layer_scope_tests {
    use super::{
        collect_changed_scopes, command_candidate_names, is_history_internal_path,
        is_safe_mode_value, is_snapshot_relevant_path, layer_event_label,
        read_last_startup_report_impl, resolve_command_path_impl, resolve_project_root_impl,
        should_create_watcher_snapshot, should_emit_layer_event, snapshot_scope_token,
        stat_mtime_in_scope, write_charminal_file_atomic_impl,
    };
    use git2::{Repository, Signature};
    use std::collections::HashMap;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{Duration, Instant};

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
    fn resolve_command_path_rejects_empty_or_path_like_commands() {
        assert_eq!(resolve_command_path_impl(""), None);
        assert_eq!(resolve_command_path_impl("  "), None);
        assert_eq!(resolve_command_path_impl("bin/claude"), None);
        assert_eq!(resolve_command_path_impl("bin\\claude"), None);
    }

    fn canonical(path: &Path) -> PathBuf {
        path.canonicalize().expect("canonicalize path")
    }

    fn run_git(cwd: &Path, args: &[&str]) {
        let output = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn run_git_at(args: &[&str]) {
        let output = Command::new("git").args(args).output().expect("run git");
        assert!(
            output.status.success(),
            "git {:?} failed\nstdout:\n{}\nstderr:\n{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn git_commit_all(cwd: &Path) {
        run_git(cwd, &["add", "."]);
        run_git(
            cwd,
            &[
                "-c",
                "user.name=charminal-test",
                "-c",
                "user.email=test@charminal.local",
                "commit",
                "-m",
                "initial",
            ],
        );
    }

    fn init_repo_with_commit(root: &Path) -> Repository {
        fs::create_dir_all(root).expect("create repo root");
        let repo = Repository::init(root).expect("init git repo");
        fs::write(root.join("README.md"), "hello\n").expect("write readme");
        let mut index = repo.index().expect("open index");
        index.add_path(Path::new("README.md")).expect("add readme");
        index.write().expect("write index");
        let tree_id = index.write_tree().expect("write tree");
        let tree = repo.find_tree(tree_id).expect("find tree");
        let sig = Signature::now("charminal-test", "test@charminal.local").expect("signature");
        repo.commit(Some("HEAD"), &sig, &sig, "initial", &tree, &[])
            .expect("commit");
        drop(tree);
        repo
    }

    #[test]
    fn resolve_project_root_returns_cwd_for_plain_directory() {
        let root = fresh_dir("project-root-plain");
        let nested = root.join("nested");
        fs::create_dir_all(&nested).expect("create nested");

        let resolved = resolve_project_root_impl(&nested).expect("resolve project root");

        assert_eq!(resolved, canonical(&nested));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_project_root_returns_git_workdir_for_repo_child() {
        let root = fresh_dir("project-root-git");
        let repo_root = root.join("repo");
        init_repo_with_commit(&repo_root);
        let nested = repo_root.join("src").join("app");
        fs::create_dir_all(&nested).expect("create nested");

        let resolved = resolve_project_root_impl(&nested).expect("resolve project root");

        assert_eq!(resolved, canonical(&repo_root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_project_root_collapses_linked_worktree_to_main_workdir() {
        let root = fresh_dir("project-root-worktree");
        let main_root = root.join("main");
        let linked_root = root.join("linked");
        let repo = init_repo_with_commit(&main_root);
        repo.worktree("linked", &linked_root, None)
            .expect("create linked worktree");
        let nested = linked_root.join("src");
        fs::create_dir_all(&nested).expect("create nested");

        let resolved = resolve_project_root_impl(&nested).expect("resolve project root");

        assert_eq!(resolved, canonical(&main_root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_project_root_collapses_separate_git_dir_worktree_to_main_workdir() {
        let root = fresh_dir("project-root-separate-git-worktree");
        let main_root = root.join("main");
        let git_store = root.join("store.git");
        let linked_root = root.join("linked");
        fs::create_dir_all(&main_root).expect("create main root");
        run_git(
            &main_root,
            &[
                "init",
                "--separate-git-dir",
                git_store.to_str().expect("git store path"),
            ],
        );
        fs::write(main_root.join("README.md"), "hello\n").expect("write readme");
        git_commit_all(&main_root);
        run_git(
            &main_root,
            &[
                "worktree",
                "add",
                linked_root.to_str().expect("linked path"),
            ],
        );
        let nested = linked_root.join("src");
        fs::create_dir_all(&nested).expect("create nested");

        let resolved = resolve_project_root_impl(&nested).expect("resolve project root");

        assert_eq!(resolved, canonical(&main_root));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_project_root_degrades_bare_repo_worktree_to_worktree_cwd() {
        let root = fresh_dir("project-root-bare-worktree");
        let source_root = root.join("source");
        let bare_root = root.join("bare.git");
        let linked_root = root.join("linked");
        init_repo_with_commit(&source_root);
        run_git_at(&[
            "clone",
            "--bare",
            source_root.to_str().expect("source path"),
            bare_root.to_str().expect("bare path"),
        ]);
        run_git_at(&[
            "--git-dir",
            bare_root.to_str().expect("bare path"),
            "worktree",
            "add",
            linked_root.to_str().expect("linked path"),
        ]);
        let nested = linked_root.join("src");
        fs::create_dir_all(&nested).expect("create nested");

        let resolved = resolve_project_root_impl(&nested).expect("resolve project root");

        assert_eq!(resolved, canonical(&nested));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn build_path_env_includes_opencode_install_dir_on_unix() {
        if cfg!(windows) {
            return;
        }
        let path = super::build_path_env();
        assert!(
            path.contains("/.opencode/bin"),
            "PATH should include ~/.opencode/bin, got {path}"
        );
    }

    #[test]
    fn command_candidate_names_keeps_plain_command_on_unix() {
        assert_eq!(command_candidate_names("codex"), vec!["codex".to_string()]);
    }

    #[test]
    fn layer_event_label_maps_create_modify_remove_and_ignores_the_rest() {
        use notify::event::{
            AccessKind, CreateKind, DataChange, MetadataKind, ModifyKind, RemoveKind, RenameMode,
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
            layer_event_label(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::Any))),
            None,
        );
        assert_eq!(
            layer_event_label(&EventKind::Remove(RemoveKind::File)),
            Some("removed"),
        );
        assert_eq!(layer_event_label(&EventKind::Access(AccessKind::Any)), None,);
        assert_eq!(layer_event_label(&EventKind::Any), None);
        assert_eq!(layer_event_label(&EventKind::Other), None);
    }

    #[test]
    fn watcher_event_fingerprint_drops_same_path_label_and_mtime_only() {
        let mut last = HashMap::new();
        let path = std::path::Path::new("/Users/x/.yorishiro/packs/foo/amenity.js");

        assert!(should_emit_layer_event(&mut last, path, "modified", 100));
        assert!(!should_emit_layer_event(&mut last, path, "modified", 100));
        assert!(should_emit_layer_event(&mut last, path, "modified", 101));
        assert!(should_emit_layer_event(&mut last, path, "removed", 0));
    }

    #[test]
    fn history_paths_are_excluded_from_watch() {
        let home = std::path::Path::new("/Users/x/.yorishiro");
        // 旧 full-copy store が残っていても内部書き込みとして除外する。
        assert!(is_history_internal_path(
            home,
            std::path::Path::new(
                "/Users/x/.yorishiro/.history/generations/000001/packs/foo/effect.js"
            )
        ));
        assert!(is_history_internal_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/.yorishiro-snapshots/objects/ab/cdef")
        ));
        assert!(is_history_internal_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/.staging/foo/effect.js")
        ));
        assert!(is_history_internal_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/tmp/scratch")
        ));
        // 通常の pack は除外しない。
        assert!(!is_history_internal_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/packs/foo/effect.js")
        ));
        assert!(!is_history_internal_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/config.json")
        ));
    }

    #[test]
    fn snapshot_relevant_path_matches_packs_config_initjs_only() {
        let home = std::path::Path::new("/Users/x/.yorishiro");
        // packs 配下は対象。
        assert!(is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/packs/foo/effect.js")
        ));
        // packs ディレクトリ自体の mtime だけでは何が変わったかを説明できないため対象外。
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/packs")
        ));
        // packs root の Finder dotfile は user-facing 変更ではない。
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/packs/.DS_Store")
        ));
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/packs/..DS_Store.resttmp")
        ));
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/packs/foo/.effect.js.resttmp")
        ));
        // config.json は git-tracked だが watcher trigger target ではない。
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/config.json")
        ));
        // init.js は対象。
        assert!(is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/init.js")
        ));
        // 対象外：journal / sdk.d.ts / last-startup.json / snapshot store。
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/journal/daily/2026-06-02.md")
        ));
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/sdk.d.ts")
        ));
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/last-startup.json")
        ));
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/.history/generations/000001/config.json")
        ));
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/.yorishiro-snapshots/HEAD")
        ));
        // config.json と同名でも sub-path は対象外（config.json/something のような異常系）。
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/x/.yorishiro/config.json/inner")
        ));
        // home 外は対象外。
        assert!(!is_snapshot_relevant_path(
            home,
            std::path::Path::new("/Users/y/other/packs/foo.js")
        ));
    }

    #[test]
    fn snapshot_scope_token_extracts_pack_id_and_files() {
        let home = Path::new("/Users/x/.yorishiro");
        assert_eq!(
            snapshot_scope_token(
                home,
                Path::new("/Users/x/.yorishiro/packs/my-theme/scene.js")
            ),
            Some("my-theme".to_string())
        );
        assert_eq!(
            snapshot_scope_token(home, Path::new("/Users/x/.yorishiro/config.json")),
            None
        );
        assert_eq!(
            snapshot_scope_token(home, Path::new("/Users/x/.yorishiro/init.js")),
            Some("init.js".to_string())
        );
        // 対象外・packs 直下のみは None。
        assert_eq!(
            snapshot_scope_token(home, Path::new("/Users/x/.yorishiro/journal/x.md")),
            None
        );
        assert_eq!(
            snapshot_scope_token(home, Path::new("/Users/x/.yorishiro/packs")),
            None
        );
        assert_eq!(
            snapshot_scope_token(home, Path::new("/Users/x/.yorishiro/packs/.DS_Store")),
            None
        );
        assert_eq!(
            snapshot_scope_token(
                home,
                Path::new("/Users/x/.yorishiro/packs/..DS_Store.resttmp")
            ),
            None
        );
        assert_eq!(
            snapshot_scope_token(
                home,
                Path::new("/Users/x/.yorishiro/packs/foo/.scene.js.resttmp")
            ),
            None
        );
    }

    #[test]
    fn collect_changed_scopes_dedups_and_sorts_pack_ids() {
        let home = Path::new("/Users/x/.yorishiro");
        let paths = [
            Path::new("/Users/x/.yorishiro/packs/b/effect.js"),
            Path::new("/Users/x/.yorishiro/packs/a/effect.js"),
            Path::new("/Users/x/.yorishiro/packs/a/assets/icon.png"),
        ];

        assert_eq!(
            collect_changed_scopes(home, paths),
            Some(vec!["a".to_string(), "b".to_string()])
        );
    }

    #[test]
    fn collect_changed_scopes_records_init_and_returns_none_when_empty() {
        let home = Path::new("/Users/x/.yorishiro");
        let paths = [
            Path::new("/Users/x/.yorishiro/packs/theme/scene.js"),
            Path::new("/Users/x/.yorishiro/config.json"),
            Path::new("/Users/x/.yorishiro/init.js"),
        ];

        assert_eq!(
            collect_changed_scopes(home, paths),
            Some(vec!["init.js".to_string(), "theme".to_string()])
        );
        assert_eq!(
            collect_changed_scopes(
                home,
                [
                    Path::new("/Users/x/.yorishiro/packs"),
                    Path::new("/Users/x/.yorishiro/journal/x.md"),
                    Path::new("/Users/x/.yorishiro/packs/foo/.scene.js.resttmp"),
                ],
            ),
            None
        );
    }

    #[test]
    fn watcher_snapshot_suppresses_identical_short_bursts() {
        let mut last = None;
        let now = Instant::now();
        let theme = Some(vec!["theme".to_string()]);
        let init = Some(vec!["init.js".to_string()]);

        assert!(should_create_watcher_snapshot(&mut last, &theme, now));
        assert!(!should_create_watcher_snapshot(
            &mut last,
            &theme,
            now + Duration::from_millis(50)
        ));
        assert!(should_create_watcher_snapshot(
            &mut last,
            &init,
            now + Duration::from_millis(60)
        ));
        assert!(should_create_watcher_snapshot(
            &mut last,
            &init,
            now + Duration::from_secs(1)
        ));
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
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let tmp_home = fresh_dir("atomic-write");
        std::env::set_var("HOME", &tmp_home);

        // valid path inside ~/.yorishiro/ should succeed
        let result =
            write_charminal_file_atomic_impl("last-startup.json", "{\"ok\":true}", &tmp_home);
        assert!(result.is_ok(), "expected ok, got {:?}", result);

        let written =
            std::fs::read_to_string(tmp_home.join(".yorishiro").join("last-startup.json"))
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
        let charminal = tmp_home.join(".yorishiro");
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
mod localized_plugin_dir_tests {
    use super::{
        convert_command_to_codex_skill, prepare_localized_plugin_dir_at, write_codex_plugin_cache,
    };
    use std::fs;
    use std::path::{Path, PathBuf};

    fn fresh_dir(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "yorishiro-localized-plugin-{}-{}-{}",
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

    fn write_fixture(root: &Path) {
        fs::create_dir_all(root.join(".claude-plugin")).expect("create plugin meta");
        fs::create_dir_all(root.join(".codex-plugin")).expect("create codex plugin meta");
        fs::create_dir_all(root.join("commands-en")).expect("create commands-en");
        fs::create_dir_all(root.join("commands-ja")).expect("create commands-ja");
        fs::write(
            root.join(".claude-plugin").join("plugin.json"),
            "{\"name\":\"charm\"}",
        )
        .expect("write plugin json");
        fs::write(
            root.join(".codex-plugin").join("plugin.json"),
            "{\"name\":\"charm\",\"skills\":\"./skills/\"}",
        )
        .expect("write codex plugin json");
        fs::write(
            root.join("commands-en").join("help.md"),
            "---\ndescription: Help reference\nargument-hint: \"[topic]\"\n---\n\n$ARGUMENTS\n\n---\n\nEnglish help content.",
        )
        .expect("write en help");
        fs::write(
            root.join("commands-en").join("create.md"),
            "---\ndescription: Create a pack\nargument-hint: \"[what]\"\n---\n\n$ARGUMENTS\n\n---\n\nEnglish create content.",
        )
        .expect("write en create");
        fs::write(
            root.join("commands-ja").join("help.md"),
            "---\ndescription: ヘルプ\nargument-hint: \"[トピック]\"\n---\n\n$ARGUMENTS\n\n---\n\n日本語ヘルプ。",
        )
        .expect("write ja help");
    }

    fn command_files(target: &Path) -> Vec<String> {
        let mut files = fs::read_dir(target.join("commands"))
            .expect("read commands")
            .map(|entry| {
                entry
                    .expect("entry")
                    .file_name()
                    .to_string_lossy()
                    .to_string()
            })
            .collect::<Vec<_>>();
        files.sort();
        files
    }

    #[test]
    fn copies_selected_language_commands_and_metadata() {
        let tmp = fresh_dir("ja");
        let resource = tmp.join("resource");
        let target = tmp.join("runtime-plugin");
        write_fixture(&resource);

        prepare_localized_plugin_dir_at(&resource, &target, "ja").expect("prepare ok");

        assert_eq!(
            fs::read_to_string(target.join(".claude-plugin").join("plugin.json"))
                .expect("read plugin json"),
            "{\"name\":\"charm\"}"
        );
        assert!(!target.join(".mcp.json").exists());
        assert_eq!(command_files(&target), vec!["help.md"]);
        let help_content =
            fs::read_to_string(target.join("commands").join("help.md")).expect("read help");
        assert!(help_content.contains("ヘルプ"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn replaces_stale_commands_and_falls_back_to_english() {
        let tmp = fresh_dir("fallback");
        let resource = tmp.join("resource");
        let target = tmp.join("runtime-plugin");
        write_fixture(&resource);
        fs::create_dir_all(target.join("commands")).expect("create stale commands");
        fs::write(target.join("commands").join("old.md"), "stale").expect("write stale");

        prepare_localized_plugin_dir_at(&resource, &target, "fr").expect("prepare ok");

        assert_eq!(command_files(&target), vec!["create.md", "help.md"]);
        let help_content =
            fs::read_to_string(target.join("commands").join("help.md")).expect("read help");
        assert!(help_content.contains("English help content"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn returns_error_when_selected_commands_are_missing() {
        let tmp = fresh_dir("missing");
        let resource = tmp.join("resource");
        let target = tmp.join("runtime-plugin");
        fs::create_dir_all(resource.join(".claude-plugin")).expect("create plugin meta");
        fs::write(resource.join(".claude-plugin").join("plugin.json"), "{}")
            .expect("write plugin json");
        let err = prepare_localized_plugin_dir_at(&resource, &target, "ja")
            .expect_err("missing commands should fail");
        assert!(err.contains("localized command directory not found"));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn convert_command_strips_frontmatter_and_adds_codex_skill_metadata() {
        let input = "---\ndescription: Create a new pack\nargument-hint: \"[what]\"\n---\n\n$ARGUMENTS\n\n---\n\nYou are helping create a pack.\n\nMore instructions here.";
        let result = convert_command_to_codex_skill(input, "create");
        assert!(result.starts_with("---\nname: charm-create\n"));
        assert!(result.contains("Create a new pack"));
        assert!(result.contains("# charm-create"));
        assert!(result.contains("$ARGUMENTS"));
        assert!(result.contains("You are helping create a pack."));
        assert!(result.contains("More instructions here."));
        assert!(!result.contains("# /create"));
        assert!(!result.contains("argument-hint"));
    }

    #[test]
    fn convert_command_rewrites_slash_charm_refs_for_codex_skill() {
        let input = "---\ndescription: Help\n---\n\n$ARGUMENTS\n\n---\n\nUse /charm:create, /charm:update, or /charm:*.";
        let result = convert_command_to_codex_skill(input, "help");
        assert!(result.contains("$charm-create"));
        assert!(result.contains("$charm-update"));
        assert!(result.contains("$charm-*"));
        assert!(!result.contains("/charm:create"));
    }

    #[test]
    fn write_codex_cache_installs_skills_and_removes_stale_commands() {
        let tmp = fresh_dir("codex-cache");
        let resource = tmp.join("resource");
        let cache = tmp.join("cache");
        write_fixture(&resource);
        fs::create_dir_all(cache.join("commands")).expect("create stale commands");
        fs::write(cache.join("commands").join("old.md"), "stale").expect("write stale command");
        fs::create_dir_all(cache.join("skills").join("old")).expect("create stale skill");
        fs::write(cache.join("skills").join("old").join("SKILL.md"), "stale")
            .expect("write stale skill");

        write_codex_plugin_cache(
            &cache,
            &resource.join(".codex-plugin").join("plugin.json"),
            &resource.join("commands-en"),
            "en",
        )
        .expect("write cache");

        assert!(!cache.join("commands").exists());
        assert_eq!(
            fs::read_to_string(cache.join(".codex-plugin").join("plugin.json"))
                .expect("read codex plugin json"),
            "{\"name\":\"charm\",\"skills\":\"./skills/\"}"
        );
        let entry = fs::read_to_string(cache.join("skills").join("charm").join("SKILL.md"))
            .expect("read entry skill");
        assert!(entry.contains("$charm-create"));
        let create = fs::read_to_string(cache.join("skills").join("charm-create").join("SKILL.md"))
            .expect("read create skill");
        assert!(create.contains("name: charm-create"));
        assert!(create.contains("$ARGUMENTS"));
        assert!(create.contains("English create content."));
        assert!(!create.contains("# /create"));

        let _ = fs::remove_dir_all(&tmp);
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

#[cfg(test)]
mod bundled_examples_tests {
    use crate::bundled_examples_gen::BUNDLED_EXAMPLES;

    #[test]
    fn examples_not_empty() {
        assert!(
            !BUNDLED_EXAMPLES.is_empty(),
            "BUNDLED_EXAMPLES は空であってはならない"
        );
    }

    #[test]
    fn known_pack_has_files() {
        let pack = BUNDLED_EXAMPLES
            .iter()
            .find(|p| p.id == "screen-shake")
            .expect("screen-shake pack が見つからない");
        assert_eq!(pack.kind, "effect");
        assert!(
            !pack.files.is_empty(),
            "screen-shake にファイルが含まれていない"
        );
        // manifest.json と effect.ts が含まれることを確認
        let paths: Vec<&str> = pack.files.iter().map(|f| f.path).collect();
        assert!(paths.contains(&"manifest.json"), "manifest.json が無い");
        assert!(paths.contains(&"effect.ts"), "effect.ts が無い");
    }

    #[test]
    fn scene_pack_includes_lib_subdirectory() {
        let pack = BUNDLED_EXAMPLES
            .iter()
            .find(|p| p.id == "abandoned-factory")
            .expect("abandoned-factory pack が見つからない");
        assert_eq!(pack.kind, "scene");
        let paths: Vec<&str> = pack.files.iter().map(|f| f.path).collect();
        assert!(
            paths.contains(&"lib/lights.tsx"),
            "lib/ サブディレクトリのファイルが含まれていない"
        );
    }

    #[test]
    fn clai_shared_is_persona_kind() {
        let pack = BUNDLED_EXAMPLES
            .iter()
            .find(|p| p.id == "clai-shared")
            .expect("clai-shared pack が見つからない");
        assert_eq!(
            pack.kind, "persona",
            "clai-shared は personas/ 配下なので kind は persona"
        );
        let paths: Vec<&str> = pack.files.iter().map(|f| f.path).collect();
        assert!(paths.contains(&"persona-factory.ts"));
    }

    #[test]
    fn file_content_is_non_empty() {
        for pack in BUNDLED_EXAMPLES {
            for file in pack.files {
                assert!(
                    !file.content.is_empty(),
                    "pack={} file={} の content が空",
                    pack.id,
                    file.path
                );
            }
        }
    }

    #[test]
    fn meta_pack_has_readme() {
        let pack = BUNDLED_EXAMPLES
            .iter()
            .find(|p| p.id == "__meta__")
            .expect("__meta__ pack が見つからない");
        assert_eq!(pack.kind, "meta");
        let paths: Vec<&str> = pack.files.iter().map(|f| f.path).collect();
        assert!(
            paths.contains(&"README.md"),
            "top-level README.md が __meta__ に含まれていない"
        );
    }

    #[test]
    fn all_pack_kinds_are_valid() {
        let valid_kinds = [
            "effect",
            "persona",
            "scene",
            "amenity",
            "ui",
            "ambient-ui",
            "shared",
            "meta",
        ];
        for pack in BUNDLED_EXAMPLES {
            assert!(
                valid_kinds.contains(&pack.kind),
                "pack={} の kind={} が不正",
                pack.id,
                pack.kind
            );
        }
    }
}
