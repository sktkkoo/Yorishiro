//! Tool-free Claude transport for host-owned autonomous work.
//!
//! The CLI may reason about supplied text; only the host may perform its proposed
//! operations. We require safe/restricted modes, an empty built-in/MCP tool set,
//! disabled hooks/customizations, and a verified streaming initialization record.
//! The sole permitted tool is Claude's `StructuredOutput` schema transport.
//!
//! This trusts the installed Claude executable to honor its flags. It is NOT an
//! OS sandbox or a guarantee about the CLI's own telemetry/auth network traffic.
//! Known nonempty managed settings are rejected because admin policy can survive
//! safe mode. Unknown/remote policy introduced after this check cannot be proven
//! absent here; supporting such environments requires separate isolation work.
//! Unix only until equivalent process-tree termination is implemented elsewhere.

use serde_json::Value;
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

const RUN_TIMEOUT: Duration = Duration::from_secs(120);
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_STDOUT: usize = 2 * 1024 * 1024;
const MAX_STDERR: usize = 64 * 1024;
const MAX_INPUT: usize = 1024 * 1024;
// Safe mode intentionally keeps built-in plugins. Disable the installed CLI's
// built-ins explicitly, using both current IDs and their documented legacy IDs.
// A future additional built-in still fails the empty-plugin inventory check.
const WORKER_SETTINGS: &str = r#"{"disableAllHooks":true,"enabledPlugins":{"cc-plugin-agents-md@builtin":false,"cc-plugin-telemetry@builtin":false,"cc-plugin-plugin-authoring@builtin":false,"agents-md@builtin":false,"telemetry@builtin":false,"plugin-authoring@builtin":false}}"#;
const REQUIRED_FLAGS: &[&str] = &[
    "--safe-mode",
    "--restricted",
    "--tools",
    "--strict-mcp-config",
    "--mcp-config",
    "--disable-slash-commands",
    "--no-chrome",
    "--no-session-persistence",
    "--setting-sources",
    "--settings",
    "--output-format",
    "--json-schema",
    "--verbose",
    "--print",
    "--permission-mode",
    "--permission-prompts",
];

/// Probe CLI capabilities without making a model request.
#[cfg(test)]
pub async fn available() -> Result<(), String> {
    let binary = checked_binary()?;
    probe(&binary, CancellationToken::new()).await
}

/// Return one schema-constrained proposal. No operation in it is executed here.
pub async fn run(
    prompt: String,
    schema: Value,
    cancel: CancellationToken,
) -> Result<Value, String> {
    if cancel.is_cancelled() {
        return Err("Autonomous reasoning was cancelled.".into());
    }
    let schema = serde_json::to_string(&schema).map_err(|_| "Invalid worker schema.")?;
    if prompt.len() > MAX_INPUT || schema.len() > MAX_INPUT {
        return Err("Autonomous reasoning input is too large.".into());
    }
    let binary = checked_binary()?;
    probe(&binary, cancel.clone()).await?;
    // Recheck policy after the probe, immediately before starting the model call.
    check_managed_settings()?;
    let directory = tempfile::Builder::new()
        .prefix("yorishiro-reasoning-")
        .tempdir()
        .map_err(|_| "Could not create an isolated reasoning directory.")?;
    let mut command = base_command(&binary, directory.path());
    command.args(worker_args(&schema));
    match capture(command, Some(prompt), true, RUN_TIMEOUT, cancel).await? {
        Output::Structured(value) => Ok(value),
        Output::Help(_) => Err("Invalid worker output mode.".into()),
    }
}

fn checked_binary() -> Result<PathBuf, String> {
    if !cfg!(unix) {
        return Err("Autonomous reasoning currently requires Unix process isolation.".into());
    }
    check_managed_settings()?;
    crate::resolve_command_path_impl("claude")
        .map(PathBuf::from)
        .ok_or_else(|| "Install Claude Code to enable autonomous reasoning.".into())
}

fn check_managed_settings() -> Result<(), String> {
    let mut paths = vec![
        PathBuf::from("/Library/Application Support/ClaudeCode/managed-settings.json"),
        PathBuf::from("/etc/claude-code/managed-settings.json"),
    ];
    if let Some(home) = dirs::home_dir() {
        paths.push(home.join(".claude/managed-settings.json"));
        paths.push(home.join(".claude/remote-settings.json"));
    }
    if let Some(config) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        paths.push(PathBuf::from(&config).join("managed-settings.json"));
        paths.push(PathBuf::from(config).join("remote-settings.json"));
    }
    for path in paths {
        check_policy_file(&path)?;
    }
    Ok(())
}

fn check_policy_file(path: &Path) -> Result<(), String> {
    use std::io::Read;
    let metadata = match std::fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => {
            return Err("Cannot inspect Claude managed settings; reasoning is disabled.".into())
        }
    };
    if metadata.len() > MAX_INPUT as u64 {
        return Err("Claude managed settings are too large to inspect safely.".into());
    }
    let file = std::fs::File::open(path)
        .map_err(|_| "Cannot read Claude managed settings; reasoning is disabled.")?;
    let mut contents = Vec::new();
    file.take((MAX_INPUT + 1) as u64)
        .read_to_end(&mut contents)
        .map_err(|_| "Cannot read Claude managed settings; reasoning is disabled.")?;
    if contents.len() > MAX_INPUT {
        return Err("Claude managed settings are too large to inspect safely.".into());
    }
    let value: Value = serde_json::from_slice(&contents)
        .map_err(|_| "Cannot parse Claude managed settings; reasoning is disabled.")?;
    if !value.as_object().is_some_and(|object| object.is_empty()) {
        return Err(
            "Claude managed settings are active; tool-free reasoning cannot be verified.".into(),
        );
    }
    Ok(())
}

fn base_command(binary: &Path, directory: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .current_dir(directory)
        .env("PATH", crate::build_path_env());
    // Do not inherit parent agent identity or shell/Node startup injection. Keep
    // normal HOME/auth/provider selection: --bare would disable OAuth/keychain.
    for key in [
        "CLAUDECODE",
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_CODE_ENTRYPOINT",
        "BASH_ENV",
        "ENV",
        "NODE_OPTIONS",
        "NODE_PATH",
    ] {
        command.env_remove(key);
    }
    command
}

fn worker_args(schema: &str) -> Vec<String> {
    [
        "--print",
        "--safe-mode",
        "--restricted",
        "--tools",
        "",
        "--strict-mcp-config",
        "--mcp-config",
        "{\"mcpServers\":{}}",
        "--disable-slash-commands",
        "--no-chrome",
        "--no-session-persistence",
        "--setting-sources",
        "",
        "--settings",
        WORKER_SETTINGS,
        "--permission-mode",
        "dontAsk",
        "--permission-prompts",
        "none",
        "--output-format",
        "stream-json",
        "--verbose",
        "--json-schema",
        schema,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn verify_help(bytes: &[u8]) -> Result<(), String> {
    let help = std::str::from_utf8(bytes).map_err(|_| "Claude capability output is not UTF-8.")?;
    if REQUIRED_FLAGS.iter().any(|flag| {
        !help
            .split_whitespace()
            .any(|word| word == *flag || word.trim_end_matches(',') == *flag)
    }) {
        return Err("Installed Claude Code lacks the required tool-free reasoning flags.".into());
    }
    Ok(())
}

async fn probe(binary: &Path, cancel: CancellationToken) -> Result<(), String> {
    let directory = tempfile::Builder::new()
        .prefix("yorishiro-probe-")
        .tempdir()
        .map_err(|_| "Could not create a CLI probe directory.")?;
    let mut command = base_command(binary, directory.path());
    command.arg("--help");
    match capture(command, None, false, PROBE_TIMEOUT, cancel).await? {
        Output::Help(bytes) => verify_help(&bytes),
        Output::Structured(_) => Err("Invalid CLI probe output.".into()),
    }
}

enum Output {
    Help(Vec<u8>),
    Structured(Value),
}

struct Process {
    child: Child,
    #[cfg(unix)]
    group: Option<u32>,
}

impl Process {
    fn terminate(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.group.take() {
            // The child is spawned in its own process group, never the app's.
            unsafe {
                libc::kill(-(id as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn capture(
    mut command: Command,
    prompt: Option<String>,
    structured: bool,
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<Output, String> {
    if cancel.is_cancelled() {
        return Err("Autonomous reasoning was cancelled.".into());
    }
    command
        .stdin(if prompt.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let child = command
        .spawn()
        .map_err(|_| "Could not start the Claude reasoning process.")?;
    let mut process = Process {
        #[cfg(unix)]
        group: child.id(),
        child,
    };
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or("Missing worker stdout.")?;
    let stderr = process
        .child
        .stderr
        .take()
        .ok_or("Missing worker stderr.")?;
    let stdin = process.child.stdin.take();
    let work = async {
        let write = async {
            if let (Some(mut stdin), Some(prompt)) = (stdin, prompt) {
                stdin
                    .write_all(prompt.as_bytes())
                    .await
                    .map_err(|_| "Could not send the reasoning prompt.")?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|_| "Could not close the reasoning input.")?;
            }
            Ok::<_, String>(())
        };
        let wait = async {
            process
                .child
                .wait()
                .await
                .map_err(|_| "Could not wait for the reasoning process.".to_owned())
        };
        let (status, output, _, ()) = tokio::try_join!(
            wait,
            read_stdout(stdout, structured),
            read_limited(stderr, MAX_STDERR),
            write
        )?;
        if !status.success() {
            // Never expose stderr: CLI diagnostics may contain credentials or
            // user input. No fallback to a less restricted launch is permitted.
            return Err(
                "Claude reasoning failed; check CLI authentication and supported flags.".into(),
            );
        }
        Ok(output)
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("Autonomous reasoning was cancelled.".into()),
        _ = tokio::time::sleep(timeout) => Err("Autonomous reasoning timed out.".into()),
        result = work => result,
    };
    process.terminate();
    let _ = process.child.wait().await;
    result
}

async fn read_limited(mut reader: impl AsyncRead + Unpin, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| "Could not read worker output.")?;
        if count == 0 {
            return Ok(bytes);
        }
        if bytes.len().saturating_add(count) > limit {
            return Err("Worker output exceeded its limit.".into());
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
}

async fn read_stdout(
    mut reader: impl AsyncRead + Unpin,
    structured: bool,
) -> Result<Output, String> {
    if !structured {
        return read_limited(reader, MAX_STDOUT).await.map(Output::Help);
    }
    let mut protocol = Protocol::default();
    let mut pending = Vec::new();
    let mut total = 0usize;
    let mut buffer = [0; 8192];
    loop {
        let count = reader
            .read(&mut buffer)
            .await
            .map_err(|_| "Could not read worker output.")?;
        if count == 0 {
            break;
        }
        total = total.saturating_add(count);
        if total > MAX_STDOUT {
            return Err("Worker output exceeded its limit.".into());
        }
        pending.extend_from_slice(&buffer[..count]);
        while let Some(end) = pending.iter().position(|byte| *byte == b'\n') {
            protocol.line(&pending[..end])?;
            pending.drain(..=end);
        }
    }
    if !pending.is_empty() {
        protocol.line(&pending)?;
    }
    protocol.finish().map(Output::Structured)
}

#[derive(Default)]
struct Protocol {
    initialized: bool,
    result: Option<Value>,
    structured_tools: HashSet<String>,
}

impl Protocol {
    fn line(&mut self, line: &[u8]) -> Result<(), String> {
        if line.iter().all(u8::is_ascii_whitespace) {
            return Ok(());
        }
        let event: Value =
            serde_json::from_slice(line).map_err(|_| "Invalid worker JSON event.")?;
        self.event(&event)
    }

    fn event(&mut self, event: &Value) -> Result<(), String> {
        if self.result.is_some() {
            return Err("Unexpected event after worker result.".into());
        }
        let kind = event
            .get("type")
            .and_then(Value::as_str)
            .ok_or("Worker event type is missing.")?;
        if kind == "system" && event.get("subtype").and_then(Value::as_str) == Some("init") {
            if self.initialized {
                return Err("Duplicate worker initialization.".into());
            }
            let tools = event
                .get("tools")
                .and_then(Value::as_array)
                .ok_or("Worker tool inventory is missing.")?;
            if tools
                .iter()
                .any(|tool| tool.as_str() != Some("StructuredOutput"))
            {
                return Err("Worker exposed an unauthorized tool.".into());
            }
            for field in ["mcp_servers", "plugins", "skills"] {
                if event
                    .get(field)
                    .is_some_and(|value| !value.as_array().is_some_and(Vec::is_empty))
                {
                    return Err("Worker customizations remain active.".into());
                }
            }
            self.initialized = true;
            return Ok(());
        }
        if !self.initialized {
            return Err("Worker did not verify its tool inventory first.".into());
        }
        match kind {
            "assistant" | "user" => {
                let blocks = event
                    .pointer("/message/content")
                    .and_then(Value::as_array)
                    .ok_or("Invalid worker message.")?;
                for block in blocks {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_use") if kind == "assistant" => {
                            if block.get("name").and_then(Value::as_str) != Some("StructuredOutput")
                            {
                                return Err("Worker attempted an unauthorized tool call.".into());
                            }
                            let id = block
                                .get("id")
                                .and_then(Value::as_str)
                                .ok_or("Missing structured-output call ID.")?;
                            if !self.structured_tools.insert(id.to_owned()) {
                                return Err("Duplicate structured-output call ID.".into());
                            }
                        }
                        Some("tool_result") if kind == "user" => {
                            let id = block
                                .get("tool_use_id")
                                .and_then(Value::as_str)
                                .ok_or("Missing tool-result ID.")?;
                            if !self.structured_tools.remove(id) {
                                return Err("Unexpected worker tool result.".into());
                            }
                        }
                        Some("text" | "thinking" | "redacted_thinking") => {}
                        _ => return Err("Unexpected worker message content.".into()),
                    }
                }
                Ok(())
            }
            "result" => {
                if event.get("subtype").and_then(Value::as_str) != Some("success")
                    || event.get("is_error").and_then(Value::as_bool) != Some(false)
                {
                    return Err("Claude could not produce a structured proposal.".into());
                }
                let result = event
                    .get("structured_output")
                    .filter(|value| value.is_object())
                    .ok_or("Worker structured output is missing.")?;
                self.result = Some(result.clone());
                Ok(())
            }
            _ => Err("Unexpected worker protocol event.".into()),
        }
    }

    fn finish(self) -> Result<Value, String> {
        self.result
            .ok_or_else(|| "Worker ended without a verified structured result.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// Explicit opt-in only: uses the installed CLI's authenticated model.
    #[tokio::test]
    #[ignore = "requires an authenticated Claude CLI and makes one model request"]
    async fn live_tool_free_cli_returns_structured_output() {
        available().await.expect("CLI capabilities");
        let result = run(
            "Return exactly {\"ok\":true} using the requested schema. Do not call any tool other than structured output.".into(),
            json!({"type":"object","additionalProperties":false,"properties":{"ok":{"type":"boolean"}},"required":["ok"]}),
            CancellationToken::new(),
        ).await.expect("tool-free authenticated model request");
        assert_eq!(result, json!({"ok":true}));
    }

    fn init() -> Value {
        json!({"type":"system","subtype":"init","tools":[],"mcp_servers":[],"plugins":[],"skills":[]})
    }
    fn success() -> Value {
        json!({"type":"result","subtype":"success","is_error":false,"structured_output":{"action":"complete"}})
    }

    #[test]
    fn launch_disables_all_execution_paths_and_keeps_default_model() {
        let args = worker_args("{}");
        for (flag, value) in [
            ("--tools", ""),
            ("--setting-sources", ""),
            ("--mcp-config", "{\"mcpServers\":{}}"),
            ("--settings", WORKER_SETTINGS),
            ("--permission-prompts", "none"),
        ] {
            let index = args.iter().position(|arg| arg == flag).unwrap();
            assert_eq!(args[index + 1], value);
        }
        for flag in [
            "--safe-mode",
            "--restricted",
            "--strict-mcp-config",
            "--disable-slash-commands",
            "--no-chrome",
            "--no-session-persistence",
        ] {
            assert!(args.iter().any(|arg| arg == flag));
        }
        for flag in ["--bare", "--model", "--dangerously-skip-permissions"] {
            assert!(!args.iter().any(|arg| arg == flag));
        }
    }

    #[test]
    fn rejects_unsupported_cli_before_model_call() {
        assert!(verify_help(REQUIRED_FLAGS.join("\n").as_bytes()).is_ok());
        assert!(verify_help(b"--print --tools --safe-mode-similar").is_err());
    }

    #[test]
    fn requires_init_then_successful_structured_result() {
        let mut protocol = Protocol::default();
        assert!(protocol.event(&success()).is_err());
        protocol.event(&init()).unwrap();
        protocol.event(&success()).unwrap();
        assert_eq!(protocol.finish().unwrap(), json!({"action":"complete"}));
        let mut missing = Protocol::default();
        missing.event(&init()).unwrap();
        assert!(missing.finish().is_err());
    }

    #[test]
    fn rejects_tools_customizations_and_unexpected_calls() {
        for field in ["tools", "mcp_servers", "plugins", "skills"] {
            let mut event = init();
            event[field] = json!(["unexpected"]);
            assert!(Protocol::default().event(&event).is_err());
        }
        let mut protocol = Protocol::default();
        protocol.event(&init()).unwrap();
        assert!(protocol.event(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"bad","name":"Bash","input":{"command":"anything"}}]}})).is_err());
        assert!(protocol.event(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"unknown","content":"done"}]}})).is_err());
    }

    #[test]
    fn accepts_only_structured_output_tool_exchange() {
        let mut protocol = Protocol::default();
        let mut initialization = init();
        initialization["tools"] = json!(["StructuredOutput"]);
        protocol.event(&initialization).unwrap();
        protocol.event(&json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"schema-1","name":"StructuredOutput","input":{"action":"complete"}}]}})).unwrap();
        protocol.event(&json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"schema-1","content":"accepted"}]}})).unwrap();
        protocol.event(&success()).unwrap();
        assert!(protocol.event(&success()).is_err());
        assert!(protocol.finish().is_ok());
    }

    #[test]
    fn managed_settings_fail_closed_but_empty_cache_is_allowed() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        assert!(check_policy_file(&path).is_ok());
        std::fs::write(&path, "{}").unwrap();
        assert!(check_policy_file(&path).is_ok());
        std::fs::write(&path, "{\"hooks\":{}}").unwrap();
        assert!(check_policy_file(&path).is_err());
        std::fs::write(&path, "broken").unwrap();
        assert!(check_policy_file(&path).is_err());
    }

    #[tokio::test]
    async fn caps_output_and_parses_stream_boundaries() {
        assert!(read_limited(&b"abc"[..], 2).await.is_err());
        let stream = format!("{}\n{}", init(), success());
        assert!(matches!(
            read_stdout(stream.as_bytes(), true).await.unwrap(),
            Output::Structured(_)
        ));
        assert!(read_stdout(&b"not-json\n"[..], true).await.is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancellation_and_timeout_terminate_and_reap_processes() {
        let directory = tempfile::tempdir().unwrap();
        let pid_path = directory.path().join("pid");
        let wait_path = pid_path.clone();
        let cancel = CancellationToken::new();
        let cancel_task = cancel.clone();
        tokio::spawn(async move {
            // Wait until the fake CLI has started before requesting cancellation.
            for _ in 0..100 {
                if wait_path.exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
            cancel_task.cancel();
        });
        // A shell is a test fixture only. Production starts the CLI directly.
        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "printf '%s' \"$$\" > \"$1\"; exec /bin/sleep 30",
                "fixture",
            ])
            .arg(&pid_path);
        let start = std::time::Instant::now();
        let error = capture(command, None, false, Duration::from_secs(10), cancel)
            .await
            .err()
            .unwrap();
        assert!(error.contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(2));
        let pid = std::fs::read_to_string(pid_path)
            .unwrap()
            .parse::<i32>()
            .unwrap();
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "cancelled child must be reaped"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
        let mut command = Command::new("/bin/sleep");
        command.arg("30");
        let error = capture(
            command,
            None,
            false,
            Duration::from_millis(30),
            CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
        assert!(error.contains("timed out"));
    }
}
