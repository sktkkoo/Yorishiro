//! PtySession — 1 session 分の PTY resource lifecycle。
//!
//! pty.rs の PtyState から writer / master / child / output_channel /
//! ring_buffer / cwd / hooks_path を引き取り、registry が所有する形にする。
//! PtyState は Arc<SessionRegistry> を保持する thin facade になる。
//!
//! Internal design-record: 2026-05-05-multi-pane-terminal.md.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Deserialize;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter};

use crate::pty::{
    build_hooks_json, codex_charminal_mcp_config_arg, has_existing_claude_session,
    has_existing_codex_session, toml_basic_string, AgentKind, PtyExit, HOOK_SERVER_PORT,
};

use super::osc133::{Osc133Parser, OscEvent};
use super::registry::SessionRegistry;
use super::types::{SessionActivity, SessionId};

// ─── SpawnSpec ──────────────────────────────────────────────────

/// PTY spawn の意図を表す enum。Agent (claude / codex) と Shell の 2 variant。
/// TS 側からは serde tag = "kind" の discriminated union として渡される。
///
/// Phase B-1 では Shell は plain spawn のみ。Phase B-2 で wrapper rc 注入と
/// OSC 133 emission を Shell variant に追加する。
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum SpawnSpec {
    Agent {
        agent: AgentKind,
        /// 起動 binary を override したい場合のみ Some。None なら $HOME/.local/bin
        /// 等から検索した既定 binary を使う。
        #[serde(default)]
        command: Option<String>,
        #[serde(default)]
        system_prompt: Option<String>,
        /// Claude Code の `--plugin-dir` に渡す plugin path。TS 側が resolved
        /// language に合わせて生成した runtime plugin dir を渡せる。
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

pub(crate) fn resolve_agent_binary(agent: AgentKind, override_path: Option<&str>) -> String {
    if let Some(path) = override_path {
        return path.to_string();
    }
    let home = dirs::home_dir().unwrap_or_default();
    let binary_name = match agent {
        AgentKind::Claude => "claude",
        AgentKind::Codex => "codex",
    };
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if cfg!(windows) {
        let exe_name = format!("{}.exe", binary_name);
        let cmd_name = format!("{}.cmd", binary_name);
        let ps1_name = format!("{}.ps1", binary_name);
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
    hooks_path: Mutex<Option<std::path::PathBuf>>,
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
            hooks_path: Mutex::new(None),
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

        let binary = match spec {
            SpawnSpec::Agent { agent, command, .. } => {
                resolve_agent_binary(*agent, command.as_deref())
            }
            SpawnSpec::Shell { command, .. } => resolve_shell_command(command.as_deref()),
        };

        let mut cmd = CommandBuilder::new(&binary);
        cmd.env("PATH", crate::build_path_env());
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Charminal");
        let lang = std::env::var("LANG").unwrap_or_else(|_| "ja_JP.UTF-8".to_string());
        cmd.env("LANG", lang);

        let mut hooks_path_to_cleanup: Option<std::path::PathBuf> = None;
        match spec {
            SpawnSpec::Agent {
                agent,
                system_prompt,
                plugin_dir,
                ..
            } => match agent {
                AgentKind::Claude => {
                    if has_existing_claude_session(cwd.as_deref()) {
                        cmd.arg("-c");
                    }

                    let hooks_json = build_hooks_json(HOOK_SERVER_PORT);
                    let hooks_path = std::env::temp_dir()
                        .join(format!("charminal-hooks-{}.json", std::process::id()));
                    std::fs::write(&hooks_path, &hooks_json)
                        .map_err(|e| format!("Failed to write hooks settings: {}", e))?;
                    cmd.arg("--settings");
                    cmd.arg(hooks_path.to_str().unwrap_or_default());
                    hooks_path_to_cleanup = Some(hooks_path);

                    // Load Charminal's bundled plugin dir (contains charm: skills).
                    // Session-scoped; does not touch ~/.claude or the user's cwd.
                    if let Some(dir) = plugin_dir {
                        if dir.exists() {
                            cmd.arg("--plugin-dir");
                            cmd.arg(dir.to_str().unwrap_or_default());

                            // Claude Code plugin の .mcp.json は auto-discover されないため、
                            // --mcp-config で明示的に load させる。これで Charminal が立てる
                            // MCP server (localhost:18743) を AI が tool として認識できる。
                            let mcp_config = dir.join(".mcp.json");
                            if mcp_config.is_file() {
                                cmd.arg("--mcp-config");
                                cmd.arg(mcp_config.to_str().unwrap_or_default());
                            }
                        } else {
                            eprintln!(
                                "[pty.spawn] plugin_dir does not exist, skipping: {}",
                                dir.display()
                            );
                        }
                    }

                    if let Some(prompt) = system_prompt {
                        cmd.arg("--append-system-prompt");
                        cmd.arg(prompt);
                    }
                }
                AgentKind::Codex => {
                    if has_existing_codex_session(cwd.as_deref()) {
                        cmd.arg("resume");
                        cmd.arg("--last");
                    }

                    cmd.arg("-c");
                    cmd.arg(codex_charminal_mcp_config_arg(
                        crate::mcp::server::resolve_port(),
                    ));

                    if let Some(prompt) = system_prompt {
                        cmd.arg("-c");
                        cmd.arg(format!(
                            "developer_instructions={}",
                            toml_basic_string(prompt)
                        ));
                    }
                }
            },
            SpawnSpec::Shell { integration, .. } => {
                if *integration {
                    let charminal_home = dirs::home_dir().map(|h| h.join(".charminal"));
                    if let Some(home) = charminal_home {
                        super::shell_wrapper::apply_integration(&mut cmd, &binary, &home);
                    }
                }
            }
        }

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
        *lock_or_recover(&self.hooks_path) = hooks_path_to_cleanup;
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
    pub fn attach(&self, cwd: Option<String>, on_output: Channel) -> bool {
        let is_alive = {
            let mut guard = lock_or_recover(&self.child);
            guard
                .as_mut()
                .and_then(|c| c.try_wait().ok())
                .map(|maybe_exit| maybe_exit.is_none())
                .unwrap_or(false)
        };
        if !is_alive {
            return false;
        }

        let cwd_matches = *lock_or_recover(&self.spawned_cwd) == cwd;
        if !cwd_matches {
            return false;
        }

        let replay = lock_or_recover(&self.ring_buffer).read();
        if !replay.is_empty() {
            let _ = on_output.send(InvokeResponseBody::Raw(replay));
        }

        *lock_or_recover(&self.output_channel) = Some(on_output);
        true
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
        if let Some(path) = lock_or_recover(&self.hooks_path).take() {
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
}
