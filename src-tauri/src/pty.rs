use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

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

fn build_hooks_json(port: u16) -> String {
    let curl_simple = |body: &str| -> String {
        format!(
            "curl -s -m 1 -X POST -d '{}' http://127.0.0.1:{}/hook",
            body, port
        )
    };
    let curl_stdin = |endpoint: &str| -> String {
        format!(
            "cat | curl -s -m 1 -X POST -d @- http://127.0.0.1:{}{}",
            port, endpoint
        )
    };
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
        curl_simple(r#"{\"event\":\"prompt\"}"#),
        curl_stdin("/hook/pre-tool-use"),
        curl_stdin("/hook/post-tool-failure"),
        curl_simple(r#"{\"event\":\"stop\"}"#),
    )
}

/// Start a minimal HTTP server that receives hook signals from Claude Code.
/// Emits Tauri event "hook-signal" with the JSON body for each request.
pub fn start_hook_server(app: AppHandle) {
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

                    let _ = app.emit("hook-signal", final_body);
                }
            }
            let resp = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok";
            let _ = stream.write_all(resp.as_bytes());
        }
    });
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
        claude_binary: &str,
        system_prompt: Option<String>,
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

        let mut cmd = CommandBuilder::new(claude_binary);
        cmd.arg("-c");
        cmd.env("PATH", crate::build_path_env());
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("TERM_PROGRAM", "Charminal");
        let lang = std::env::var("LANG").unwrap_or_else(|_| "ja_JP.UTF-8".to_string());
        cmd.env("LANG", lang);

        // Write hooks settings to temp file and pass to Claude Code
        let hooks_json = build_hooks_json(HOOK_SERVER_PORT);
        let hooks_path =
            std::env::temp_dir().join(format!("charminal-hooks-{}.json", std::process::id()));
        std::fs::write(&hooks_path, &hooks_json)
            .map_err(|e| format!("Failed to write hooks settings: {}", e))?;
        cmd.arg("--settings");
        cmd.arg(hooks_path.to_str().unwrap_or_default());

        if let Some(ref prompt) = system_prompt {
            cmd.arg("--append-system-prompt");
            cmd.arg(prompt);
        }

        if let Some(ref dir) = cwd {
            cmd.cwd(dir);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| format!("Failed to spawn claude: {}", e))?;
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
        *lock_or_recover(&self.hooks_path) = Some(hooks_path);
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
