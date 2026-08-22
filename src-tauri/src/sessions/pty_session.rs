//! PtySession — 1 session 分の PTY resource lifecycle。
//!
//! pty.rs の PtyState から writer / master / child / output_channel /
//! ring_buffer / cwd / temp_config_paths を引き取り、registry が所有する形にする。
//! PtyState は Arc<SessionRegistry> を保持する thin facade になる。
//!
//! Internal design-record: 2026-05-05-multi-pane-terminal.md.

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::{AppHandle, Emitter, Manager};

use crate::attach::protocol::ControlMessage;
use crate::pty::PtyExit;

use super::codex_tui_proxy::CodexTuiProxy;
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
        /// false のとき agent adapter の既存会話 resume を禁止して完全新規 session を起動する。
        #[serde(default = "default_true")]
        resume: bool,
        /// provider 固有の会話 ID を指定して再開する。Claude / Codex adapter が使用する。
        #[serde(default)]
        resume_session_id: Option<String>,
    },
    Shell {
        /// Shell binary path を override したい場合のみ Some。None なら `$SHELL`、
        /// それも無ければ `/bin/sh` に fall back。
        #[serde(default)]
        command: Option<String>,
        /// Yorishiro 側 instrumentation（OSC 133 wrapper rc）の有無。
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
    cmd.env("TERM_PROGRAM", "Yorishiro");
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

/// A live external terminal connection. Implementations serialize writes so a
/// PTY output frame cannot interleave with a server control frame.
pub(crate) trait ExternalPtySink: Send + Sync {
    fn send_data(&self, data: &[u8]) -> Result<(), String>;
    fn send_control(&self, control: &ControlMessage) -> Result<(), String>;
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ExternalAttachInfo {
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ExternalResizeResult {
    Applied { cols: u16, rows: u16 },
    NotAuthority { cols: u16, rows: u16 },
}

#[derive(Default)]
struct ExternalClients {
    sinks: HashMap<String, Arc<dyn ExternalPtySink>>,
    resize_authority: Option<String>,
}

impl ExternalClients {
    fn remove_failed(&mut self, failed: &[String]) {
        for client_id in failed {
            self.sinks.remove(client_id);
            if self.resize_authority.as_deref() == Some(client_id) {
                self.resize_authority = None;
            }
        }
    }
}

fn fan_out_external_data(clients: &Mutex<ExternalClients>, data: &[u8]) {
    let sinks: Vec<(String, Arc<dyn ExternalPtySink>)> = {
        let guard = lock_or_recover(clients);
        guard
            .sinks
            .iter()
            .map(|(id, sink)| (id.clone(), Arc::clone(sink)))
            .collect()
    };
    let failed: Vec<String> = sinks
        .into_iter()
        .filter_map(|(id, sink)| sink.send_data(data).err().map(|_| id))
        .collect();
    if !failed.is_empty() {
        lock_or_recover(clients).remove_failed(&failed);
    }
}

fn broadcast_external_control(clients: &Mutex<ExternalClients>, control: &ControlMessage) {
    let sinks: Vec<(String, Arc<dyn ExternalPtySink>)> = {
        let guard = lock_or_recover(clients);
        guard
            .sinks
            .iter()
            .map(|(id, sink)| (id.clone(), Arc::clone(sink)))
            .collect()
    };
    let failed: Vec<String> = sinks
        .into_iter()
        .filter_map(|(id, sink)| sink.send_control(control).err().map(|_| id))
        .collect();
    if !failed.is_empty() {
        lock_or_recover(clients).remove_failed(&failed);
    }
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

// ─── Codex app-server ───────────────────────────────────────────

/// Codex TUI と realtime conversation が同じ thread を共有するための sidecar。
/// PTY session と寿命を揃え、途中エラーでも Drop で orphan process を残さない。
struct CodexAppServerProcess {
    child: Child,
    endpoint: String,
    capabilities: CodexRealtimeCapabilities,
    tui_proxy: Option<CodexTuiProxy>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CodexRealtimeCapabilities {
    pub app_server_version: Option<String>,
    pub persona_initial_items: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSelectedConversation {
    pub session_id: String,
    /// provider上で会話IDが確定済みならtrue。
    pub confirmed: bool,
    /// 同じPTY process内のtop-level selection revision。
    pub revision: u64,
}

fn parse_codex_cli_version(output: &str) -> Option<String> {
    let version =
        output.split_whitespace().find(|part| {
            let mut components = part.split('.');
            components.by_ref().take(3).all(|component| {
                !component.is_empty() && component.chars().all(|c| c.is_ascii_digit())
            }) && components.next().is_none()
                && part.matches('.').count() == 2
        })?;
    Some(version.to_string())
}

fn codex_version_at_least(version: &str, minimum: [u64; 3]) -> bool {
    let values: Vec<u64> = version
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .unwrap_or_default();
    values.len() == 3 && [values[0], values[1], values[2]] >= minimum
}

const CODEX_VERSION_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

fn read_child_stdout_with_timeout(mut child: Child, timeout: Duration) -> Option<String> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return None;
                }
                let mut bytes = Vec::new();
                child.stdout.take()?.read_to_end(&mut bytes).ok()?;
                return String::from_utf8(bytes).ok();
            }
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Ok(None) | Err(_) => {
                // Capability detection is advisory. A broken shim must not block session spawn.
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
}

fn detect_codex_realtime_capabilities(
    binary: &str,
    cwd: Option<&str>,
) -> CodexRealtimeCapabilities {
    let mut command = Command::new(binary);
    command
        .arg("--version")
        .env("PATH", crate::build_path_env())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    let app_server_version = command
        .spawn()
        .ok()
        .and_then(|child| read_child_stdout_with_timeout(child, CODEX_VERSION_PROBE_TIMEOUT))
        .and_then(|output| parse_codex_cli_version(&output));
    let persona_initial_items = app_server_version
        .as_deref()
        .is_some_and(|version| codex_version_at_least(version, [0, 146, 0]));
    CodexRealtimeCapabilities {
        app_server_version,
        persona_initial_items,
    }
}

impl CodexAppServerProcess {
    fn spawn(binary: &str, cwd: Option<&str>) -> Result<Self, String> {
        let capabilities = detect_codex_realtime_capabilities(binary, cwd);
        let listener = TcpListener::bind(("127.0.0.1", 0))
            .map_err(|e| format!("Codex app-server port allocation failed: {e}"))?;
        let address = listener
            .local_addr()
            .map_err(|e| format!("Codex app-server address lookup failed: {e}"))?;
        drop(listener);

        let endpoint = format!("ws://{address}");
        let mut command = Command::new(binary);
        command
            .arg("app-server")
            .arg("--listen")
            .arg(&endpoint)
            .env("PATH", crate::build_path_env())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(dir) = cwd {
            command.current_dir(dir);
        }

        let mut child = command.spawn().map_err(|e| {
            format!(
                "Failed to spawn Codex app-server ({binary}). Codex 0.145.0 or newer is required: {e}"
            )
        })?;
        // app が Drop を経ずに死んだ場合の startup reaper 用（issue #109）。
        // 記録成功後はどの失敗経路でも Self が Drop され、entry ごと回収される。
        // registry に記録できない sidecar は crash 後に安全な provenance 判定が
        // できない。未記録 orphan を新たに作らないよう、起動を成立させず即回収する。
        let recorded = crate::yorishiro_home_path().is_ok_and(|home| {
            super::codex_sidecar_registry::record_spawn(
                &super::codex_sidecar_registry::registry_path_under(&home),
                super::codex_sidecar_registry::SidecarEntry {
                    owner_pid: std::process::id(),
                    sidecar_pid: child.id(),
                    endpoint: endpoint.clone(),
                },
            )
        });
        if !recorded {
            let sidecar_pid = child.id();
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!(
                "Failed to record Codex app-server sidecar pid {sidecar_pid}; the process was stopped to avoid an untracked orphan"
            ));
        }
        let mut process = Self {
            child,
            endpoint,
            capabilities,
            tui_proxy: None,
        };
        process.wait_until_ready(address)?;
        process.tui_proxy = Some(CodexTuiProxy::spawn(process.endpoint.clone())?);
        Ok(process)
    }

    fn tui_endpoint(&self) -> Option<&str> {
        self.tui_proxy.as_ref().map(CodexTuiProxy::endpoint)
    }

    fn selected_thread_id(&self) -> Option<String> {
        self.tui_proxy
            .as_ref()
            .and_then(CodexTuiProxy::selected_thread_id)
    }

    fn selected_thread(&self) -> Option<AgentSelectedConversation> {
        self.tui_proxy
            .as_ref()
            .and_then(CodexTuiProxy::selected_thread)
            .map(|selected| AgentSelectedConversation {
                session_id: selected.id,
                confirmed: selected.confirmed,
                revision: selected.revision,
            })
    }

    fn wait_until_ready(&mut self, address: SocketAddr) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if TcpStream::connect_timeout(&address, Duration::from_millis(50)).is_ok() {
                return Ok(());
            }
            if let Some(status) = self
                .child
                .try_wait()
                .map_err(|e| format!("Codex app-server status check failed: {e}"))?
            {
                return Err(format!(
                    "Codex app-server exited before becoming ready ({status}). Codex 0.145.0 or newer is required."
                ));
            }
            std::thread::sleep(Duration::from_millis(25));
        }
        Err("Codex app-server did not become ready within 5 seconds".to_string())
    }
}

impl Drop for CodexAppServerProcess {
    fn drop(&mut self) {
        self.tui_proxy.take();
        let sidecar_pid = self.child.id();
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Ok(home) = crate::yorishiro_home_path() {
            super::codex_sidecar_registry::remove_sidecar(
                &super::codex_sidecar_registry::registry_path_under(&home),
                std::process::id(),
                sidecar_pid,
            );
        }
    }
}

// ─── PtySession ──────────────────────────────────────────────────

/// 1 PTY 分の lifecycle と resource を保持する。registry が `Arc<PtySession>`
/// として保持し、複数 caller が同 session に同時 access できる構造を取る。
///
/// 寿命: kill() / Drop で資源解放。registry の slot に居る間は alive。
pub struct PtySession {
    /// Reader thread が registry に activity を反映するときに使う。
    session_id: SessionId,
    hook_launch_id: String,
    registry: Arc<SessionRegistry>,
    writer: Mutex<Option<Box<dyn Write + Send>>>,
    master: Mutex<Option<Box<dyn portable_pty::MasterPty + Send>>>,
    /// Arc 化することで reader thread が exit code 取得時に独立して lock できる。
    child: Arc<Mutex<Option<Box<dyn portable_pty::Child + Send + Sync>>>>,
    /// Reader thread と共有。webview reload で channel を swap する。
    output_channel: Arc<Mutex<Option<Channel>>>,
    ring_buffer: Arc<Mutex<RingBuffer>>,
    external_clients: Arc<Mutex<ExternalClients>>,
    external_input: Mutex<()>,
    size: Mutex<(u16, u16)>,
    internal_size: Mutex<(u16, u16)>,
    spawned_cwd: Mutex<Option<String>>,
    temp_config_paths: Mutex<Vec<std::path::PathBuf>>,
    codex_app_server: Mutex<Option<CodexAppServerProcess>>,
    /// Hook-based agents (currently Claude Code) が通知した active conversation。
    hook_selected_conversation: Mutex<Option<AgentSelectedConversation>>,
    /// true のとき reader thread は pty-exit event を emit しない。
    /// session_spawn が旧 session を replace する際に立てる。
    suppress_exit_event: Arc<std::sync::atomic::AtomicBool>,
}

impl PtySession {
    pub fn new(session_id: SessionId, registry: Arc<SessionRegistry>) -> Self {
        Self {
            session_id,
            hook_launch_id: uuid::Uuid::new_v4().to_string(),
            registry,
            writer: Mutex::new(None),
            master: Mutex::new(None),
            child: Arc::new(Mutex::new(None)),
            output_channel: Arc::new(Mutex::new(None)),
            ring_buffer: Arc::new(Mutex::new(RingBuffer::new())),
            external_clients: Arc::new(Mutex::new(ExternalClients::default())),
            external_input: Mutex::new(()),
            size: Mutex::new((80, 24)),
            internal_size: Mutex::new((80, 24)),
            spawned_cwd: Mutex::new(None),
            temp_config_paths: Mutex::new(Vec::new()),
            codex_app_server: Mutex::new(None),
            hook_selected_conversation: Mutex::new(None),
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
        *lock_or_recover(&self.hook_selected_conversation) = None;
        std::thread::sleep(std::time::Duration::from_millis(10));

        if let Some(ref dir) = cwd {
            let metadata =
                std::fs::metadata(dir).map_err(|e| format!("Workspace not accessible: {}", e))?;
            if !metadata.is_dir() {
                return Err(format!("Workspace is not a directory: {}", dir));
            }
        }

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
        let mut pending_app_server: Option<CodexAppServerProcess> = None;
        let (binary, mut cmd) = match spec {
            SpawnSpec::Agent {
                agent: agent_id,
                command,
                system_prompt,
                plugin_dir,
                resume,
                resume_session_id,
            } => {
                let adapter = crate::sessions::agent_adapter::lookup(agent_id.as_str())
                    .ok_or_else(|| format!("Unknown agent id: {}", agent_id))?;
                let mcp_endpoint = if adapter.capabilities().mcp_injection {
                    Some(app.state::<crate::mcp::McpServerStatus>().endpoint()?)
                } else {
                    None
                };
                let binary = resolve_agent_binary(adapter, command.as_deref());
                let mut cmd = CommandBuilder::new(&binary);
                apply_base_env(&mut cmd);

                if adapter.capabilities().realtime_conversation {
                    pending_app_server =
                        Some(CodexAppServerProcess::spawn(&binary, cwd.as_deref())?);
                }

                // journal callback の発火判定。agent session の spawn ごとに評価する
                // ことで、app 開きっぱなし運用でも翌日の respawn で節目が拾われる。
                // shell タブでは走らない。pending の消費経路は Claude の
                // UserPromptSubmit hook だけなので、hook を持たない agent
                // （Codex 等）では評価しない。失敗しても spawn は止めない。
                if let Err(e) = crate::journal::callback::evaluate_on_session_spawn(
                    adapter.capabilities().lifecycle_hooks,
                ) {
                    eprintln!("[journal-callback] 発火判定失敗: {e}");
                }

                let prompt_reminder =
                    crate::sessions::agent_adapter::build_prompt_reminder_from_config();
                let hook_server = app.state::<crate::pty::HookServerEndpoint>();
                let ctx = crate::sessions::agent_adapter::LaunchContext {
                    host_session_id: &self.session_id,
                    hook_launch_id: &self.hook_launch_id,
                    cwd: cwd.as_deref().map(std::path::Path::new),
                    system_prompt: system_prompt.as_deref(),
                    prompt_reminder: prompt_reminder.as_deref(),
                    plugin_dir: plugin_dir.as_deref(),
                    mcp_endpoint: mcp_endpoint.as_deref(),
                    hook_port: hook_server.port,
                    hook_token: hook_server.token(),
                    resume: *resume,
                    resume_session_id: resume_session_id.as_deref(),
                    realtime_endpoint: pending_app_server
                        .as_ref()
                        .and_then(CodexAppServerProcess::tui_endpoint),
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
                    let yorishiro_home = crate::yorishiro_home_path().ok();
                    if let Some(home) = yorishiro_home {
                        let hook_server = app.state::<crate::pty::HookServerEndpoint>();
                        if hook_server.is_available() {
                            super::shell_wrapper::apply_agent_shim_env(
                                &mut cmd,
                                &home,
                                &self.session_id,
                                &self.hook_launch_id,
                                hook_server.port,
                                hook_server.token(),
                            );
                        }
                        super::shell_wrapper::apply_integration(&mut cmd, &binary, &home);
                    }
                }
                (binary, cmd)
            }
        };
        // Child commands can detect that they already run inside a Yorishiro
        // PTY and refuse recursive external-attach attempts.
        cmd.env("YORISHIRO_SESSION_ID", &self.session_id);

        if let Some(ref dir) = cwd {
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
        *lock_or_recover(&self.size) = (cols, rows);
        *lock_or_recover(&self.internal_size) = (cols, rows);
        *lock_or_recover(&self.spawned_cwd) = cwd;
        *lock_or_recover(&self.temp_config_paths) = temp_paths_to_cleanup;
        *lock_or_recover(&self.codex_app_server) = pending_app_server;
        lock_or_recover(&self.ring_buffer).clear();

        // Spawn reader thread。child Arc を別途渡すので registry を経由せずに
        // exit code を取れる。各 chunk を OSC 133 parser に通して、command
        // start / end の event で SessionRegistry の activity を更新する。
        let app_handle = app.clone();
        let channel_arc = Arc::clone(&self.output_channel);
        let ring_arc = Arc::clone(&self.ring_buffer);
        let external_clients_arc = Arc::clone(&self.external_clients);
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
                        drop(guard);
                        // External clients deliberately get live output only: no ring replay.
                        // Keep this at the end of the one existing PTY reader loop.
                        fan_out_external_data(&external_clients_arc, chunk);
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
            broadcast_external_control(
                &external_clients_arc,
                &ControlMessage::Exit { code: Some(code) },
            );
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

    pub(crate) fn is_alive(&self) -> bool {
        let mut guard = lock_or_recover(&self.child);
        guard
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .map(|status| status.is_none())
            .unwrap_or(false)
    }

    pub(crate) fn current_size(&self) -> ExternalAttachInfo {
        let (cols, rows) = *lock_or_recover(&self.size);
        ExternalAttachInfo { cols, rows }
    }

    pub(crate) fn register_external_sink(
        &self,
        client_id: String,
        sink: Arc<dyn ExternalPtySink>,
    ) -> Result<ExternalAttachInfo, String> {
        if !self.is_alive() {
            return Err("PTY session is not alive".to_string());
        }
        let mut clients = lock_or_recover(&self.external_clients);
        clients.sinks.insert(client_id.clone(), sink);
        if clients.resize_authority.is_none() {
            clients.resize_authority = Some(client_id);
        }
        Ok(self.current_size())
    }

    pub(crate) fn remove_external_sink(&self, client_id: &str) -> bool {
        let mut clients = lock_or_recover(&self.external_clients);
        let removed = clients.sinks.remove(client_id).is_some();
        if clients.resize_authority.as_deref() == Some(client_id) {
            clients.resize_authority = None;
        }
        removed
    }

    pub(crate) fn external_write(&self, client_id: &str, data: &[u8]) -> Result<(), String> {
        // Keep the writer order, authority state, notification, and nudge in one
        // external-input order. UI writes still share the existing writer lock.
        let _external_order = lock_or_recover(&self.external_input);
        let authority_changed = {
            let clients = lock_or_recover(&self.external_clients);
            if !clients.sinks.contains_key(client_id) {
                return Err("external client is not attached".to_string());
            }
            clients.resize_authority.as_deref() != Some(client_id)
        };

        {
            let mut writer = lock_or_recover(&self.writer);
            let Some(writer) = writer.as_mut() else {
                return Err("PTY writer is not available".to_string());
            };
            writer.write_all(data).map_err(|error| error.to_string())?;
            writer.flush().map_err(|error| error.to_string())?;
        }

        if authority_changed {
            {
                let mut clients = lock_or_recover(&self.external_clients);
                if !clients.sinks.contains_key(client_id) {
                    return Ok(());
                }
                clients.resize_authority = Some(client_id.to_string());
            }
            broadcast_external_control(
                &self.external_clients,
                &ControlMessage::ResizeAuthority {
                    client_id: client_id.to_string(),
                },
            );
            self.nudge_external_size()?;
        }
        Ok(())
    }

    pub(crate) fn external_resize(
        &self,
        client_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<ExternalResizeResult, String> {
        let _external_order = lock_or_recover(&self.external_input);
        if cols == 0 || rows == 0 {
            return Err("terminal size must be non-zero".to_string());
        }
        let is_authority = {
            let clients = lock_or_recover(&self.external_clients);
            clients.sinks.contains_key(client_id)
                && clients.resize_authority.as_deref() == Some(client_id)
        };
        if !is_authority {
            let size = self.current_size();
            return Ok(ExternalResizeResult::NotAuthority {
                cols: size.cols,
                rows: size.rows,
            });
        }

        self.resize_inner(cols, rows)?;
        broadcast_external_control(
            &self.external_clients,
            &ControlMessage::SizeChanged { cols, rows },
        );
        Ok(ExternalResizeResult::Applied { cols, rows })
    }

    pub(crate) fn nudge_external_size(&self) -> Result<(), String> {
        let size = self.current_size();
        let nudge_rows = if size.rows < u16::MAX {
            size.rows.saturating_add(1).max(1)
        } else {
            size.rows.saturating_sub(1).max(1)
        };
        let guard = lock_or_recover(&self.master);
        let Some(master) = guard.as_ref() else {
            return Err("PTY master is not available".to_string());
        };
        master
            .resize(PtySize {
                rows: nudge_rows,
                cols: size.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())?;
        master
            .resize(PtySize {
                rows: size.rows.max(1),
                cols: size.cols.max(1),
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| error.to_string())
    }

    /// Active Codex session と同じ thread に接続する realtime WebSocket endpoint。
    pub fn realtime_endpoint(&self) -> Option<String> {
        lock_or_recover(&self.codex_app_server)
            .as_ref()
            .map(|server| server.endpoint.clone())
    }

    pub fn realtime_capabilities(&self) -> Option<CodexRealtimeCapabilities> {
        lock_or_recover(&self.codex_app_server)
            .as_ref()
            .map(|server| server.capabilities.clone())
    }

    pub fn realtime_selected_thread_id(&self) -> Option<String> {
        let codex_session_id = lock_or_recover(&self.codex_app_server)
            .as_ref()
            .and_then(CodexAppServerProcess::selected_thread_id);
        codex_session_id.or_else(|| {
            lock_or_recover(&self.hook_selected_conversation)
                .as_ref()
                .map(|selection| selection.session_id.clone())
        })
    }

    pub fn realtime_selected_thread(&self) -> Option<AgentSelectedConversation> {
        let codex_selection = lock_or_recover(&self.codex_app_server)
            .as_ref()
            .and_then(CodexAppServerProcess::selected_thread);
        codex_selection.or_else(|| lock_or_recover(&self.hook_selected_conversation).clone())
    }

    pub fn record_hook_selected_conversation(
        &self,
        hook_launch_id: &str,
        provider_session_id: &str,
    ) {
        if hook_launch_id != self.hook_launch_id {
            return;
        }
        let provider_session_id = provider_session_id.trim();
        if provider_session_id.is_empty() {
            return;
        }
        let mut selected = lock_or_recover(&self.hook_selected_conversation);
        let revision = selected
            .as_ref()
            .map(|current| current.revision.saturating_add(1))
            .unwrap_or(1);
        *selected = Some(AgentSelectedConversation {
            session_id: provider_session_id.to_string(),
            confirmed: true,
            revision,
        });
    }

    pub fn matches_hook_launch(&self, hook_launch_id: &str) -> bool {
        hook_launch_id == self.hook_launch_id
    }

    #[cfg(test)]
    pub(crate) fn hook_launch_id(&self) -> &str {
        &self.hook_launch_id
    }

    pub fn write_data(&self, data: &str) -> Result<(), String> {
        self.write_bytes(data.as_bytes())
    }

    fn write_bytes(&self, data: &[u8]) -> Result<(), String> {
        let _external_order = lock_or_recover(&self.external_input);
        {
            let mut guard = lock_or_recover(&self.writer);
            if let Some(writer) = guard.as_mut() {
                writer.write_all(data).map_err(|e| e.to_string())?;
                writer.flush().map_err(|e| e.to_string())?;
            }
        }

        let released_external_authority = {
            let mut clients = lock_or_recover(&self.external_clients);
            clients.resize_authority.take().is_some()
        };
        if released_external_authority {
            let (cols, rows) = *lock_or_recover(&self.internal_size);
            self.resize_inner(cols, rows)?;
            broadcast_external_control(
                &self.external_clients,
                &ControlMessage::SizeChanged { cols, rows },
            );
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        let _external_order = lock_or_recover(&self.external_input);
        *lock_or_recover(&self.internal_size) = (cols, rows);
        let external_has_authority = lock_or_recover(&self.external_clients)
            .resize_authority
            .is_some();
        if external_has_authority {
            return Ok(());
        }
        self.resize_inner(cols, rows)?;
        broadcast_external_control(
            &self.external_clients,
            &ControlMessage::SizeChanged { cols, rows },
        );
        Ok(())
    }

    fn resize_inner(&self, cols: u16, rows: u16) -> Result<(), String> {
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
        *lock_or_recover(&self.size) = (cols, rows);
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
        *lock_or_recover(&self.codex_app_server) = None;
        Ok(())
    }
}

#[cfg(test)]
mod codex_realtime_capability_tests {
    use super::{codex_version_at_least, parse_codex_cli_version, read_child_stdout_with_timeout};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    #[test]
    fn parses_codex_cli_version_output() {
        assert_eq!(
            parse_codex_cli_version("codex-cli 0.146.0\n"),
            Some("0.146.0".to_string())
        );
        assert_eq!(parse_codex_cli_version("unexpected output"), None);
    }

    #[test]
    fn gates_realtime_persona_initial_items_by_version() {
        assert!(!codex_version_at_least("0.145.9", [0, 146, 0]));
        assert!(codex_version_at_least("0.146.0", [0, 146, 0]));
        assert!(codex_version_at_least("0.147.0", [0, 146, 0]));
        assert!(!codex_version_at_least("invalid", [0, 146, 0]));
    }

    #[cfg(unix)]
    #[test]
    fn bounds_a_stalled_codex_version_probe() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "while :; do :; done"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let child = command.spawn().expect("spawn stalled probe");
        let started = Instant::now();

        assert_eq!(
            read_child_stdout_with_timeout(child, Duration::from_millis(25)),
            None
        );
        assert!(started.elapsed() < Duration::from_secs(2));
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
        self.codex_app_server
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct MemoryExternalSink {
        data: Mutex<Vec<Vec<u8>>>,
        fail: bool,
    }

    impl ExternalPtySink for MemoryExternalSink {
        fn send_data(&self, data: &[u8]) -> Result<(), String> {
            if self.fail {
                return Err("closed".to_string());
            }
            lock_or_recover(&self.data).push(data.to_vec());
            Ok(())
        }

        fn send_control(&self, _control: &ControlMessage) -> Result<(), String> {
            if self.fail {
                Err("closed".to_string())
            } else {
                Ok(())
            }
        }
    }

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
    fn external_fanout_sends_live_chunk_to_every_in_memory_sink() {
        let first = Arc::new(MemoryExternalSink {
            data: Mutex::new(Vec::new()),
            fail: false,
        });
        let second = Arc::new(MemoryExternalSink {
            data: Mutex::new(Vec::new()),
            fail: false,
        });
        let clients = Mutex::new(ExternalClients::default());
        {
            let mut guard = lock_or_recover(&clients);
            guard.sinks.insert("first".into(), first.clone());
            guard.sinks.insert("second".into(), second.clone());
        }

        fan_out_external_data(&clients, b"live only");

        assert_eq!(*lock_or_recover(&first.data), vec![b"live only".to_vec()]);
        assert_eq!(*lock_or_recover(&second.data), vec![b"live only".to_vec()]);
    }

    #[test]
    fn external_fanout_removes_failed_sink_and_its_authority() {
        let failed = Arc::new(MemoryExternalSink {
            data: Mutex::new(Vec::new()),
            fail: true,
        });
        let clients = Mutex::new(ExternalClients::default());
        {
            let mut guard = lock_or_recover(&clients);
            guard.sinks.insert("failed".into(), failed);
            guard.resize_authority = Some("failed".into());
        }

        fan_out_external_data(&clients, b"chunk");

        let guard = lock_or_recover(&clients);
        assert!(guard.sinks.is_empty());
        assert_eq!(guard.resize_authority, None);
    }

    #[test]
    fn hook_selected_conversation_is_confirmed_and_revisioned() {
        let session = PtySession::new(
            "default-session".to_string(),
            Arc::new(SessionRegistry::new()),
        );
        assert_eq!(session.realtime_selected_thread(), None);
        let launch_id = session.hook_launch_id.clone();
        assert!(session.matches_hook_launch(&launch_id));
        assert!(!session.matches_hook_launch("stale-launch"));

        session.record_hook_selected_conversation("stale-launch", "ignored");
        assert_eq!(session.realtime_selected_thread(), None);

        session.record_hook_selected_conversation(&launch_id, " claude-a ");
        assert_eq!(
            session.realtime_selected_thread(),
            Some(AgentSelectedConversation {
                session_id: "claude-a".to_string(),
                confirmed: true,
                revision: 1,
            })
        );

        session.record_hook_selected_conversation(&launch_id, "claude-b");
        assert_eq!(
            session.realtime_selected_thread(),
            Some(AgentSelectedConversation {
                session_id: "claude-b".to_string(),
                confirmed: true,
                revision: 2,
            })
        );
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
