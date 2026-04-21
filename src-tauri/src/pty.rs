use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

/// Queue of hook signals for frontend polling (fallback when Tauri emit doesn't reach webview).
static HOOK_SIGNAL_QUEUE: std::sync::LazyLock<Mutex<Vec<String>>> =
    std::sync::LazyLock::new(|| Mutex::new(Vec::new()));

/// Drain all queued hook signals. Called by the poll_hook_signals Tauri command.
pub fn drain_hook_signals() -> Vec<String> {
    if let Ok(mut q) = HOOK_SIGNAL_QUEUE.lock() {
        q.drain(..).collect()
    } else {
        Vec::new()
    }
}

/// Acquire a Mutex lock, recovering from poison (prior thread panic) instead of propagating.
/// In a desktop app, cascading panics from poisoned locks are worse than proceeding with
/// potentially inconsistent state — the PTY will be killed/respawned on next user action anyway.
fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ─── Ring buffer ────────────────────────────────────────────────

/// Fixed-size circular byte buffer for PTY output replay on WebView reconnect.
/// Revelation 3.4 "living system": the PTY survives HMR reloads; the ring buffer
/// lets the new WebView restore the terminal's visible state without re-spawning.
struct RingBuffer {
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

// ─── Hook server ────────────────────────────────────────────────

const HOOK_SERVER_PORT: u16 = 19001;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
}

fn build_hooks_json(port: u16) -> String {
    // Each hook command: write to debug log AND curl the hook server
    let hook_cmd = |body: &str| -> String {
        format!(
            "echo '$(date +%H:%M:%S) {}' >> /tmp/charminal-hook-test.log; curl -s -m 1 -X POST -d '{}' http://127.0.0.1:{}/hook",
            body, body, port
        )
    };
    let hook_cmd_stdin = |endpoint: &str, label: &str| -> String {
        format!(
            "echo '$(date +%H:%M:%S) {}' >> /tmp/charminal-hook-test.log; cat | curl -s -m 1 -X POST -d @- http://127.0.0.1:{}{}",
            label, port, endpoint
        )
    };
    // UserPromptSubmit: just a generic prompt event for Perception.
    // `/charm` is handled by Claude Code's own custom-command pipeline
    // (bundled-packs/charminal-plugin/commands/charm.md loaded via --plugin-dir)
    // so no special detection or blocking is needed here anymore.
    let user_prompt_cmd = hook_cmd(r#"{\"event\":\"prompt\"}"#);
    format!(
        r#"{{
  "hooks": {{
    "UserPromptSubmit": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}],
    "PreToolUse": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}],
    "PostToolUseFailure": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}],
    "Stop": [{{
      "matcher": "",
      "hooks": [{{ "type": "command", "command": "{}" }}]
    }}]
  }}
}}"#,
        user_prompt_cmd,
        hook_cmd_stdin("/hook/pre-tool-use", "pre-tool-use"),
        hook_cmd_stdin("/hook/post-tool-failure", "post-tool-failure"),
        hook_cmd(r#"{\"event\":\"stop\"}"#),
    )
}

/// Start a minimal HTTP server that receives hook signals from Claude Code.
/// Pushes each signal into `HOOK_SIGNAL_QUEUE` for frontend polling.
pub fn start_hook_server(_app: AppHandle) {
    std::thread::spawn(move || {
        let listener = match TcpListener::bind(format!("127.0.0.1:{}", HOOK_SERVER_PORT)) {
            Ok(l) => l,
            Err(e) => {
                eprintln!(
                    "[hook-server] Failed to bind port {}: {}",
                    HOOK_SERVER_PORT, e
                );
                return;
            }
        };
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { continue };
            let mut buf = vec![0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let data = String::from_utf8_lossy(&buf[..n]);

            let path = data
                .lines()
                .next()
                .unwrap_or("")
                .split_whitespace()
                .nth(1)
                .unwrap_or("/");

            if let Some(body_start) = data.find("\r\n\r\n") {
                let body = data[body_start + 4..].trim();
                if !body.is_empty() {
                    let event_type = match path {
                        "/hook/pre-tool-use" => Some("pre-tool-use"),
                        "/hook/post-tool-failure" => Some("post-tool-failure"),
                        "/hook" => None,
                        _ => None,
                    };

                    let final_body = if let Some(event) = event_type {
                        if let Ok(mut obj) = serde_json::from_str::<serde_json::Value>(body) {
                            if let Some(map) = obj.as_object_mut() {
                                map.insert("event".to_string(), serde_json::json!(event));
                                obj.to_string()
                            } else {
                                body.to_string()
                            }
                        } else {
                            body.to_string()
                        }
                    } else {
                        body.to_string()
                    };

                    // Push to polling queue — frontend drains via poll_hook_signals
                    if let Ok(mut q) = HOOK_SIGNAL_QUEUE.lock() {
                        q.push(final_body);
                    }
                }
            }
            let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
            let _ = stream.write_all(resp.as_bytes());
        }
    });
}

// ─── Session detection ──────────────────────────────────────────

/// Encode a resolved cwd into the project-dir name used by Claude Code.
///
/// Empirically, Claude Code stores per-project session state at
/// `~/.claude/projects/<encoded>/` where `<encoded>` is the canonicalized
/// cwd with `/` replaced by `-` (verified by inspecting actual entries —
/// e.g. a session opened at `/tmp/x` on macOS becomes `-private-tmp-x`,
/// confirming both symlink resolution and `/`→`-` substitution).
///
/// Returns `None` if the path can't be expressed as UTF-8. Windows uses
/// `\` and may also encode `:`; not handled here. The caller treats `None`
/// as "no session" — degraded but safe.
fn encode_project_dir_name(resolved: &std::path::Path) -> Option<String> {
    resolved.to_str().map(|s| s.replace('/', "-"))
}

/// True if Claude Code has an existing session for `cwd` that `-c` can resume.
///
/// Returns `false` on any error (missing HOME, can't canonicalize, non-UTF-8
/// path, etc.). The caller uses this to decide whether to pass `-c` to claude;
/// false → start fresh, which never errors.
fn has_existing_claude_session(cwd: Option<&str>) -> bool {
    let raw = match cwd {
        Some(c) => std::path::PathBuf::from(c),
        None => match std::env::current_dir() {
            Ok(p) => p,
            Err(_) => return false,
        },
    };

    // Claude Code resolves symlinks before deriving the project dir name.
    let Ok(resolved) = std::fs::canonicalize(&raw) else {
        return false;
    };

    let Some(encoded) = encode_project_dir_name(&resolved) else {
        return false;
    };

    let Some(home) = std::env::var_os("HOME") else {
        return false;
    };

    std::path::PathBuf::from(home)
        .join(".claude")
        .join("projects")
        .join(encoded)
        .is_dir()
}

fn toml_basic_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

// ─── PTY state ──────────────────────────────────────────────────

#[derive(Debug, Serialize, Clone)]
pub struct PtyExit {
    pub code: i32,
}

pub struct PtyState {
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    child: Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>,
    /// Shared with reader thread — can be swapped on WebView reload without killing PTY.
    output_channel: Arc<Mutex<Option<Channel>>>,
    /// Ring buffer for replay on WebView reconnect.
    ring_buffer: Arc<Mutex<RingBuffer>>,
    spawned_cwd: Mutex<Option<String>>,
    hooks_path: Mutex<Option<std::path::PathBuf>>,
}

impl PtyState {
    pub fn new() -> Self {
        Self {
            writer: Mutex::new(None),
            master: Mutex::new(None),
            child: Mutex::new(None),
            output_channel: Arc::new(Mutex::new(None)),
            ring_buffer: Arc::new(Mutex::new(RingBuffer::new())),
            spawned_cwd: Mutex::new(None),
            hooks_path: Mutex::new(None),
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn spawn(
        &self,
        app: AppHandle,
        cols: u16,
        rows: u16,
        cwd: Option<String>,
        agent: AgentKind,
        agent_binary: &str,
        system_prompt: Option<String>,
        plugin_dir: Option<std::path::PathBuf>,
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

        let mut cmd = CommandBuilder::new(agent_binary);
        cmd.env("PATH", crate::build_path_env());
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Charminal");
        let lang = std::env::var("LANG").unwrap_or_else(|_| "ja_JP.UTF-8".to_string());
        cmd.env("LANG", lang);

        let mut hooks_path_to_cleanup: Option<std::path::PathBuf> = None;
        match agent {
            AgentKind::Claude => {
                // `-c` resumes the prior session for this cwd; passing it when none
                // exists makes claude exit with an error. Skip it for fresh dirs.
                if has_existing_claude_session(cwd.as_deref()) {
                    cmd.arg("-c");
                }

                // Write hooks settings to temp file and pass to Claude Code.
                let hooks_json = build_hooks_json(HOOK_SERVER_PORT);
                let hooks_path = std::env::temp_dir()
                    .join(format!("charminal-hooks-{}.json", std::process::id()));
                std::fs::write(&hooks_path, &hooks_json)
                    .map_err(|e| format!("Failed to write hooks settings: {}", e))?;
                cmd.arg("--settings");
                cmd.arg(hooks_path.to_str().unwrap_or_default());
                hooks_path_to_cleanup = Some(hooks_path);

                // Load Charminal's bundled plugin dir (contains /charm skill).
                // Session-scoped; does not touch ~/.claude or the user's cwd.
                if let Some(ref dir) = plugin_dir {
                    if dir.exists() {
                        cmd.arg("--plugin-dir");
                        cmd.arg(dir.to_str().unwrap_or_default());

                        // Claude Code plugin の .mcp.json は auto-discover されないため、
                        // --mcp-config で明示的に load させる。これで Charminal が立てる
                        // MCP server (localhost:18743) を AI が tool として認識できる。
                        // Phase 1-c で追加（design-record 2026-04-18-phase-1c-rescue-and-mcp.md）。
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

                if let Some(ref prompt) = system_prompt {
                    cmd.arg("--append-system-prompt");
                    cmd.arg(prompt);
                }
            }
            AgentKind::Codex => {
                if let Some(ref dir) = cwd {
                    cmd.arg("--cd");
                    cmd.arg(dir);
                }
                if let Some(ref prompt) = system_prompt {
                    cmd.arg("-c");
                    cmd.arg(format!(
                        "developer_instructions={}",
                        toml_basic_string(prompt)
                    ));
                }
            }
        }

        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn {:?}: {}", agent, e))?;
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

        // Spawn reader thread
        let app_handle = app.clone();
        let channel_arc = Arc::clone(&self.output_channel);
        let ring_arc = Arc::clone(&self.ring_buffer);
        std::thread::spawn(move || {
            let mut reader = reader;
            let mut buf = [0u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = &buf[..n];
                        // Write to ring buffer (always, even if channel is None)
                        lock_or_recover(&ring_arc).write(chunk);
                        // Forward to WebView channel
                        let guard = lock_or_recover(&channel_arc);
                        if let Some(ch) = guard.as_ref() {
                            let _ = ch.send(InvokeResponseBody::Raw(chunk.to_vec()));
                        }
                    }
                }
            }
            // Get exit code
            let pty_state = app_handle.state::<PtyState>();
            let mut child_guard = lock_or_recover(&pty_state.child);
            let code: i32 = child_guard
                .as_mut()
                .and_then(|c| c.try_wait().ok().flatten().map(|s| s.exit_code() as i32))
                .unwrap_or(-1);
            drop(child_guard);
            let _ = app_handle.emit("pty-exit", PtyExit { code });
        });

        Ok(())
    }

    /// Reconnect a new output channel to the existing PTY without killing it.
    /// Replays the ring buffer to restore terminal state, then swaps the channel.
    /// Returns true if attached, false if PTY is dead or cwd differs.
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

        // Replay ring buffer to restore terminal content
        let replay = lock_or_recover(&self.ring_buffer).read();
        if !replay.is_empty() {
            let _ = on_output.send(InvokeResponseBody::Raw(replay));
        }

        // Swap channel — reader thread picks it up on next iteration
        *lock_or_recover(&self.output_channel) = Some(on_output);
        true
    }

    /// Disconnect the output channel without killing the PTY.
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

impl Drop for PtyState {
    fn drop(&mut self) {
        let child_opt = self.child.get_mut().unwrap_or_else(|e| e.into_inner());
        if let Some(mut child) = child_opt.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

// ─── Tests ──────────────────────────────────────────────────────

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
    fn encode_project_dir_name_basic() {
        assert_eq!(
            encode_project_dir_name(std::path::Path::new("/Users/foo/Charminal")),
            Some("-Users-foo-Charminal".to_string())
        );
    }

    #[test]
    fn encode_project_dir_name_preserves_dots() {
        // Claude Code does not escape `.`; verified against actual entries.
        assert_eq!(
            encode_project_dir_name(std::path::Path::new("/Users/foo/.config/app")),
            Some("-Users-foo-.config-app".to_string())
        );
    }

    #[test]
    fn encode_project_dir_name_root() {
        assert_eq!(
            encode_project_dir_name(std::path::Path::new("/")),
            Some("-".to_string())
        );
    }

    #[test]
    fn has_existing_claude_session_false_for_nonexistent_cwd() {
        // canonicalize fails on a path that doesn't exist → safe default.
        assert!(!has_existing_claude_session(Some(
            "/charminal/definitely/not/a/real/path/xyz"
        )));
    }

    #[test]
    fn has_existing_claude_session_false_for_unrelated_tmp_dir() {
        // A freshly-created tempdir has no Claude Code session, so even
        // though canonicalize succeeds, the lookup must return false.
        let tmp = std::env::temp_dir().join(format!(
            "charminal-session-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&tmp).expect("create tempdir");
        let path_str = tmp.to_str().expect("tmp path utf8").to_string();
        let result = has_existing_claude_session(Some(&path_str));
        let _ = std::fs::remove_dir(&tmp);
        assert!(!result, "fresh tempdir should not have a Claude session");
    }

    #[test]
    fn toml_basic_string_escapes_prompt_for_codex_config() {
        assert_eq!(
            toml_basic_string("a \"quote\"\npath\\tail"),
            "\"a \\\"quote\\\"\\npath\\\\tail\""
        );
    }

    #[test]
    fn build_hooks_json_valid() {
        let json = build_hooks_json(19001);
        let parsed: serde_json::Value = serde_json::from_str(&json).expect("should be valid JSON");
        let hooks = parsed["hooks"].as_object().expect("should have hooks");
        assert!(hooks.contains_key("UserPromptSubmit"));
        assert!(hooks.contains_key("PreToolUse"));
        assert!(hooks.contains_key("PostToolUseFailure"));
        assert!(hooks.contains_key("Stop"));
    }
}
