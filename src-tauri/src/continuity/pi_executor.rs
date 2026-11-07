//! Native ownership and JSONL transport for a dedicated Pi durable worker.
//!
//! A response acknowledges a command, not completion. Every recovery first
//! reads the original durable request. Observation deadlines retain the owned
//! process and never authorize another submission.
use super::executor::{Outcome, Report, Request, TerminalTurn};
use super::types::{ModelResult, TerminalStatus};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, watch, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;

const RPC_TIMEOUT: Duration = Duration::from_secs(15);
const WORK_TIMEOUT: Duration = Duration::from_secs(60 * 60);
const MAX_FRAME: usize = 1024 * 1024;
const DIGEST_ALGORITHM: &str = "sha256-json-envelope-v1";

#[derive(Clone, Debug)]
pub(super) struct Target {
    pub cwd: String,
    pub session_dir: String,
    pub node_path: String,
    pub worker_entry: String,
    pub provider: String,
    pub model: String,
    pub auth_mode: AuthMode,
    pub auth_path: Option<String>,
    pub permissions: Option<Permissions>,
    pub managed: Option<Box<super::pi_target::ManagedTarget>>,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
pub(super) enum AuthMode {
    #[default]
    #[serde(rename = "apiKey")]
    ApiKey,
    #[serde(rename = "oauth")]
    Oauth,
}

impl AuthMode {
    fn validate(self, provider: &str, path: Option<&str>) -> Result<(), String> {
        match (self, path) {
            (Self::ApiKey, None) => Ok(()),
            (Self::Oauth, Some(path))
                if provider == "openai"
                    && Path::new(path).is_absolute()
                    && !path.contains('\0') => Ok(()),
            _ => Err("Invalid Pi authentication configuration; no alternative authentication was selected.".into()),
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::ApiKey => "apiKey",
            Self::Oauth => "oauth",
        }
    }

    pub(super) fn apply_args(self, command: &mut Command, path: Option<&str>) {
        command.args(["--auth-mode", self.label()]);
        if let Some(path) = path {
            command.args(["--auth-path", path]);
        }
    }
}

/// Only non-secret metadata is accepted here. Reading or refreshing a
/// credential belongs to the selected worker, never to native state storage.
#[cfg(test)]
pub(super) fn auth_configuration(
    config: &Value,
    provider: &str,
) -> Result<(AuthMode, Option<String>), String> {
    let mode: AuthMode =
        serde_json::from_value(config.get("authMode").cloned().unwrap_or(json!("apiKey")))
            .map_err(|_| "Invalid Pi authentication mode.".to_owned())?;
    let path: Option<String> =
        serde_json::from_value(config.get("authPath").cloned().unwrap_or(Value::Null))
            .map_err(|_| "Invalid Pi authentication path.".to_owned())?;
    mode.validate(provider, path.as_deref())?;
    Ok((mode, path))
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Permissions {
    pub read: bool,
    pub write: bool,
    #[serde(default)]
    pub commands: Vec<AllowedCommand>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct AllowedCommand {
    pub id: String,
    pub program: String,
    pub args: Vec<String>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_command_timeout"
    )]
    pub timeout_ms: Option<u64>,
}

fn deserialize_command_timeout<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = f64::deserialize(deserializer)?;
    if !(1.0..=300_000.0).contains(&value) || value.fract() != 0.0 {
        return Err(serde::de::Error::custom("Invalid Pi command timeout."));
    }
    Ok(Some(value as u64))
}

impl Permissions {
    fn validate(&self) -> Result<(), String> {
        let mut ids = std::collections::BTreeSet::new();
        for command in &self.commands {
            if command.id.trim().is_empty()
                || !ids.insert(&command.id)
                || !Path::new(&command.program).is_absolute()
                || command.program.contains('\0')
                || command.args.iter().any(|arg| arg.contains('\0'))
                || command
                    .timeout_ms
                    .is_some_and(|value| !(1..=300_000).contains(&value))
            {
                return Err("Invalid Pi workspace command permission.".into());
            }
        }
        Ok(())
    }
}

impl Target {
    /// Configuration contains identities and paths, never credential material.
    #[cfg(test)]
    pub(super) fn from_config(
        config: &Value,
        cwd: &str,
        session_dir: &Path,
    ) -> Result<Self, String> {
        let field = |name: &str| {
            config
                .get(name)
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| "Pi worker/model is not configured.".to_owned())
        };
        let provider = field("provider")?;
        let (auth_mode, auth_path) = auth_configuration(config, &provider)?;
        let target = Self {
            managed: None,
            cwd: cwd.into(),
            session_dir: session_dir
                .to_str()
                .ok_or("Invalid Pi storage path.")?
                .into(),
            node_path: field("nodePath")?,
            worker_entry: field("workerEntry")?,
            provider,
            model: field("model")?,
            auth_mode,
            auth_path,
            permissions: Some(
                serde_json::from_value(
                    config
                        .get("permissions")
                        .cloned()
                        .ok_or("Pi tool permissions are not configured.")?,
                )
                .map_err(|_| "Invalid Pi tool permissions.")?,
            ),
        };
        target.validate()?;
        Ok(target)
    }

    pub(super) fn validate(&self) -> Result<(), String> {
        for path in [
            &self.cwd,
            &self.session_dir,
            &self.node_path,
            &self.worker_entry,
        ] {
            if path.contains('\0') || !Path::new(path).is_absolute() {
                return Err("Pi worker paths must be absolute.".into());
            }
        }
        if self.provider.trim().is_empty() || self.model.trim().is_empty() {
            return Err("Pi worker/model is not configured.".into());
        }
        self.auth_mode
            .validate(&self.provider, self.auth_path.as_deref())?;
        if let Some(permissions) = &self.permissions {
            permissions.validate()?;
        }
        if !Path::new(&self.cwd).is_dir()
            || !Path::new(&self.node_path).is_file()
            || !Path::new(&self.worker_entry).is_file()
        {
            return Err("The configured Pi runtime or workspace is unavailable.".into());
        }
        Ok(())
    }
}

fn isolate_worker_environment(command: &mut Command) {
    command.env_remove("NODE_OPTIONS").env_remove("NODE_PATH");
}

type Reply = Result<Value, String>;
type Waiters = Arc<Mutex<HashMap<String, oneshot::Sender<Reply>>>>;
// Cleanup must also run when an outer deadline or task cancellation drops the
// request future, rather than returning through its own observation timeout.
struct PendingRequest {
    id: String,
    waiters: Waiters,
}

impl Drop for PendingRequest {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.waiters.lock() {
            pending.remove(&self.id);
        }
    }
}

struct FrameDelivery<'a> {
    dirty: &'a AtomicBool,
    delivered: bool,
}

impl Drop for FrameDelivery<'_> {
    fn drop(&mut self) {
        if !self.delivered {
            // Another frame cannot follow an unfinished LF-delimited record.
            self.dirty.store(true, Ordering::Release);
        }
    }
}

struct Worker {
    target: Target,
    fixture: bool,
    stdin: AsyncMutex<ChildStdin>,
    child: AsyncMutex<Child>,
    waiters: Waiters,
    ready: watch::Receiver<Option<Reply>>,
    connected: Arc<AtomicBool>,
    framing_dirty: AtomicBool,
    // A dropped observation never establishes idleness. Only a request-scoped
    // terminal receipt can make this owner eligible for generation retirement.
    terminal_known: AtomicBool,
    retiring: AtomicBool,
    run_lease: AsyncMutex<()>,
}
static WORKERS: OnceLock<AsyncMutex<BTreeMap<String, Arc<Worker>>>> = OnceLock::new();

impl Worker {
    fn spawn(target: &Target, fixture: bool) -> Result<Arc<Self>, String> {
        target.validate()?;
        if !fixture && target.permissions.is_none() {
            return Err("Pi tool permissions are not configured; no worker was started.".into());
        }
        std::fs::create_dir_all(&target.session_dir)
            .map_err(|_| "Could not create Pi session storage.")?;
        let mut command = Command::new(&target.node_path);
        command
            .arg(&target.worker_entry)
            .current_dir(&target.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if fixture {
            command.env_clear();
            command.arg("--fixture").arg(&target.session_dir);
        } else {
            command.args([
                "--session-dir",
                &target.session_dir,
                "--cwd",
                &target.cwd,
                "--provider",
                &target.provider,
                "--model",
                &target.model,
            ]);
            command.arg("--permissions-json").arg(
                serde_json::to_string(&target.permissions)
                    .map_err(|_| "Invalid Pi permissions.")?,
            );
            target
                .auth_mode
                .apply_args(&mut command, target.auth_path.as_deref());
            if let Some(identity) = &target.managed {
                command.arg("--managed-identity-json").arg(
                    serde_json::to_string(identity).map_err(|_| "Invalid managed Pi identity.")?,
                );
            }
        }
        // A verified bundled runtime must not load shell-installed preload
        // hooks or modules before the worker's own entry point.
        isolate_worker_environment(&mut command);
        let mut child = command
            .spawn()
            .map_err(|_| "Could not start the configured Pi worker.")?;
        let stdin = child.stdin.take().ok_or("Pi stdin is unavailable.")?;
        let stdout = child.stdout.take().ok_or("Pi stdout is unavailable.")?;
        let mut stderr = child.stderr.take().ok_or("Pi stderr is unavailable.")?;
        let (ready_sender, ready) = watch::channel(None);
        let waiters: Waiters = Arc::new(Mutex::new(HashMap::new()));
        let connected = Arc::new(AtomicBool::new(true));
        let worker = Arc::new(Self {
            target: target.clone(),
            fixture,
            stdin: AsyncMutex::new(stdin),
            child: AsyncMutex::new(child),
            waiters: waiters.clone(),
            ready,
            connected: connected.clone(),
            framing_dirty: AtomicBool::new(false),
            terminal_known: AtomicBool::new(false),
            retiring: AtomicBool::new(false),
            run_lease: AsyncMutex::new(()),
        });
        tokio::spawn(async move {
            // Drain diagnostics without retaining arbitrary output/credentials.
            let mut buffer = [0u8; 4096];
            while let Ok(length) = stderr.read(&mut buffer).await {
                if length == 0 {
                    break;
                }
            }
        });
        tokio::spawn(async move {
            let mut reader = BufReader::new(stdout);
            let error = loop {
                let value = match read_record(&mut reader).await {
                    Ok(Some(value)) => value,
                    Ok(None) => break "Pi worker stdout closed; recover its original request.",
                    Err(_) => break "Pi worker returned an invalid protocol frame; recover its original request.",
                };
                match value.get("type").and_then(Value::as_str) {
                    Some("ready") => {
                        if ready_sender.borrow().is_none() {
                            let _ = ready_sender.send(Some(Ok(value)));
                        }
                    }
                    Some("startup_error") => {
                        let error = match value.get("code").and_then(Value::as_str) {
                            Some("provider_unconfigured") => {
                                "Pi model authentication is not configured."
                            }
                            Some("auth_storage_unavailable") => {
                                "Pi authentication storage is unavailable."
                            }
                            Some("model_unavailable") => "The configured Pi model is unavailable.",
                            Some("permissions_invalid") => "Pi workspace permissions are invalid.",
                            Some("storage_owned") => "Pi storage already has a live worker owner.",
                            Some("configuration_invalid") => "Pi worker configuration is invalid.",
                            _ => "Pi worker configuration or storage is unavailable.",
                        };
                        let _ = ready_sender.send(Some(Err(error.into())));
                    }
                    Some("response") => {
                        if let Some(id) = value.get("id").and_then(Value::as_str) {
                            if let Ok(mut pending) = waiters.lock() {
                                if let Some(sender) = pending.remove(id) {
                                    let _ = sender.send(Ok(value));
                                }
                            }
                        }
                    }
                    // Streaming and lifecycle records are consumed continuously.
                    // Completion is recovered by a request-scoped status read.
                    _ => {}
                }
            };
            connected.store(false, Ordering::Release);
            if ready_sender.borrow().is_none() {
                let _ = ready_sender.send(Some(Err(error.into())));
            }
            if let Ok(mut pending) = waiters.lock() {
                for (_, sender) in pending.drain() {
                    let _ = sender.send(Err(error.into()));
                }
            }
        });
        Ok(worker)
    }

    async fn ready(&self, target: &Target, fixture: bool) -> Result<(), String> {
        let mut ready = self.ready.clone();
        let value = tokio::time::timeout(RPC_TIMEOUT, async {
            loop {
                if let Some(value) = ready.borrow().clone() {
                    return value;
                }
                ready
                    .changed()
                    .await
                    .map_err(|_| "Pi startup observation closed.".to_owned())?;
            }
        })
        .await
        .map_err(|_| {
            "Pi worker startup is still unconfirmed; it was not restarted.".to_owned()
        })??;
        validate_ready(&value, target, fixture)
    }

    async fn request(&self, kind: &str, value: Value) -> Reply {
        self.request_before(kind, value, RPC_TIMEOUT, || Ok(()))
            .await
    }

    fn idempotent_submit(&self) -> bool {
        self.ready
            .borrow()
            .as_ref()
            .and_then(|value| value.as_ref().ok())
            .is_some_and(|value| {
                value.get("idempotentSubmit").and_then(Value::as_bool) == Some(true)
                    && value.get("requestDigestAlgorithm").and_then(Value::as_str)
                        == Some(DIGEST_ALGORITHM)
                    && value.get("ownerLock").and_then(Value::as_str) == Some("sqlite-exclusive")
            })
    }

    async fn request_before(
        &self,
        kind: &str,
        mut value: Value,
        deadline: Duration,
        before_send: impl FnOnce() -> Result<(), String>,
    ) -> Reply {
        if !self.connected.load(Ordering::Acquire) {
            return Err(
                "Pi worker transport is unavailable; the process was not restarted.".into(),
            );
        }
        let id = uuid::Uuid::new_v4().to_string();
        value["id"] = json!(id);
        value["type"] = json!(kind);
        let mut bytes = serde_json::to_vec(&value).map_err(|_| "Could not encode Pi command.")?;
        if bytes.len() > MAX_FRAME {
            return Err("Pi command exceeds the protocol limit.".into());
        }
        bytes.push(b'\n');
        let (sender, response) = oneshot::channel();
        self.waiters
            .lock()
            .map_err(|_| "Pi response routing is unavailable.")?
            .insert(id.clone(), sender);
        let _pending = PendingRequest {
            id,
            waiters: self.waiters.clone(),
        };
        tokio::time::timeout(deadline, async {
                // Keep the lock through the response during boundary repair:
                // another sender cannot introduce a newer dirty frame before
                // this read-only probe clears the old framing uncertainty.
                let mut stdin = self.stdin.lock().await;
                if !self.connected.load(Ordering::Acquire) {
                    return Err("Pi command pipe became unavailable while waiting to send; no further frame was written.".into());
                }
                let repair = self.framing_dirty.load(Ordering::Acquire);
                if repair {
                    if kind != "status" || !self.idempotent_submit() {
                        return Err("Pi command framing is uncertain; only a managed read-only status probe may repair it.".into());
                    }
                    // A serialized JSON frame has no embedded LF. This either
                    // completes the original frame or terminates invalid JSON;
                    // it never constructs a new operation or request identity.
                    stdin.write_all(b"\n").await.map_err(|_| "Pi framing repair is unconfirmed.".to_owned())?;
                    stdin.flush().await.map_err(|_| "Pi framing repair is unconfirmed.".to_owned())?;
                }
                before_send()?;
                // Created after stdin is locked, so cancellation poisons an
                // unfinished frame before releasing that lock to another send.
                let mut frame = FrameDelivery {
                    dirty: &self.framing_dirty,
                    delivered: false,
                };
                stdin
                    .write_all(&bytes)
                    .await
                    .map_err(|_| "Pi command delivery is unconfirmed.".to_owned())?;
                frame.delivered = true;
                stdin
                    .flush()
                    .await
                    .map_err(|_| "Pi command delivery is unconfirmed.".to_owned())?;
            let response = response
                .await
                .map_err(|_| "Pi response observation closed.".to_owned())??;
            if response.get("command").and_then(Value::as_str) != Some(kind) {
                return Err("Pi response does not match its command.".into());
            }
            if response.get("success").and_then(Value::as_bool) != Some(true) {
                return Err(
                    "Pi rejected the command; inspect its original request before continuing."
                        .into(),
                );
            }
            let data = response
                .get("data")
                .cloned()
                .ok_or_else(|| "Pi response has no data.".to_owned())?;
            if repair {
                self.framing_dirty.store(false, Ordering::Release);
            }
            Ok(data)
        })
        .await
        .map_err(|_| {
            "Pi command observation timed out; its worker and original request were retained."
                .to_owned()
        })
        .and_then(|result| result)
    }
}

async fn read_record(
    reader: &mut (impl tokio::io::AsyncBufRead + Unpin),
) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    loop {
        let available = reader
            .fill_buf()
            .await
            .map_err(|_| "Could not read Pi stdout.")?;
        if available.is_empty() {
            return if bytes.is_empty() {
                Ok(None)
            } else {
                Err("Incomplete Pi record.".into())
            };
        }
        let end = available.iter().position(|byte| *byte == b'\n');
        let length = end.map_or(available.len(), |index| index + 1);
        if bytes.len() + length > MAX_FRAME {
            return Err("Pi record exceeds limit.".into());
        }
        bytes.extend_from_slice(&available[..length]);
        reader.consume(length);
        if end.is_some() {
            return serde_json::from_slice(&bytes)
                .map(Some)
                .map_err(|_| "Malformed Pi JSON record.".into());
        }
    }
}

fn validate_ready(value: &Value, target: &Target, fixture: bool) -> Result<(), String> {
    if let Some(identity) = &target.managed {
        if value.get("managedIdentity")
            != Some(&serde_json::to_value(identity).map_err(|_| "Invalid managed Pi identity.")?)
        {
            return Err("The managed Pi worker did not confirm its saved identity.".into());
        }
    }
    if value.get("protocol").and_then(Value::as_u64) != Some(2)
        || value.get("fixture").and_then(Value::as_bool) != Some(fixture)
        || value.get("provider").and_then(Value::as_str) != Some(target.provider.as_str())
        || value.get("model").and_then(Value::as_str) != Some(target.model.as_str())
        || value.get("authMode").cloned().unwrap_or(json!("apiKey"))
            != json!(target.auth_mode.label())
        || value.get("authPath").cloned().unwrap_or(Value::Null) != json!(target.auth_path)
        || (!fixture
            && value.get("permissions")
                != Some(
                    &serde_json::to_value(&target.permissions)
                        .map_err(|_| "Invalid Pi permissions.")?,
                ))
        || ![("cwd", &target.cwd), ("sessionDir", &target.session_dir)]
            .into_iter()
            .all(|(field, path)| {
                value
                    .get(field)
                    .and_then(Value::as_str)
                    .is_some_and(|actual| {
                        match (std::fs::canonicalize(actual), std::fs::canonicalize(path)) {
                            (Ok(actual), Ok(expected)) => actual == expected,
                            _ => false,
                        }
                    })
            })
    {
        return Err(
            "Pi worker identity or protocol does not match the saved target; no work was sent."
                .into(),
        );
    }
    super::pi_outbox::admission(value)?;
    Ok(())
}

fn canonical_worker_target(target: &Target) -> Result<Target, String> {
    target.validate()?;
    std::fs::create_dir_all(&target.session_dir)
        .map_err(|_| "Could not create Pi session storage.")?;
    let directory = std::fs::canonicalize(&target.session_dir)
        .map_err(|_| "Could not resolve Pi session storage.")?;
    let mut canonical = target.clone();
    canonical.session_dir = directory.to_str().ok_or("Invalid Pi storage path.")?.into();
    Ok(canonical)
}

fn validate_live_worker_configuration(
    owned: &Target,
    owned_fixture: bool,
    requested: &Target,
    requested_fixture: bool,
) -> Result<(), String> {
    if owned != requested
        || owned_fixture != requested_fixture
        || owned.node_path != requested.node_path
        || owned.worker_entry != requested.worker_entry
        || owned.cwd != requested.cwd
        || owned.auth_path != requested.auth_path
        || owned.permissions != requested.permissions
    {
        return Err("Pi storage already has a live owned worker with different configuration; recover or shut down that owner before changing configuration.".into());
    }
    Ok(())
}

async fn owned_worker(target: &Target, fixture: bool) -> Result<Arc<Worker>, String> {
    // Storage identity is independent of provider, runtime and fixture mode.
    // All aliases of one directory must converge on the same owned process.
    let canonical_target = canonical_worker_target(target)?;
    let target = &canonical_target;
    let key = target.session_dir.clone();
    let worker = {
        let mut workers = WORKERS.get_or_init(Default::default).lock().await;
        if let Some(worker) = workers.get(&key) {
            // A lost observation/pipe is not evidence that the process stopped.
            let stopped = worker
                .child
                .lock()
                .await
                .try_wait()
                .map_err(|_| "Could not inspect owned Pi worker.")?
                .is_some();
            if !stopped {
                validate_live_worker_configuration(
                    &worker.target,
                    worker.fixture,
                    target,
                    fixture,
                )?;
                if !worker.connected.load(Ordering::Acquire) {
                    return Err(
                        "The owned Pi worker is alive but disconnected; it was not restarted."
                            .into(),
                    );
                }
                worker.clone()
            } else {
                let worker = Worker::spawn(target, fixture)?;
                workers.insert(key, worker.clone());
                worker
            }
        } else {
            let worker = Worker::spawn(target, fixture)?;
            workers.insert(key, worker.clone());
            worker
        }
    };
    if let Err(error) = worker.ready(target, fixture).await {
        // Never kill a process merely because readiness observation expired.
        // A conclusive incompatible handshake precedes any accepted work.
        let incompatible = worker.ready.borrow().as_ref().is_some_and(Result::is_ok);
        if incompatible {
            let mut child = worker.child.lock().await;
            let _ = child.kill().await;
        }
        return Err(error);
    }
    Ok(worker)
}

/// A new numbered generation can retire only known settled owners in this
/// exact persona/workspace family. Legacy roots and accepted recovery do not
/// trigger retirement. Canonical paths prevent alias-based cross-family use.
fn generation_family(directory: &Path) -> Option<&Path> {
    let generation = directory.file_name()?.to_str()?;
    if generation.is_empty()
        || !generation.bytes().all(|byte| byte.is_ascii_digit())
        || generation.parse::<u64>().ok()? == 0
    {
        return None;
    }
    let generations = directory.parent()?;
    (generations.file_name()?.to_str()? == "generations")
        .then(|| generations.parent())
        .flatten()
}

async fn retire_idle_generations(target: &Target, fixture: bool) -> Result<(), String> {
    let target = canonical_worker_target(target)?;
    let family = generation_family(Path::new(&target.session_dir));
    let managed_family = target
        .managed
        .as_ref()
        .map(|identity| identity.family_key.as_str());
    if family.is_none() && managed_family.is_none() {
        return Ok(());
    }
    let Some(registry) = WORKERS.get() else {
        return Ok(());
    };
    // Holding the map prevents another lookup from racing retirement. A caller
    // that already obtained an Arc must acquire run_lease and check retiring.
    let mut workers = registry.lock().await;
    let candidates: Vec<_> = workers
        .iter()
        .filter(|(key, worker)| {
            key.as_str() != target.session_dir
                && worker.fixture == fixture
                && worker.target.cwd == target.cwd
                && if let Some(managed) = managed_family {
                    worker
                        .target
                        .managed
                        .as_ref()
                        .is_some_and(|identity| identity.family_key == managed)
                } else {
                    family.is_some_and(|family| {
                        Path::new(key.as_str()) == family
                            || generation_family(Path::new(key.as_str())) == Some(family)
                    })
                }
        })
        .map(|(key, worker)| (key.clone(), worker.clone()))
        .collect();
    for (key, worker) in candidates {
        let Ok(_lease) = worker.run_lease.try_lock() else {
            continue;
        };
        if !worker.terminal_known.load(Ordering::Acquire) {
            continue;
        }
        if !worker.retiring.swap(true, Ordering::AcqRel) {
            // Shutdown has no model-work side effect. If its observation is
            // lost, retain this exact owner and never kill/restart it here.
            let _ = worker
                .request_before("shutdown", json!({}), Duration::from_secs(1), || Ok(()))
                .await;
        }
        let stopped = {
            let mut child = worker.child.lock().await;
            if child.try_wait().ok().flatten().is_some() {
                true
            } else {
                matches!(
                    tokio::time::timeout(Duration::from_secs(1), child.wait()).await,
                    Ok(Ok(_))
                )
            }
        };
        if stopped {
            workers.remove(&key);
        }
    }
    Ok(())
}

/// App teardown only. Normal request completion and observation timeouts do
/// not close the worker; accepted Pi tasks remain owned between judgments.
pub(super) async fn shutdown_all() {
    let Some(registry) = WORKERS.get() else {
        return;
    };
    let workers = std::mem::take(&mut *registry.lock().await);
    futures_util::future::join_all(workers.into_values().map(|worker| async move {
        let _ = worker
            .request_before("shutdown", json!({}), Duration::from_millis(500), || Ok(()))
            .await;
        let mut child = worker.child.lock().await;
        if child.try_wait().ok().flatten().is_none()
            && tokio::time::timeout(Duration::from_millis(500), child.wait())
                .await
                .is_err()
        {
            // This is this host's exact Child handle, never a PID search.
            let _ = child.kill().await;
        }
    }))
    .await;
}

pub(super) async fn run(
    target: Target,
    request: Request,
    cancel: CancellationToken,
    on_dispatch: impl Fn() -> Result<(), String>,
) -> Result<Outcome, String> {
    run_owned(target, request, cancel, on_dispatch, false).await
}

async fn run_owned(
    target: Target,
    mut request: Request,
    cancel: CancellationToken,
    on_dispatch: impl Fn() -> Result<(), String>,
    fixture: bool,
) -> Result<Outcome, String> {
    if cancel.is_cancelled() {
        return Err("Pi work was cancelled before dispatch.".into());
    }
    if request.allow_dispatch {
        retire_idle_generations(&target, fixture).await?;
    }
    let worker = owned_worker(&target, fixture).await?;
    let _lease = worker.run_lease.lock().await;
    if worker.retiring.load(Ordering::Acquire) {
        return Err("The settled Pi generation is closing; no work was sent.".into());
    }
    worker.terminal_known.store(false, Ordering::Release);
    let managed = worker.idempotent_submit();
    let admission = {
        let ready = worker.ready.borrow();
        let ready = ready
            .as_ref()
            .ok_or("Pi startup identity is unconfirmed.")?;
        super::pi_outbox::admission(ready.as_ref().map_err(Clone::clone)?)?
    };
    // Read first: an existing generic-worker receipt remains recoverable even
    // when it predates native outbox support. A missing receipt is different.
    let mut status = worker
        .request("status", json!({"requestId":request.id}))
        .await?;
    let missing = status.get("found").and_then(Value::as_bool) == Some(false);
    let prepared = match admission.as_ref() {
        Some(identity) if managed || missing => Some(super::pi_outbox::prepare(
            &worker.target,
            fixture,
            &request,
            identity,
        )?),
        _ => None,
    };
    if managed {
        if let Some(original) = &prepared {
            let envelope =
                json!({"message":original["message"],"outputSchema":original["outputSchema"]});
            // Older hosts regenerated schemas on recovery. Only immutable
            // outbox evidence bound to this database epoch may restore it.
            if let Some(payload) = &request.persisted_payload {
                if serde_json::from_str::<Value>(payload).ok().as_ref() != Some(&envelope) {
                    return Err(
                        "The saved native payload and Pi admission evidence disagree.".into(),
                    );
                }
            } else {
                request.persisted_payload = Some(
                    serde_json::to_string(&envelope)
                        .map_err(|_| "Could not restore Pi submission identity.")?,
                );
            }
            request.schema = original["outputSchema"].clone();
        }
    }
    let (payload, digest) = request_identity(&request)?;
    validate_request_status(&status, &request.id, &digest, managed)?;
    let lookup = || {
        if managed {
            json!({"requestId":request.id,"requestDigest":digest})
        } else {
            json!({"requestId":request.id})
        }
    };
    if missing {
        if !request.allow_dispatch && prepared.is_none() {
            return Err("Pi has no confirmed receipt and no original epoch-bound submission evidence; it was not submitted again.".into());
        }
        if cancel.is_cancelled() {
            return Err("Pi work was cancelled before dispatch.".into());
        }
        let submission = if managed {
            let mut value =
                json!({"requestId":request.id,"requestPayload":payload,"requestDigest":digest});
            if let Some(admission) = &admission {
                value["admission"] = serde_json::to_value(admission)
                    .map_err(|_| "Invalid Pi admission identity.")?;
            }
            value
        } else {
            prepared.unwrap_or_else(|| json!({"requestId":request.id,"message":request.prompt,"outputSchema":request.schema}))
        };
        let accepted = worker
            .request_before("submit", submission, RPC_TIMEOUT, || {
                if cancel.is_cancelled() {
                    return Err("Pi work was cancelled before dispatch.".into());
                }
                // Re-admission reuses the exact request and the existing native
                // claim; it never manufactures another job or dispatch permission.
                if request.allow_dispatch {
                    on_dispatch()
                } else {
                    Ok(())
                }
            })
            .await?;
        if accepted.get("disposition").and_then(Value::as_str) != Some("accepted") {
            return Err("Pi did not confirm durable admission; recover the same request.".into());
        }
        if managed
            && (accepted.get("requestId").and_then(Value::as_str) != Some(request.id.as_str())
                || accepted.get("requestDigest").and_then(Value::as_str) != Some(digest.as_str())
                || !accepted
                    .get("submissionId")
                    .and_then(Value::as_u64)
                    .is_some_and(|id| id > 0 && id <= 9_007_199_254_740_991))
        {
            return Err("Pi admission does not identify the original request payload.".into());
        }
        status = worker.request("status", lookup()).await?;
        validate_request_status(&status, &request.id, &digest, managed)?;
    }
    if let Some(outcome) = interpret_status(&status, &request.id)? {
        worker.terminal_known.store(true, Ordering::Release);
        return Ok(outcome);
    }
    worker.request("resume", lookup()).await?;
    tokio::time::timeout(WORK_TIMEOUT, async {
        loop {
            tokio::select! {
                _ = cancel.cancelled() => return Err("Pi observation was cancelled; its accepted work remains owned by the worker.".into()),
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
            status = worker.request("status", lookup()).await?;
            validate_request_status(&status, &request.id, &digest, managed)?;
            if let Some(outcome) = interpret_status(&status, &request.id)? {
                worker.terminal_known.store(true, Ordering::Release);
                return Ok(outcome);
            }
        }
    }).await.map_err(|_| "Pi work is still unconfirmed; its owned worker was retained for recovery.".to_owned())?
}

fn request_identity(request: &Request) -> Result<(String, String), String> {
    use sha2::{Digest, Sha256};
    let expected = json!({"message":request.prompt,"outputSchema":request.schema});
    let payload = match &request.persisted_payload {
        Some(payload) => {
            if serde_json::from_str::<Value>(payload).ok().as_ref() != Some(&expected) {
                return Err(
                    "The saved Pi request payload differs from its original message or schema."
                        .into(),
                );
            }
            payload.clone()
        }
        None => {
            serde_json::to_string(&expected).map_err(|_| "Could not encode Pi request identity.")?
        }
    };
    let digest = format!("{:x}", Sha256::digest(payload.as_bytes()));
    Ok((payload, digest))
}

fn validate_request_status(
    status: &Value,
    id: &str,
    digest: &str,
    managed: bool,
) -> Result<(), String> {
    if !managed {
        return Ok(());
    }
    if status.get("requestId").and_then(Value::as_str) != Some(id) {
        return Err("Pi status does not identify the original durable request.".into());
    }
    match status.get("found").and_then(Value::as_bool) {
        Some(false) if status.get("requestDigest").is_none_or(Value::is_null) => Ok(()),
        Some(true) if status.get("requestDigest").and_then(Value::as_str) == Some(digest) => Ok(()),
        _ => Err("Pi status does not match the original request payload digest.".into()),
    }
}

fn interpret_status(status: &Value, request_id: &str) -> Result<Option<Outcome>, String> {
    if status.get("found").and_then(Value::as_bool) != Some(true)
        || status.get("requestId").and_then(Value::as_str) != Some(request_id)
    {
        return Err("Pi status does not identify the original durable request.".into());
    }
    let submission = status
        .get("submissionId")
        .and_then(Value::as_u64)
        .filter(|value| *value > 0 && *value <= 9_007_199_254_740_991)
        .ok_or("Pi status has no valid submission identity.")?;
    let complete = status.get("toolEvidenceComplete").and_then(Value::as_bool) == Some(true);
    let range = status.get("toolEvidenceRange").and_then(|range| {
        let first = range.get("firstEntryId")?.as_u64()?;
        let last = range.get("lastEntryId")?.as_u64()?;
        (first > 0 && first <= last).then_some((first, last))
    });
    let tools = status.get("toolResults").and_then(Value::as_array);
    let evidence: Vec<Value> = tools
        .into_iter()
        .flatten()
        .take(64)
        .map(|tool| {
            json!({
                "entryId": tool.get("entryId"), "toolCallId": tool.get("toolCallId"),
                "isError": tool.get("isError"), "interrupted": tool.get("interrupted"),
            })
        })
        .collect();
    let receipt = |status| TerminalTurn {
        id: format!("pi:{submission}"),
        status,
        evidence: evidence.clone(),
    };
    match status.get("status").and_then(Value::as_str) {
        Some("queued" | "placed") => Ok(None),
        Some("done") => {
            let value = status.get("report").cloned().unwrap_or(Value::Null);
            if serde_json::from_value::<ModelResult>(value.clone()).is_err() {
                return Ok(Some(Outcome::Terminal(receipt(
                    TerminalStatus::CompletedWithoutReport,
                ))));
            }
            let progressed = complete
                && range.is_some()
                && tools.is_some_and(|tools| {
                    !tools.is_empty()
                        && tools.iter().all(|tool| {
                            tool.get("entryId")
                                .and_then(Value::as_u64)
                                .is_some_and(|entry| {
                                    range.is_some_and(|(first, last)| {
                                        first <= entry && entry <= last
                                    })
                                })
                                && tool
                                    .get("toolCallId")
                                    .and_then(Value::as_str)
                                    .is_some_and(|id| !id.is_empty())
                                && tool.get("isError").and_then(Value::as_bool).is_some()
                        })
                        && tools.iter().any(|tool| {
                            tool.get("isError").and_then(Value::as_bool) == Some(false)
                                && tool.get("interrupted").and_then(Value::as_bool) != Some(true)
                        })
                });
            Ok(Some(Outcome::Completed(Report {
                value,
                progressed,
                completion_receipt: Some(receipt(TerminalStatus::CompletedWithoutReport)),
            })))
        }
        Some("unanswered") => {
            let terminal = if matches!(
                status.get("reason").and_then(Value::as_str),
                Some("interrupted" | "aborted" | "restart_limit")
            ) {
                TerminalStatus::Interrupted
            } else {
                TerminalStatus::Failed
            };
            Ok(Some(Outcome::Terminal(receipt(terminal))))
        }
        _ => Err("Pi work status is unconfirmed; inspect its original receipt.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generation_retirement_requires_an_explicit_numbered_family() {
        assert_eq!(
            generation_family(Path::new("/state/persona/generations/2")),
            Some(Path::new("/state/persona"))
        );
        for path in [
            "/state/persona",
            "/state/persona/generations/0",
            "/state/persona/generations/current",
            "/state/persona/generations/-1",
        ] {
            assert!(generation_family(Path::new(path)).is_none());
        }
    }

    #[tokio::test]
    async fn generation_handoff_closes_only_settled_unleased_owners_in_its_family() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        std::fs::create_dir(&workspace).unwrap();
        std::fs::write(workspace.join("input.txt"), "generation evidence").unwrap();
        let permissions = Permissions {
            read: true,
            write: false,
            commands: vec![],
        };
        std::fs::write(
            workspace.join("fixture-policy.json"),
            serde_json::to_vec(&permissions).unwrap(),
        )
        .unwrap();
        let node = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(node.status.success());
        let target = Target {
            managed: None,
            cwd: workspace.to_str().unwrap().into(),
            session_dir: root.path().join("family").to_str().unwrap().into(),
            node_path: String::from_utf8(node.stdout).unwrap().trim().into(),
            worker_entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("runtime/pi-worker/tests/fixture-entry.mjs")
                .to_str()
                .unwrap()
                .into(),
            provider: "faux".into(),
            model: "faux-1".into(),
            auth_mode: AuthMode::ApiKey,
            auth_path: None,
            permissions: Some(permissions),
        };
        let request = |id: &str| Request {
            id: id.into(),
            prompt: "Read input.txt and report".into(),
            schema: json!({"type":"object"}),
            persisted_payload: None,
            allow_dispatch: true,
        };
        let completed = run_owned(
            target.clone(),
            request("settled-original"),
            CancellationToken::new(),
            || Ok(()),
            true,
        )
        .await
        .unwrap();
        assert!(matches!(completed, Outcome::Completed(_)));
        let old = owned_worker(&target, true).await.unwrap();
        assert!(old.terminal_known.load(Ordering::Acquire));

        let mut unrelated_target = target.clone();
        unrelated_target.session_dir = root.path().join("another-persona").to_str().unwrap().into();
        run_owned(
            unrelated_target.clone(),
            request("unrelated-settled"),
            CancellationToken::new(),
            || Ok(()),
            true,
        )
        .await
        .unwrap();
        let unrelated = owned_worker(&unrelated_target, true).await.unwrap();

        let mut uncertain_target = target.clone();
        uncertain_target.session_dir = root
            .path()
            .join("family/generations/1")
            .to_str()
            .unwrap()
            .into();
        let uncertain = owned_worker(&uncertain_target, true).await.unwrap();
        let accepted = uncertain.request("submit", json!({"requestId":"unobserved-original","message":"Read input.txt and report","outputSchema":{"type":"object"}})).await.unwrap();
        let uncertain_pid = uncertain.child.lock().await.id();
        assert!(!uncertain.terminal_known.load(Ordering::Acquire));

        let mut next = target.clone();
        next.session_dir = root
            .path()
            .join("family/generations/2")
            .to_str()
            .unwrap()
            .into();
        let lease = old.run_lease.lock().await;
        retire_idle_generations(&next, true).await.unwrap();
        assert!(
            old.child.lock().await.try_wait().unwrap().is_none(),
            "a caller's live lease prevents retirement"
        );
        drop(lease);
        let completed = run_owned(
            next.clone(),
            request("new-generation"),
            CancellationToken::new(),
            || Ok(()),
            true,
        )
        .await
        .unwrap();
        assert!(matches!(completed, Outcome::Completed(_)));
        assert!(old.child.lock().await.try_wait().unwrap().is_some());
        assert!(old.retiring.load(Ordering::Acquire));
        assert!(unrelated.child.lock().await.try_wait().unwrap().is_none());
        assert!(uncertain.child.lock().await.try_wait().unwrap().is_none());
        assert_eq!(uncertain.child.lock().await.id(), uncertain_pid);
        assert!(!uncertain.retiring.load(Ordering::Acquire));
        let status = uncertain
            .request("status", json!({"requestId":"unobserved-original"}))
            .await
            .unwrap();
        assert_eq!(
            status["submissionId"], accepted["submissionId"],
            "unconfirmed accepted work keeps its durable identity"
        );
        assert!(status["found"].as_bool().unwrap());

        let next_owner = owned_worker(&next, true).await.unwrap();
        let registry = WORKERS.get().unwrap().lock().await;
        assert!(!registry.contains_key(&old.target.session_dir));
        drop(registry);
        for worker in [uncertain, unrelated, next_owner] {
            worker.request("shutdown", json!({})).await.unwrap();
            tokio::time::timeout(Duration::from_secs(2), worker.child.lock().await.wait())
                .await
                .unwrap()
                .unwrap();
            WORKERS
                .get()
                .unwrap()
                .lock()
                .await
                .remove(&worker.target.session_dir);
        }
    }

    #[test]
    fn managed_request_digests_reject_changed_payloads_and_unbound_status() {
        let mut request = Request {
            id: "original".into(),
            prompt: "Original task".into(),
            schema: json!({"type":"object"}),
            persisted_payload: Some(
                json!({"message":"Original task","outputSchema":{"type":"object"}}).to_string(),
            ),
            allow_dispatch: false,
        };
        let (_, digest) = request_identity(&request).unwrap();
        let valid = json!({"found":true,"requestId":"original","requestDigest":digest});
        assert!(validate_request_status(&valid, "original", &digest, true).is_ok());
        assert!(validate_request_status(&valid, "other", &digest, true).is_err());
        assert!(validate_request_status(&valid, "original", "different", true).is_err());
        assert!(validate_request_status(
            &json!({"found":true,"requestId":"original"}),
            "original",
            &digest,
            true
        )
        .is_err());
        assert!(validate_request_status(
            &json!({"found":false,"requestId":"original","requestDigest":null}),
            "original",
            &digest,
            true
        )
        .is_ok());
        assert!(
            validate_request_status(&json!({"found":false}), "original", &digest, true).is_err()
        );
        request.schema = json!({"type":"string"});
        assert!(request_identity(&request).is_err());
    }

    #[test]
    fn dropped_requests_release_waiters_and_only_poison_unfinished_frames() {
        for writing in [false, true] {
            for delivered in [false, true] {
                let waiters: Waiters = Default::default();
                let dirty = AtomicBool::new(false);
                let (sender, _response) = oneshot::channel();
                waiters.lock().unwrap().insert("request".into(), sender);
                let pending = PendingRequest {
                    id: "request".into(),
                    waiters: waiters.clone(),
                };
                if writing {
                    let frame = FrameDelivery {
                        dirty: &dirty,
                        delivered,
                    };
                    drop(frame);
                }
                drop(pending);
                assert!(waiters.lock().unwrap().is_empty());
                assert_eq!(dirty.load(Ordering::Acquire), writing && !delivered);
            }
        }
    }

    #[test]
    fn workspace_command_permissions_reject_implicit_or_ambiguous_execution() {
        let permissions: Permissions = serde_json::from_value(json!({
            "read":true,"write":false,"commands":[
                {"id":"test","program":"/runtime/node","args":["--test"]}
            ]
        }))
        .unwrap();
        assert!(permissions.validate().is_ok());
        let mut duplicate = permissions.clone();
        duplicate.commands.push(duplicate.commands[0].clone());
        assert!(duplicate.validate().is_err());
        let mut relative = permissions;
        relative.commands[0].program = "node".into();
        assert!(relative.validate().is_err());
        assert!(serde_json::from_value::<Permissions>(json!({"read":true})).is_err());
        assert!(serde_json::from_value::<Permissions>(
            json!({"read":true,"write":false,"allowAll":true})
        )
        .is_err());
    }

    #[test]
    fn command_timeout_permissions_preserve_legacy_identity_and_reject_invalid_explicit_values() {
        let legacy = json!({"read":true,"write":false,"commands":[
            {"id":"check","program":"/runtime/node","args":["--version"]}
        ]});
        let permissions: Permissions = serde_json::from_value(legacy.clone()).unwrap();
        assert!(permissions.validate().is_ok());
        assert_eq!(permissions.commands[0].timeout_ms, None);
        assert_eq!(serde_json::to_value(&permissions).unwrap(), legacy);
        for timeout in [1, 120_000, 300_000] {
            let mut configured = legacy.clone();
            configured["commands"][0]["timeoutMs"] = json!(timeout);
            let parsed: Permissions = serde_json::from_value(configured.clone()).unwrap();
            assert!(parsed.validate().is_ok());
            assert_eq!(parsed.commands[0].timeout_ms, Some(timeout));
            assert_eq!(serde_json::to_value(&parsed).unwrap(), configured);
        }
        // JSON numeric notation does not distinguish integer-valued floats in JS.
        let mut numeric = legacy.clone();
        numeric["commands"][0]["timeoutMs"] = json!(120000.0);
        assert_eq!(
            serde_json::from_value::<Permissions>(numeric)
                .unwrap()
                .commands[0]
                .timeout_ms,
            Some(120_000)
        );
        for timeout in [
            Value::Null,
            json!(0),
            json!(-1),
            json!(0.5),
            json!(300_001),
            json!("120000"),
            json!(true),
            json!({}),
        ] {
            let mut invalid = legacy.clone();
            invalid["commands"][0]["timeoutMs"] = timeout;
            assert!(serde_json::from_value::<Permissions>(invalid).is_err());
        }
        for timeout in [0, 300_001] {
            let mut constructed = permissions.clone();
            constructed.commands[0].timeout_ms = Some(timeout);
            assert!(constructed.validate().is_err());
        }
    }

    #[test]
    fn authentication_metadata_is_explicit_and_legacy_defaults_are_api_key_only() {
        let directory = tempfile::tempdir().unwrap();
        let binary = std::env::current_exe()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let legacy = json!({
            "cwd":directory.path(), "sessionDir":directory.path().join("storage"),
            "nodePath":binary, "workerEntry":binary, "provider":"openai", "model":"unit"
        });
        let target: Target = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(target.auth_mode, AuthMode::ApiKey);
        assert!(target.auth_path.is_none());
        assert!(target.validate().is_ok());
        let ready = json!({"protocol":2,"fixture":true,"provider":target.provider,
            "model":target.model,"cwd":target.cwd,"sessionDir":directory.path()});
        let mut target = target;
        target.session_dir = directory.path().to_str().unwrap().into();
        assert!(validate_ready(&ready, &target, true).is_ok());
        for (field, invalid) in [
            ("authMode", Value::Null),
            ("authMode", json!(42)),
            ("authMode", json!("unknown")),
            ("authPath", json!(42)),
            ("authPath", json!(false)),
        ] {
            let mut malformed = ready.clone();
            malformed[field] = invalid;
            assert!(
                validate_ready(&malformed, &target, true).is_err(),
                "{field}"
            );
        }
        let mut oauth = target.clone();
        oauth.auth_mode = AuthMode::Oauth;
        oauth.auth_path = Some(directory.path().join("auth.json").to_str().unwrap().into());
        assert!(oauth.validate().is_ok());
        let mut oauth_ready = ready.clone();
        oauth_ready["authMode"] = json!("oauth");
        oauth_ready["authPath"] = json!(oauth.auth_path);
        assert!(validate_ready(&oauth_ready, &oauth, true).is_ok());
        assert!(validate_ready(&ready, &oauth, true).is_err());
        oauth_ready["authPath"] = json!(directory.path().join("other-auth.json"));
        assert!(validate_ready(&oauth_ready, &oauth, true).is_err());
        assert_eq!(
            serde_json::from_value::<Target>(serde_json::to_value(&oauth).unwrap()).unwrap(),
            oauth
        );
        let mut missing_path = oauth.clone();
        missing_path.auth_path = None;
        assert!(missing_path.validate().is_err());
        let mut relative = oauth.clone();
        relative.auth_path = Some("auth.json".into());
        assert!(relative.validate().is_err());
        let mut wrong_provider = oauth.clone();
        wrong_provider.provider = "anthropic".into();
        assert!(wrong_provider.validate().is_err());
        let mut api_with_path = oauth;
        api_with_path.auth_mode = AuthMode::ApiKey;
        assert!(api_with_path.validate().is_err());
        let mut malformed = legacy;
        malformed["authMode"] = Value::Null;
        assert!(serde_json::from_value::<Target>(malformed).is_err());
    }

    fn report() -> Value {
        json!({"reply":"done","replyKind":"report","observedReply":null,
            "understandings":[],"drafts":[],"reflection":"","nextStep":null})
    }

    #[test]
    fn original_request_identity_and_completed_tool_evidence_are_required() {
        let mut value = json!({"found":true,"requestId":"original","submissionId":7,
            "status":"done","report":report(),"toolEvidenceComplete":true,
            "toolEvidenceRange":{"firstEntryId":8,"lastEntryId":10},
            "toolResults":[{"entryId":9,"toolCallId":"tool-1","isError":false}]});
        let Some(Outcome::Completed(result)) = interpret_status(&value, "original").unwrap() else {
            panic!()
        };
        assert!(result.progressed);
        assert_eq!(result.completion_receipt.unwrap().id, "pi:7");
        assert!(interpret_status(&value, "different").is_err());
        for field in ["toolEvidenceComplete", "toolResults", "toolEvidenceRange"] {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(field);
            let Some(Outcome::Completed(result)) = interpret_status(&missing, "original").unwrap()
            else {
                panic!()
            };
            assert!(!result.progressed);
        }
        value["toolResults"][0]["isError"] = json!(true);
        let Some(Outcome::Completed(result)) = interpret_status(&value, "original").unwrap() else {
            panic!()
        };
        assert!(!result.progressed);
        value["report"] = json!("unstructured");
        assert!(matches!(
            interpret_status(&value, "original").unwrap(),
            Some(Outcome::Terminal(_))
        ));
    }

    #[test]
    fn mixed_tool_outcomes_preserve_valid_partial_progress_without_borrowing_evidence() {
        let base = json!({"found":true,"requestId":"original","submissionId":7,
        "status":"done","report":report(),"toolEvidenceComplete":true,
        "toolEvidenceRange":{"firstEntryId":8,"lastEntryId":12},
        "toolResults":[
            {"entryId":9,"toolCallId":"successful-edit","isError":false},
            {"entryId":10,"toolCallId":"failed-check","isError":true}
        ]});
        let progress = |value: &Value| {
            let Some(Outcome::Completed(result)) = interpret_status(value, "original").unwrap()
            else {
                panic!("expected a completed report");
            };
            result.progressed
        };
        assert!(
            progress(&base),
            "a failed check does not erase an observed successful edit"
        );
        let mut errors_only = base.clone();
        errors_only["toolResults"][0]["isError"] = json!(true);
        assert!(!progress(&errors_only));
        let mut interrupted_only = base.clone();
        interrupted_only["toolResults"][0]["interrupted"] = json!(true);
        assert!(!progress(&interrupted_only));
        let mut incomplete = base.clone();
        incomplete["toolEvidenceComplete"] = json!(false);
        assert!(!progress(&incomplete));
        let mut out_of_range = base.clone();
        out_of_range["toolResults"][1]["entryId"] = json!(99);
        assert!(!progress(&out_of_range));
        let mut malformed = base;
        malformed["toolResults"][1]
            .as_object_mut()
            .unwrap()
            .remove("isError");
        assert!(!progress(&malformed));
    }

    #[tokio::test]
    async fn framing_uses_lf_and_caps_unterminated_records() {
        let encoded = "{\"type\":\"response\",\"text\":\"a\u{2028}b\"}\n";
        let mut reader = BufReader::new(encoded.as_bytes());
        assert_eq!(
            read_record(&mut reader).await.unwrap().unwrap()["text"],
            "a\u{2028}b"
        );
        let too_long = vec![b'x'; MAX_FRAME + 1];
        assert!(read_record(&mut BufReader::new(too_long.as_slice()))
            .await
            .is_err());
    }

    #[test]
    fn missing_model_configuration_fails_before_any_worker_launch() {
        assert!(Target::from_config(&json!({}), "/tmp", Path::new("/tmp/pi-session")).is_err());
    }

    #[test]
    fn authentication_selection_is_explicit_persisted_and_checked_against_ready() {
        let root = tempfile::tempdir().unwrap();
        let entry = root.path().join("main.mjs");
        std::fs::write(&entry, "// no execution").unwrap();
        let config = json!({
            "nodePath":std::env::current_exe().unwrap(), "workerEntry":entry,
            "provider":"openai", "model":"configured-model",
            "permissions":{"read":false,"write":false,"commands":[]},
            "accessToken":"PRIVATE_CREDENTIAL_SENTINEL"
        });
        let target =
            Target::from_config(&config, root.path().to_str().unwrap(), root.path()).unwrap();
        assert_eq!(target.auth_mode, AuthMode::ApiKey);
        assert!(target.auth_path.is_none());
        let mut legacy = serde_json::to_value(&target).unwrap();
        assert!(!legacy.to_string().contains("PRIVATE_CREDENTIAL_SENTINEL"));
        legacy.as_object_mut().unwrap().remove("authMode");
        legacy.as_object_mut().unwrap().remove("authPath");
        assert_eq!(serde_json::from_value::<Target>(legacy).unwrap(), target);
        let ready = json!({"protocol":2,"fixture":false,"provider":target.provider,
            "model":target.model,"cwd":target.cwd,"sessionDir":target.session_dir,
            "permissions":target.permissions});
        validate_ready(&ready, &target, false).unwrap();
        let path = root.path().join("private-auth/auth.json");
        let mut oauth_config = config.clone();
        oauth_config["authMode"] = json!("oauth");
        oauth_config["authPath"] = json!(path);
        let oauth = Target::from_config(&oauth_config, &target.cwd, root.path()).unwrap();
        assert_eq!(oauth.auth_mode, AuthMode::Oauth);
        assert!(validate_ready(&ready, &oauth, false).is_err());
        let mut oauth_ready = ready;
        oauth_ready["authMode"] = json!("oauth");
        oauth_ready["authPath"] = json!(path);
        validate_ready(&oauth_ready, &oauth, false).unwrap();
        oauth_ready["authPath"] = json!(root.path().join("different-auth.json"));
        assert!(validate_ready(&oauth_ready, &oauth, false).is_err());

        let mut command = Command::new("not-executed");
        oauth
            .auth_mode
            .apply_args(&mut command, oauth.auth_path.as_deref());
        let args: Vec<_> = command
            .as_std()
            .get_args()
            .map(|arg| arg.to_str().unwrap())
            .collect();
        assert_eq!(
            args,
            vec![
                "--auth-mode",
                "oauth",
                "--auth-path",
                path.to_str().unwrap()
            ]
        );
        assert!(!path.parent().unwrap().exists());

        for (key, bad) in [
            ("authMode", Value::Null),
            ("authMode", json!("unknown")),
            ("authMode", json!(42)),
            ("authPath", json!(false)),
        ] {
            let mut invalid = oauth_config.clone();
            invalid[key] = bad;
            assert!(Target::from_config(&invalid, &target.cwd, root.path()).is_err());
        }
        for (mode, provider, path) in [
            ("oauth", "openai", Value::Null),
            ("oauth", "openai", json!("relative.json")),
            ("oauth", "anthropic", json!(path)),
            ("apiKey", "openai", json!(path)),
        ] {
            let mut invalid = config.clone();
            invalid["authMode"] = json!(mode);
            invalid["provider"] = json!(provider);
            invalid["authPath"] = path;
            assert!(Target::from_config(&invalid, &target.cwd, root.path()).is_err());
        }
    }

    #[tokio::test]
    async fn actual_pi_receipts_and_observation_deadlines_keep_owned_worker_identity() {
        let node = std::process::Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .expect("Node is required by the Pi integration fixture");
        assert!(node.status.success());
        let node_path = String::from_utf8(node.stdout).unwrap().trim().to_owned();
        let experiment = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join("experiments/pi-harness");
        std::fs::create_dir_all(experiment.join("artifacts")).unwrap();
        let storage = tempfile::tempdir_in(experiment.join("artifacts")).unwrap();
        let target = Target {
            managed: None,
            cwd: storage.path().to_str().unwrap().into(),
            session_dir: storage.path().to_str().unwrap().into(),
            node_path: node_path.clone(),
            worker_entry: std::fs::canonicalize(experiment.join("sidecar.mjs"))
                .unwrap()
                .to_str()
                .unwrap()
                .into(),
            provider: "faux".into(),
            model: "faux-1".into(),
            auth_mode: AuthMode::ApiKey,
            auth_path: None,
            permissions: Some(Permissions {
                read: true,
                write: true,
                commands: vec![],
            }),
        };
        let ready = json!({"protocol":2,"fixture":true,"provider":"faux","model":"faux-1",
            "cwd":target.cwd,"sessionDir":target.session_dir});
        assert!(
            validate_ready(&ready, &target, false).is_err(),
            "fixture cannot serve production"
        );
        let count = std::sync::atomic::AtomicUsize::new(0);
        let request = |allow_dispatch| Request {
            id: "native-pi-original".into(),
            prompt: "Apply fixture effect once".into(),
            schema: json!({}),
            persisted_payload: None,
            allow_dispatch,
        };
        let first = run_owned(
            target.clone(),
            request(true),
            CancellationToken::new(),
            || {
                count.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            true,
        )
        .await
        .unwrap();
        assert!(matches!(first, Outcome::Completed(_)));
        let owner = owned_worker(&target, true).await.unwrap();
        let owner_pid = owner.child.lock().await.id();
        let canonical = canonical_worker_target(&target).unwrap();
        let owners_before = WORKERS.get().unwrap().lock().await.len();
        // A model or mode change must not select another registry key and
        // start a second child against the same durable storage.
        let mut changed = target.clone();
        changed.model = "different-model".into();
        let error = owned_worker(&changed, true).await.err().unwrap();
        assert!(error.contains("different configuration"));
        let error = owned_worker(&target, false).await.err().unwrap();
        assert!(error.contains("different configuration"));
        let mut alias = target.clone();
        alias.session_dir = storage.path().join(".").to_str().unwrap().into();
        let aliased_owner = owned_worker(&alias, true).await.unwrap();
        assert!(Arc::ptr_eq(&owner, &aliased_owner));
        #[cfg(unix)]
        {
            let directory = tempfile::tempdir().unwrap();
            let link = directory.path().join("same-session");
            std::os::unix::fs::symlink(storage.path(), &link).unwrap();
            alias.session_dir = link.to_str().unwrap().into();
            let symlink_owner = owned_worker(&alias, true).await.unwrap();
            assert!(Arc::ptr_eq(&owner, &symlink_owner));
        }
        let owners = WORKERS.get().unwrap().lock().await;
        assert_eq!(owners.len(), owners_before);
        assert!(Arc::ptr_eq(
            owners.get(&canonical.session_dir).unwrap(),
            &owner
        ));
        drop(owners);
        assert_eq!(owner.child.lock().await.id(), owner_pid);
        assert!(owner.child.lock().await.try_wait().unwrap().is_none());
        let original_worker = owned_worker(&target, true).await.unwrap();
        let original_pid = original_worker.child.lock().await.id();
        original_worker.child.lock().await.kill().await.unwrap();
        assert!(original_worker
            .child
            .lock()
            .await
            .try_wait()
            .unwrap()
            .is_some());
        let recovered = run_owned(
            target.clone(),
            request(false),
            CancellationToken::new(),
            || panic!("recovery must not dispatch"),
            true,
        )
        .await
        .unwrap();
        assert!(matches!(recovered, Outcome::Completed(_)));
        let replacement = owned_worker(&target, true).await.unwrap();
        assert_ne!(replacement.child.lock().await.id(), original_pid);
        assert_eq!(count.load(Ordering::SeqCst), 1);
        let absent = Request {
            id: "unknown-native-request".into(),
            prompt: "Never send".into(),
            schema: json!({}),
            persisted_payload: None,
            allow_dispatch: false,
        };
        assert!(run_owned(
            target.clone(),
            absent,
            CancellationToken::new(),
            || panic!(),
            true
        )
        .await
        .is_err());
        assert_eq!(
            std::fs::read_to_string(storage.path().join("effects.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1
        );

        let mock_dir = tempfile::tempdir().unwrap();
        let script = mock_dir.path().join("mock.mjs");
        std::fs::write(&script, r#"
import readline from 'node:readline';
const flags = Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
emit({type:'ready',protocol:2,fixture:false,provider:flags['--provider'],model:flags['--model'],cwd:flags['--cwd'],sessionDir:flags['--session-dir'],permissions:JSON.parse(flags['--permissions-json']),authMode:flags['--auth-mode']??'apiKey',authPath:flags['--auth-path']??null});
readline.createInterface({input:process.stdin}).on('line',line=>{
 const r=JSON.parse(line); const respond=()=>emit({type:'response',id:r.id,command:r.type,success:true,data:{found:false,requestId:r.requestId}});
 if(r.type==='shutdown'){respond();process.exit(0);}
 else if(r.requestId==='slow')setTimeout(respond,150); else respond();
});
"#).unwrap();
        let mock_target = Target {
            managed: None,
            cwd: mock_dir.path().to_str().unwrap().into(),
            session_dir: mock_dir.path().join("new-storage").to_str().unwrap().into(),
            node_path,
            worker_entry: script.to_str().unwrap().into(),
            provider: "test".into(),
            model: "deterministic".into(),
            auth_mode: AuthMode::ApiKey,
            auth_path: None,
            permissions: Some(Permissions {
                read: false,
                write: false,
                commands: vec![],
            }),
        };
        let oauth_storage = tempfile::tempdir().unwrap();
        let mut oauth_target = mock_target.clone();
        oauth_target.session_dir = oauth_storage.path().to_str().unwrap().into();
        oauth_target.provider = "openai".into();
        oauth_target.auth_mode = AuthMode::Oauth;
        oauth_target.auth_path = Some(
            oauth_storage
                .path()
                .join("private-auth/auth.json")
                .to_str()
                .unwrap()
                .into(),
        );
        let oauth_worker = owned_worker(&oauth_target, false).await.unwrap();
        let oauth_pid = oauth_worker.child.lock().await.id();
        let identity = oauth_worker.ready.borrow().clone().unwrap().unwrap();
        assert_eq!(identity["authMode"], "oauth");
        assert_eq!(identity["authPath"], json!(oauth_target.auth_path));
        let mut replacement = oauth_target.clone();
        replacement.auth_path = Some(
            oauth_storage
                .path()
                .join("different-auth.json")
                .to_str()
                .unwrap()
                .into(),
        );
        assert!(owned_worker(&replacement, false)
            .await
            .err()
            .unwrap()
            .contains("different configuration"));
        replacement.auth_mode = AuthMode::ApiKey;
        replacement.auth_path = None;
        assert!(owned_worker(&replacement, false)
            .await
            .err()
            .unwrap()
            .contains("different configuration"));
        assert_eq!(oauth_worker.child.lock().await.id(), oauth_pid);
        assert!(!oauth_storage.path().join("private-auth").exists());
        let worker = owned_worker(&mock_target, false).await.unwrap();
        let pid = worker.child.lock().await.id();
        let timed_out = worker
            .request_before(
                "status",
                json!({"requestId":"slow"}),
                Duration::from_millis(20),
                || Ok(()),
            )
            .await;
        assert!(timed_out.is_err());
        assert!(worker.child.lock().await.try_wait().unwrap().is_none());
        let retained = owned_worker(&mock_target, false).await.unwrap();
        assert!(Arc::ptr_eq(&worker, &retained));
        assert_eq!(retained.child.lock().await.id(), pid);
        // An outer observation cancellation bypasses request_before's normal
        // return path. It must still release correlation state and leave the
        // already delivered frame's live worker available for the next read.
        let cancelled = tokio::time::timeout(
            Duration::from_millis(20),
            worker.request("status", json!({"requestId":"slow"})),
        )
        .await;
        assert!(cancelled.is_err());
        assert!(worker.waiters.lock().unwrap().is_empty());
        assert!(worker.connected.load(Ordering::Acquire));
        assert_eq!(worker.child.lock().await.id(), pid);
        assert_eq!(
            worker
                .request("status", json!({"requestId":"fast"}))
                .await
                .unwrap()["found"],
            false
        );
        let marked = std::sync::atomic::AtomicBool::new(false);
        assert!(worker
            .request_before(
                "submit",
                json!({"message":"x".repeat(MAX_FRAME)}),
                RPC_TIMEOUT,
                || {
                    marked.store(true, Ordering::SeqCst);
                    Ok(())
                }
            )
            .await
            .is_err());
        assert!(
            !marked.load(Ordering::SeqCst),
            "local validation precedes durable dispatch claim"
        );
        // The production runtime's test-only injector exercises this transport
        // against the real workspace-tool registry and permission identity.
        let production_root = tempfile::tempdir().unwrap();
        let production_cwd = production_root.path().join("workspace");
        std::fs::create_dir(&production_cwd).unwrap();
        std::fs::write(
            production_cwd.join("input.txt"),
            "Native-to-Pi workspace evidence",
        )
        .unwrap();
        let policy = Permissions {
            read: true,
            write: false,
            commands: vec![],
        };
        std::fs::write(
            production_cwd.join("fixture-policy.json"),
            serde_json::to_vec(&policy).unwrap(),
        )
        .unwrap();
        let production_fixture = Target {
            managed: None,
            cwd: production_cwd.to_str().unwrap().into(),
            session_dir: production_root
                .path()
                .join("storage")
                .to_str()
                .unwrap()
                .into(),
            node_path: target.node_path.clone(),
            worker_entry: Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .unwrap()
                .join("runtime/pi-worker/tests/fixture-entry.mjs")
                .to_str()
                .unwrap()
                .into(),
            provider: "faux".into(),
            model: "faux-1".into(),
            auth_mode: AuthMode::ApiKey,
            auth_path: None,
            permissions: Some(policy),
        };
        let admitted = std::sync::atomic::AtomicUsize::new(0);
        let production_request = |allow_dispatch| Request {
            id: "native-production-runtime".into(),
            prompt: "Read input.txt and report".into(),
            schema: json!({"type":"object"}),
            persisted_payload: Some(
                json!({"message":"Read input.txt and report","outputSchema":{"type":"object"}})
                    .to_string(),
            ),
            allow_dispatch,
        };
        let completed = run_owned(
            production_fixture.clone(),
            production_request(true),
            CancellationToken::new(),
            || {
                admitted.fetch_add(1, Ordering::SeqCst);
                Ok(())
            },
            true,
        )
        .await
        .unwrap();
        assert!(matches!(
            completed,
            Outcome::Completed(Report {
                progressed: true,
                ..
            })
        ));
        let recovered = run_owned(
            production_fixture.clone(),
            production_request(false),
            CancellationToken::new(),
            || panic!("Production-runtime receipt recovery must not redispatch"),
            true,
        )
        .await
        .unwrap();
        assert!(matches!(recovered, Outcome::Completed(_)));
        assert_eq!(admitted.load(Ordering::SeqCst), 1);
        // A saved host claim can precede Pi's atomic admission. Only managed
        // workers with the exact original persisted payload may admit that same
        // ID without claiming a new job or repeating the host dispatch claim.
        let mut before_admission = production_fixture.clone();
        before_admission.session_dir = production_root
            .path()
            .join("before-admission")
            .to_str()
            .unwrap()
            .into();
        let mut legacy = production_request(false);
        legacy.persisted_payload = None;
        assert!(run_owned(
            before_admission.clone(),
            legacy,
            CancellationToken::new(),
            || panic!("legacy uncertainty cannot dispatch"),
            true
        )
        .await
        .is_err());
        let prepared = owned_worker(&before_admission, true).await.unwrap();
        assert_eq!(
            prepared
                .request("status", json!({"requestId":"native-production-runtime"}))
                .await
                .unwrap()["modelCalls"],
            0
        );
        let admission = {
            let ready = prepared.ready.borrow();
            super::super::pi_outbox::admission(ready.as_ref().unwrap().as_ref().unwrap())
                .unwrap()
                .unwrap()
        };
        super::super::pi_outbox::prepare(
            &prepared.target,
            true,
            &production_request(true),
            &admission,
        )
        .unwrap();
        let retry = run_owned(
            before_admission.clone(),
            production_request(false),
            CancellationToken::new(),
            || panic!("same-ID admission retry cannot claim again"),
            true,
        )
        .await
        .unwrap();
        assert!(matches!(
            retry,
            Outcome::Completed(Report {
                progressed: true,
                ..
            })
        ));
        let calls = prepared
            .request("status", json!({"requestId":"native-production-runtime"}))
            .await
            .unwrap()["modelCalls"]
            .clone();
        run_owned(
            before_admission,
            production_request(false),
            CancellationToken::new(),
            || panic!("admitted work cannot be sent twice"),
            true,
        )
        .await
        .unwrap();
        assert_eq!(
            prepared
                .request("status", json!({"requestId":"native-production-runtime"}))
                .await
                .unwrap()["modelCalls"],
            calls
        );
        assert_eq!(
            std::fs::read_to_string(production_cwd.join("input.txt")).unwrap(),
            "Native-to-Pi workspace evidence"
        );
        // Interrupt after the native durable claim but before the first write.
        // The next owner must use the saved payload, not infer that a missing
        // receipt permits an arbitrary new submission.
        let gap_request = |allow_dispatch| Request {
            id: "native-admission-gap".into(),
            prompt: "Read input.txt and report the recovered request".into(),
            schema: json!({"type":"object","title":"first schema"}),
            persisted_payload: None,
            allow_dispatch,
        };
        let interrupted = run_owned(
            production_fixture.clone(),
            gap_request(true),
            CancellationToken::new(),
            || Err("simulated host stop after dispatch claim".into()),
            true,
        )
        .await
        .err()
        .unwrap();
        assert!(interrupted.contains("simulated host stop"));
        let before = owned_worker(&production_fixture, true).await.unwrap();
        let missing = before
            .request("status", json!({"requestId":"native-admission-gap"}))
            .await
            .unwrap();
        assert_eq!(missing["found"], false);
        before.child.lock().await.kill().await.unwrap();
        let mut recovered_request = gap_request(false);
        recovered_request.schema = json!({"type":"object","title":"new generated schema"});
        let recovered = run_owned(
            production_fixture.clone(),
            recovered_request,
            CancellationToken::new(),
            || panic!("already claimed recovery must not attempt a second native claim"),
            true,
        )
        .await
        .unwrap();
        assert!(matches!(
            recovered,
            Outcome::Completed(Report {
                progressed: true,
                ..
            })
        ));
        let after = owned_worker(&production_fixture, true).await.unwrap();
        let receipt = after
            .request("status", json!({"requestId":"native-admission-gap"}))
            .await
            .unwrap();
        assert_eq!(receipt["found"], true);
        assert_eq!(receipt["modelCalls"], 2);
        let repeated = run_owned(
            production_fixture,
            gap_request(false),
            CancellationToken::new(),
            || panic!("accepted gap recovery must only read its receipt"),
            true,
        )
        .await
        .unwrap();
        assert!(matches!(repeated, Outcome::Completed(_)));
        let receipt_again = after
            .request("status", json!({"requestId":"native-admission-gap"}))
            .await
            .unwrap();
        assert_eq!(receipt_again["submissionId"], receipt["submissionId"]);
        assert_eq!(receipt_again["modelCalls"], 2);
        assert_partial_write_repair(&target.node_path).await;
        shutdown_all().await;
        assert!(worker.child.lock().await.try_wait().unwrap().is_some());
    }

    async fn assert_partial_write_repair(node_path: &str) {
        let directory = tempfile::tempdir().unwrap();
        let script = directory.path().join("paused.mjs");
        std::fs::write(&script, r#"
import readline from 'node:readline';
const flags=Object.fromEntries(Array.from({length:(process.argv.length-2)/2},(_,i)=>[process.argv[2+i*2],process.argv[3+i*2]]));
const emit=v=>process.stdout.write(JSON.stringify(v)+'\n');
emit({type:'ready',protocol:2,fixture:false,provider:flags['--provider'],model:flags['--model'],cwd:flags['--cwd'],sessionDir:flags['--session-dir'],permissions:JSON.parse(flags['--permissions-json']),idempotentSubmit:true,requestDigestAlgorithm:'sha256-json-envelope-v1',ownerLock:'sqlite-exclusive'});
let effects=0;
process.stdin.pause();
setTimeout(()=>{
 readline.createInterface({input:process.stdin}).on('line',line=>{
  if(!line.trim())return;
  let r;try{r=JSON.parse(line);}catch{return;}
  if(r.type==='submit')effects++;
  emit({type:'response',id:r.id,command:r.type,success:true,data:{found:false,requestId:r.requestId,requestDigest:null,effects}});
  if(r.type==='shutdown')process.exit(0);
 });
},750);
"#).unwrap();
        let target = Target {
            managed: None,
            cwd: directory.path().to_str().unwrap().into(),
            session_dir: directory.path().join("storage").to_str().unwrap().into(),
            node_path: node_path.into(),
            worker_entry: script.to_str().unwrap().into(),
            provider: "transport-fixture".into(),
            model: "none".into(),
            auth_mode: AuthMode::ApiKey,
            auth_path: None,
            permissions: Some(Permissions {
                read: false,
                write: false,
                commands: vec![],
            }),
        };
        let worker = owned_worker(&target, false).await.unwrap();
        let pid = worker.child.lock().await.id();
        let timed_out = tokio::time::timeout(
            Duration::from_millis(20),
            worker.request(
                "submit",
                json!({"requestId":"original","message":"x".repeat(900_000)}),
            ),
        )
        .await;
        assert!(timed_out.is_err());
        assert!(
            worker.framing_dirty.load(Ordering::Acquire),
            "paused child must leave an unfinished frame"
        );
        assert!(worker.connected.load(Ordering::Acquire));
        let recovered = worker
            .request("status", json!({"requestId":"original"}))
            .await
            .unwrap();
        assert!(!worker.framing_dirty.load(Ordering::Acquire));
        assert_eq!(worker.child.lock().await.id(), pid);
        assert!(worker.child.lock().await.try_wait().unwrap().is_none());
        assert!(recovered["effects"].as_u64().unwrap() <= 1);
        let again = worker
            .request("status", json!({"requestId":"original"}))
            .await
            .unwrap();
        assert_eq!(again["effects"], recovered["effects"]);
        assert!(worker.waiters.lock().unwrap().is_empty());
    }
}

#[cfg(test)]
mod environment_tests {
    use super::*;
    #[test]
    fn worker_never_loads_inherited_node_preload_hooks_or_module_paths() {
        let mut command = Command::new("bundled-node");
        command
            .env("NODE_OPTIONS", "--require untrusted-hook")
            .env("NODE_PATH", "untrusted-modules");
        isolate_worker_environment(&mut command);
        for name in ["NODE_OPTIONS", "NODE_PATH"] {
            assert!(command
                .as_std()
                .get_envs()
                .any(|(key, value)| key == name && value.is_none()));
        }
    }
}
