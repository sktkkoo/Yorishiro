//! PtySession — 1 session 分の PTY resource lifecycle。
//!
//! pty.rs の PtyState から writer / master / child / output_channel /
//! ring_buffer / cwd / temp_config_paths を引き取り、registry が所有する形にする。
//! PtyState は Arc<SessionRegistry> を保持する thin facade になる。
//!
//! Internal design-record: 2026-05-05-multi-pane-terminal.md.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use crate::pty::PtyExit;

use super::osc133::{Osc133Parser, OscEvent};
use super::registry::SessionRegistry;
use super::types::{SessionActivity, SessionId};

#[derive(Clone, Serialize)]
struct PtyCwdChanged {
    session_id: String,
    cwd: String,
}

// ─── SpawnSpec ──────────────────────────────────────────────────

/// PTY spawn の意図を表す enum。Agent (adapter id) と Shell の 2 variant。
/// TS 側からは serde tag = "kind" の discriminated union として渡される。
///
/// Phase B-1 では Shell は plain spawn のみ。Phase B-2 で wrapper rc 注入と
/// OSC 133 emission を Shell variant に追加する。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SpawnSpec {
    #[serde(rename_all = "camelCase")]
    Agent {
        /// Adapter id ("claude" / "codex" / "opencode" / ...)。
        /// Rust 側 `agent_adapter::lookup` で validate される。
        agent: String,
        /// 起動 binary を override したい場合のみ Some。None なら $HOME/.local/bin
        /// 等から検索した既定 binary を使う。
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        system_prompt: Option<String>,
        /// TS 側が resolved language に合わせて生成した runtime plugin dir。
        /// Claude Code では `--plugin-dir`、Codex では local marketplace root として渡す。
        #[serde(default)]
        plugin_dir: Option<std::path::PathBuf>,
    },
    Shell {
        /// Shell binary path を override したい場合のみ Some。None なら `$SHELL`、
        /// それも無ければ `/bin/sh` に fall back。
        #[serde(default)]
        command: Option<String>,
        /// Charminal 側 instrumentation（OSC 133 wrapper rc）の有無。
        /// true で zsh: ZDOTDIR / bash: --rcfile / fish: -C 経由で wrapper を被せる。
        /// false なら raw spawn（住人は cell 観察のみ、command 単位の status は読めない）。
        #[serde(default = "default_true")]
        integration: bool,
    },
}

fn default_true() -> bool {
    true
}

pub(crate) fn resolve_agent_binary(
    adapter: &'static dyn crate::sessions::agent_adapter::TerminalAgent,
    override_path: Option<&str>,
) -> String {
    if let Some(path) = override_path {
        return path.to_string();
    }
    let home = dirs::home_dir().unwrap_or_default();
    let binary_name = adapter.binary_name();
    // adapter が宣言する install dir を最優先で探す（agent 固有 location は
    // ここに直書きせず adapter::extra_path_dirs に閉じる）。
    let extra_dirs = adapter.extra_path_dirs();
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if cfg!(windows) {
        let exe_name = format!("{}.exe", binary_name);
        let cmd_name = format!("{}.cmd", binary_name);
        let ps1_name = format!("{}.ps1", binary_name);
        for dir in &extra_dirs {
            candidates.push(dir.join(&exe_name));
            candidates.push(dir.join(&cmd_name));
            candidates.push(dir.join(&ps1_name));
        }
        candidates.push(home.join(".cargo").join("bin").join(&exe_name));
        candidates.push(
            home.join("AppData")
                .join("Local")
                .join("Programs")
                .join(&exe_name),
        );
        let npm_dir = home.join("AppData").join("Roaming").join("npm");
        candidates.push(npm_dir.join(&cmd_name));
        candidates.push(npm_dir.join(&exe_name));
        candidates.push(npm_dir.join(&ps1_name));
    } else {
        let exe_name = binary_name.to_string();
        for dir in &extra_dirs {
            candidates.push(dir.join(&exe_name));
        }
        candidates.push(home.join(".local").join("bin").join(&exe_name));
        candidates.push(home.join(".cargo").join("bin").join(&exe_name));
        candidates.push(std::path::PathBuf::from("/usr/local/bin").join(&exe_name));
        candidates.push(std::path::PathBuf::from("/opt/homebrew/bin").join(&exe_name));
    }
    for path in &candidates {
        if path.exists() {
            return path.to_string_lossy().into_owned();
        }
    }
    binary_name.to_string()
}

fn apply_base_env(cmd: &mut CommandBuilder) {
    cmd.env("PATH", crate::build_path_env());
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "Charminal");
    let lang = std::env::var("LANG").unwrap_or_else(|_| "ja_JP.UTF-8".to_string());
    cmd.env("LANG", lang);
}

fn resolve_shell_command(override_command: Option<&str>) -> String {
    if let Some(c) = override_command {
        return c.to_string();
    }
    if cfg!(windows) {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    } else {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string())
    }
}

// ─── Ring buffer ────────────────────────────────────────────────

/// Fixed-size circular byte buffer for PTY output replay on WebView reconnect.
/// Revelation 3.4 "living system": the PTY survives HMR reloads; the ring buffer
/// lets the new WebView restore the terminal's visible state without re-spawning.
pub(super) struct RingBuffer {
    buf: Vec<u8>,
    /// Write cursor — next byte writes here (mod capacity).
    cursor: usize,
    /// Total bytes ever written. `min(len, capacity)` gives current fill.
    len: usize,
}

/// WebView reconnect 時の attach 結果。live output の Channel は従来どおり
/// `InvokeResponseBody::Raw` のまま保ち、replay 分だけ invoke response で返す。
#[derive(Debug, Clone, Serialize)]
pub struct AttachResult {
    pub attached: bool,
    pub replay: Vec<u8>,
}

impl AttachResult {
    fn detached() -> Self {
        Self {
            attached: false,
            replay: Vec::new(),
        }
    }

    fn attached(replay: Vec<u8>) -> Self {
        Self {
            attached: true,
            replay,
        }
    }
}

/// 64 KB — enough for several screenfuls of terminal output.
const RING_CAPACITY: usize = 64 * 1024;

impl RingBuffer {
    fn new() -> Self {
        Self {
            buf: vec![0u8; RING_CAPACITY],
            cursor: 0,
            len: 0,
        }
    }

    fn write(&mut self, data: &[u8]) {
        let cap = self.buf.len();
        for &byte in data {
            self.buf[self.cursor] = byte;
            self.cursor = (self.cursor + 1) % cap;
        }
        self.len += data.len();
    }

    /// Read the ring buffer contents in chronological order.
    fn read(&self) -> Vec<u8> {
        let cap = self.buf.len();
        let fill = self.len.min(cap);
        if fill == 0 {
            return Vec::new();
        }
        let start = if self.len <= cap {
            0
        } else {
            self.cursor // oldest byte
        };
        let mut out = Vec::with_capacity(fill);
        for i in 0..fill {
            out.push(self.buf[(start + i) % cap]);
        }
        out
    }

    fn clear(&mut self) {
        self.cursor = 0;
        self.len = 0;
    }
}

/// Acquire a Mutex lock, recovering from poison instead of propagating panic.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ─── PtySession ──────────────────────────────────────────────────

/// 1 PTY 分の lifecycle と resource を保持する。registry が `Arc<PtySession>`
/// として保持し、複数 caller が同 session に同時 access できる構造を取る。
///
/// 寿命: kill() / Drop で資源解放。registry の slot に居る間は alive。
pub struct PtySession {
    /// Reader thread が registry に activity を反映するときに使う。
    session_id: SessionId,
    registry: Arc<SessionRegistry>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Arc 化することで reader thread が exit code 取得時に独立して lock できる。
    child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
    /// Reader thread と共有。webview reload で channel を swap する。
    output_channel: Arc<Mutex<Option<Channel>>>,
    ring_buffer: Arc<Mutex<RingBuffer>>,
    spawned_cwd: Mutex<Option<String>>,
    temp_config_paths: Mutex<Vec<std::path::PathBuf>>,
    /// true のとき reader thread は pty-exit event を emit しない。
    /// session_spawn が旧 session を replace する際に立てる。
    suppress_exit_event: Arc<std::sync::atomic::AtomicBool>,
}

impl PtySession {
    pub fn new(session_id: SessionId, registry: Arc<SessionRegistry>) -> Self {
        Self {
            session_id,
            registry,
            writer: Mutex::new(None),
            master: Mutex::new(None),
            child: Arc::new(Mutex::new(None)),
            output_channel: Arc::new(Mutex::new(None)),
            ring_buffer: Arc::new(Mutex::new(RingBuffer::new())),
            spawned_cwd: Mutex::new(None),
            temp_config_paths: Mutex::new(Vec::new()),
            suppress_exit_event: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        }
    }

    /// reader thread が pty-exit event を emit しないようにする。
    /// session_spawn が旧 session を replace kill する直前に呼ぶ。
    pub fn suppress_exit(&self) {
        self.suppress_exit_event
            .store(true, std::sync::atomic::Ordering::Relaxed);
    }

    /// PTY を新規 spawn。既存の child があれば先に kill する。SpawnSpec で
    /// agent / shell を切り替える。
    pub fn spawn(
        &self,
        app: AppHandle,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        spec: &SpawnSpec,
        on_output: Channel,
    ) -> Result<(), String> {
        // Kill existing PTY if any
        let _ = self.kill();
        std::thread::sleep(std::time::Duration::from_millis(10));

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| format!("PTY open failed: {}", e))?;

        let mut temp_paths_to_cleanup: Vec<std::path::PathBuf> = Vec::new();
        let (binary, mut cmd) = match spec {
            SpawnSpec::Agent {
                agent: agent_id,
                command,
                system_prompt,
                plugin_dir,
            } => {
                let adapter = crate::sessions::agent_adapter::lookup(agent_id.as_str())
                    .ok_or_else(|| format!("Unknown agent id: {}", agent_id))?;
                let binary = resolve_agent_binary(adapter, command.as_deref());
                let mut cmd = CommandBuilder::new(&binary);
                apply_base_env(&mut cmd);

                // journal callback の発火判定。agent session の spawn ごとに評価する
                // ことで、app 開きっぱなし運用でも翌日の respawn で節目が拾われる。
                // shell タブでは走らない。失敗しても spawn は止めない。
                if let Err(e) = crate::journal::callback::evaluate_on_session_spawn() {
                    eprintln!("[journal-callback] 発火判定失敗: {e}");
                }

                let prompt_reminder =
                    crate::sessions::agent_adapter::build_prompt_reminder_from_config();
                let ctx = crate::sessions::agent_adapter::LaunchContext {
                    cwd: cwd.as_deref().map(std::path::Path::new),
                    system_prompt: system_prompt.as_deref(),
                    prompt_reminder: prompt_reminder.as_deref(),
                    plugin_dir: plugin_dir.as_deref(),
                    mcp_port: crate::mcp::server::resolve_port(),
                    hook_port: crate::pty::HOOK_SERVER_PORT,
                };
                let launch = adapter.build_launch_args(&ctx)?;
                for (k, v) in &launch.env {
                    cmd.env(k, v);
                }
                for arg in &launch.args {
                    cmd.arg(arg);
                }
                temp_paths_to_cleanup.extend(launch.temp_files);

                (binary, cmd)
            }
            SpawnSpec::Shell {
                integration,
                command,
            } => {
                let binary = resolve_shell_command(command.as_deref());
                let mut cmd = CommandBuilder::new(&binary);
                apply_base_env(&mut cmd);
                if *integration {
                    let charminal_home = dirs::home_dir().map(|h| h.join(".charminal"));
                    if let Some(home) = charminal_home {
                        super::shell_wrapper::apply_agent_shim_env(
                            &mut cmd,
                            &home,
                            &self.session_id,
                            crate::pty::HOOK_SERVER_PORT,
                        );
                        super::shell_wrapper::apply_integration(&mut cmd, &binary, &home);
                    }
                }
                (binary, cmd)
            }
        };

        if let Some(ref dir) = cwd {
            let metadata =
                std::fs::metadata(dir).map_err(|e| format!("Workspace not accessible: {}", e))?;
            if !metadata.is_dir() {
                return Err(format!("Workspace is not a directory: {}", dir));
            }
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn {}: {}", binary, e))?;
        drop(pair.slave);

        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| format!("Failed to clone reader: {}", e))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| format!("Failed to take writer: {}", e))?;

        // Lock order: writer → child → master
        *lock_or_recover(&self.writer) = Some(writer);
        *lock_or_recover(&self.child) = Some(child);
        *lock_or_recover(&self.master) = Some(pair.master);

        *lock_or_recover(&self.output_channel) = Some(on_output);
        *lock_or_recover(&self.spawned_cwd) = cwd;
        *lock_or_recover(&self.temp_config_paths) = temp_paths_to_cleanup;
        lock_or_recover(&self.ring_buffer).clear();

        // Spawn reader thread。child Arc を別途渡すので registry を経由せずに
        // exit code を取れる。各 chunk を OSC 133 parser に通して、command
        // start / end の event で SessionRegistry の activity を更新する。
        let app_handle = app.clone();
        let channel_arc = Arc::clone(&self.output_channel);
        let ring_arc = Arc::clone(&self.ring_buffer);
        let child_arc = Arc::clone(&self.child);
        let registry_for_thread = Arc::clone(&self.registry);
        let session_id_for_thread = self.session_id.clone();
        let suppress_exit = Arc::clone(&self.suppress_exit_event);
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            let mut parser = Osc133Parser::new();
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        // Write to ring buffer (always, even if channel is None)
                        lock_or_recover(&ring_arc).write(chunk);
                        // Feed OSC 133 parser → activity 更新。Phase B-2 では
                        // CommandStart/End のみ activity 反映。PromptStart/End は
                        // 検出するが state 更新は Phase C でより細かい AwaitingInput
                        // を実装するときに使う。
                        for event in parser.feed_chunk(chunk) {
                            match event {
                                OscEvent::CommandStart => {
                                    registry_for_thread.set_activity(
                                        &session_id_for_thread,
                                        SessionActivity::RunningCommand,
                                    );
                                }
                                OscEvent::CommandEnd { .. } => {
                                    registry_for_thread.set_activity(
                                        &session_id_for_thread,
                                        SessionActivity::Idle,
                                    );
                                }
                                OscEvent::CurrentDir { cwd } => {
                                    registry_for_thread
                                        .set_cwd(&session_id_for_thread, cwd.clone());
                                    let _ = app_handle.emit(
                                        "pty-cwd-changed",
                                        PtyCwdChanged {
                                            session_id: session_id_for_thread.clone(),
                                            cwd,
                                        },
                                    );
                                }
                                OscEvent::PromptStart | OscEvent::PromptEnd => {
                                    // Phase C で AwaitingInput を入れる時に使う。
                                }
                            }
                        }
                        // Forward to WebView channel
                        let guard = lock_or_recover(&channel_arc);
                        if let Some(ch) = guard.as_ref() {
                            let _ = ch.send(InvokeResponseBody::Raw(chunk.to_vec()));
                        }
                    }
                }
            }
            // Get exit code
            let mut child_guard = lock_or_recover(&child_arc);
            let code: i32 = child_guard
                .as_mut()
                .and_then(|c| c.try_wait().ok().flatten().map(|s| s.exit_code() as i32))
                .unwrap_or(-1);
            drop(child_guard);
            if !suppress_exit.load(std::sync::atomic::Ordering::Relaxed) {
                let _ = app_handle.emit(
                    "pty-exit",
                    PtyExit {
                        session_id: session_id_for_thread,
                        code,
                    },
                );
            }
        });

        Ok(())
    }

    /// 既存の PTY に新しい channel を繋ぎ直す（WebView HMR reload）。ring
    /// buffer を replay して terminal 状態を復元してから channel swap する。
    /// PTY が dead か cwd が違うと false を返す。
    pub fn attach(&self, cwd: Option<String>, on_output: Channel) -> AttachResult {
        let is_alive = {
            let mut guard = lock_or_recover(&self.child);
            guard
                .as_mut()
                .and_then(|c| c.try_wait().ok())
                .map(|maybe_exit| maybe_exit.is_none())
                .unwrap_or(false)
        };
        if !is_alive {
            return AttachResult::detached();
        }

        let cwd_matches = *lock_or_recover(&self.spawned_cwd) == cwd;
        if !cwd_matches {
            return AttachResult::detached();
        }

        // reader thread と同じ lock order（ring → channel）で、replay read と
        // channel swap の間に live chunk が落ちる隙間を作らない。
        let replay = {
            let ring = lock_or_recover(&self.ring_buffer);
            let replay = ring.read();
            *lock_or_recover(&self.output_channel) = Some(on_output);
            replay
        };
        AttachResult::attached(replay)
    }

    pub fn detach(&self) {
        *lock_or_recover(&self.output_channel) = None;
    }

    pub fn write_data(&self, data: &str) -> Result<(), String> {
        let mut guard = lock_or_recover(&self.writer);
        if let Some(writer) = guard.as_mut() {
            writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            writer.flush().map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let guard = lock_or_recover(&self.master);
        if let Some(master) = guard.as_ref() {
            master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub fn refresh_agent_theme(
        &self,
        refresh: super::agent_adapter::AgentThemeRefresh,
    ) -> Result<(), String> {
        match refresh {
            super::agent_adapter::AgentThemeRefresh::Sigusr2 => self.send_sigusr2(),
        }
    }

    #[cfg(unix)]
    fn send_sigusr2(&self) -> Result<(), String> {
        let pid = {
            let mut guard = lock_or_recover(&self.child);
            let Some(child) = guard.as_mut() else {
                return Ok(());
            };
            if child.try_wait().ok().flatten().is_some() {
                return Ok(());
            }
            let Some(pid) = child.process_id() else {
                return Ok(());
            };
            pid
        };

        let result = unsafe { libc::kill(pid as libc::pid_t, libc::SIGUSR2) };
        if result == 0 {
            return Ok(());
        }

        let err = std::io::Error::last_os_error();
        if err.raw_os_error() == Some(libc::ESRCH) {
            return Ok(());
        }
        Err(format!(
            "Failed to refresh PTY child theme with SIGUSR2 (pid {}): {}",
            pid, err
        ))
    }

    #[cfg(not(unix))]
    fn send_sigusr2(&self) -> Result<(), String> {
        Ok(())
    }

    pub fn kill(&self) -> Result<(), String> {
        // Lock order: writer → child → master
        *lock_or_recover(&self.writer) = None;
        if let Some(mut child) = lock_or_recover(&self.child).take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        *lock_or_recover(&self.master) = None;
        *lock_or_recover(&self.output_channel) = None;
        *lock_or_recover(&self.spawned_cwd) = None;
        lock_or_recover(&self.ring_buffer).clear();
        for path in lock_or_recover(&self.temp_config_paths).drain(..) {
            let _ = std::fs::remove_file(path);
        }
        Ok(())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let child_opt = self.child.lock().unwrap_or_else(|p| p.into_inner()).take();
        if let Some(mut child) = child_opt {
            let _ = child.kill();
            let _ = child.wait();
        }
        for path in self
            .temp_config_paths
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .drain(..)
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_buffer_empty() {
        let rb = RingBuffer::new();
        assert!(rb.read().is_empty());
    }

    #[test]
    fn ring_buffer_write_and_read() {
        let mut rb = RingBuffer::new();
        rb.write(b"hello");
        assert_eq!(rb.read(), b"hello");
    }

    #[test]
    fn ring_buffer_wrap_around() {
        let mut rb = RingBuffer {
            buf: vec![0u8; 8],
            cursor: 0,
            len: 0,
        };
        rb.write(b"ABCDEF"); // fills 6/8
        rb.write(b"GHIJ"); // wraps: cursor at 2, overwrites A and B
        let out = rb.read();
        // Should contain the last 8 bytes: CDEFGHIJ
        assert_eq!(out, b"CDEFGHIJ");
    }

    #[test]
    fn ring_buffer_exact_capacity() {
        let mut rb = RingBuffer {
            buf: vec![0u8; 4],
            cursor: 0,
            len: 0,
        };
        rb.write(b"ABCD");
        assert_eq!(rb.read(), b"ABCD");
    }

    #[test]
    fn ring_buffer_clear() {
        let mut rb = RingBuffer::new();
        rb.write(b"data");
        rb.clear();
        assert!(rb.read().is_empty());
    }

    #[test]
    fn resolve_agent_binary_finds_opencode_install_dir_on_unix() {
        if cfg!(windows) {
            return;
        }
        let resolved = resolve_agent_binary(
            crate::sessions::agent_adapter::lookup("opencode").expect("opencode adapter"),
            None,
        );
        let home = dirs::home_dir().unwrap_or_default();
        let opencode = home.join(".opencode").join("bin").join("opencode");
        if opencode.exists() {
            assert_eq!(resolved, opencode.to_string_lossy());
        }
    }
}
