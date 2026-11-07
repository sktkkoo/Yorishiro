//! User initiated Pi setup and browser login. No model work is dispatched here.
use super::pi_installation::{self, ConfigState, PortablePermissions, RuntimePaths, Settings};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, State, Window};
use tauri_plugin_opener::OpenerExt;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio_util::sync::CancellationToken;

const MAX_AUTH_OUTPUT: u64 = 64 * 1024;
const MAX_AUTH_LINE: usize = 8 * 1024;
const LOGIN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LoginStatus {
    phase: String,
    code: Option<String>,
}
impl Default for LoginStatus {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            code: None,
        }
    }
}
#[derive(Default)]
struct LoginInner {
    generation: u64,
    status: LoginStatus,
    cancel: Option<CancellationToken>,
}
#[derive(Clone, Default)]
pub struct PiSetupState(Arc<Mutex<LoginInner>>);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogModel {
    id: String,
    name: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AuthMetadata {
    protocol: u32,
    #[serde(rename = "type")]
    kind: String,
    authenticated: bool,
    authentication: String,
    models: Vec<CatalogModel>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    runtime_ready: bool,
    configured: bool,
    legacy_configuration: bool,
    authenticated: bool,
    authentication: String,
    model: String,
    models: Vec<CatalogModel>,
    permissions: PortablePermissions,
    workspace_available: bool,
    login: LoginStatus,
    code: Option<String>,
}

fn require_main(window: &Window) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("setup_unavailable".into())
    }
}
fn home() -> Result<PathBuf, String> {
    super::home().map_err(|_| "setup_unavailable".into())
}
fn login_snapshot(state: &PiSetupState) -> Result<LoginStatus, String> {
    state
        .0
        .lock()
        .map(|inner| inner.status.clone())
        .map_err(|_| "setup_unavailable".into())
}
fn known_workspace(cwd: Option<&str>) -> bool {
    cwd.is_some_and(|path| {
        !path.contains('\0') && Path::new(path).is_absolute() && Path::new(path).is_dir()
    })
}

fn configured_for_workspace(settings: &Settings, cwd: Option<&str>) -> bool {
    if !known_workspace(cwd) {
        return false;
    }
    settings.enabled
        && cwd
            .and_then(|cwd| super::pi_target::workspace_key(Path::new(cwd)).ok())
            .is_some_and(|key| settings.workspace_key.as_deref() == Some(key.as_str()))
}

fn bind_workspace(settings: &mut Settings, cwd: &str) -> Result<(), String> {
    let key = super::pi_target::workspace_key(Path::new(cwd))
        .map_err(|_| "workspace_unavailable".to_owned())?;
    if settings
        .workspace_key
        .as_ref()
        .is_some_and(|provided| provided != &key)
    {
        return Err("workspace_unavailable".into());
    }
    settings.workspace_key = Some(key);
    Ok(())
}

fn parse_metadata(bytes: &[u8]) -> Result<AuthMetadata, String> {
    let value: AuthMetadata =
        serde_json::from_slice(bytes).map_err(|_| "runtime_invalid".to_owned())?;
    if value.protocol != 1
        || value.kind != "auth_status"
        || value.models.len() > 1024
        || !["present", "missing", "invalid"].contains(&value.authentication.as_str())
        || value.authenticated != (value.authentication == "present")
        || value.models.iter().any(|model| {
            model.id.is_empty()
                || model.id.len() > 256
                || model.name.len() > 256
                || model.id.chars().any(char::is_control)
                || model.name.chars().any(char::is_control)
        })
    {
        return Err("runtime_invalid".into());
    }
    Ok(value)
}

fn auth_command(runtime: &RuntimePaths, auth_path: &Path, mode: &str) -> Command {
    let mut command = Command::new(&runtime.node);
    command
        .arg(&runtime.auth_entry)
        .arg(mode)
        .arg("--auth-path")
        .arg(auth_path)
        .env_remove("NODE_OPTIONS")
        .env_remove("NODE_PATH")
        .env_remove("OPENAI_API_KEY")
        .env_remove("ANTHROPIC_API_KEY")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    command
}

async fn metadata(runtime: &RuntimePaths, auth_path: &Path) -> Result<AuthMetadata, String> {
    let mut child = auth_command(runtime, auth_path, "--status")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "runtime_unavailable".to_owned())?;
    let mut stdout = child
        .stdout
        .take()
        .ok_or("runtime_invalid")?
        .take(MAX_AUTH_OUTPUT + 1);
    let mut bytes = Vec::new();
    let result = tokio::time::timeout(Duration::from_secs(5), async {
        let (read, status) = tokio::join!(stdout.read_to_end(&mut bytes), child.wait());
        read.map_err(|_| "runtime_invalid".to_owned())?;
        let status = status.map_err(|_| "runtime_invalid".to_owned())?;
        if !status.success() || bytes.len() as u64 > MAX_AUTH_OUTPUT {
            return Err("runtime_invalid".into());
        }
        parse_metadata(&bytes)
    })
    .await;
    match result {
        Ok(value) => value,
        Err(_) => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            Err("runtime_unavailable".into())
        }
    }
}

#[tauri::command]
pub async fn continuity_pi_setup_status(
    app: AppHandle,
    window: Window,
    state: State<'_, PiSetupState>,
    cwd: Option<String>,
) -> Result<SetupStatus, String> {
    require_main(&window)?;
    let home = home()?;
    let loaded = pi_installation::load(&home);
    let legacy_configuration = matches!(&loaded, Ok(ConfigState::Legacy));
    let mut code = loaded
        .as_ref()
        .err()
        .map(|_| "configuration_invalid".into());
    let (settings, configured) = match loaded {
        Ok(ConfigState::Managed(settings)) => {
            let configured = configured_for_workspace(&settings, cwd.as_deref());
            (settings, configured)
        }
        Ok(ConfigState::Legacy) => (
            pi_installation::legacy_suggestion(&home).unwrap_or_default(),
            false,
        ),
        _ => (Settings::default(), false),
    };
    let mut result = SetupStatus {
        runtime_ready: false,
        configured,
        legacy_configuration,
        authenticated: false,
        authentication: "missing".into(),
        model: settings.model,
        models: Vec::new(),
        permissions: if configured {
            settings.permissions
        } else {
            PortablePermissions::default()
        },
        workspace_available: known_workspace(cwd.as_deref()),
        login: login_snapshot(&state)?,
        code: None,
    };
    match pi_installation::runtime_paths(&app) {
        Ok(runtime) => {
            match verified_metadata(&runtime, &pi_installation::auth_path(&home)).await {
                Ok(auth) => {
                    result.runtime_ready = true;
                    result.authenticated = auth.authenticated;
                    result.authentication = auth.authentication;
                    result.models = auth.models;
                }
                Err(error) => code = Some(error),
            }
        }
        Err(_) => code = Some("runtime_unavailable".into()),
    }
    result.code = code;
    Ok(result)
}

async fn verified_metadata(
    runtime: &RuntimePaths,
    auth_path: &Path,
) -> Result<AuthMetadata, String> {
    pi_installation::verify_node(runtime).await?;
    metadata(runtime, auth_path).await
}

pub(super) async fn execution_ready(
    app: &AppHandle,
    home: &Path,
    cwd: Option<&str>,
) -> Result<bool, String> {
    if !known_workspace(cwd) {
        return Ok(false);
    }
    let settings = match pi_installation::load(home)? {
        ConfigState::Managed(settings) if configured_for_workspace(&settings, cwd) => settings,
        _ => return Ok(false),
    };
    let runtime = pi_installation::runtime_paths(app)?;
    let auth = verified_metadata(&runtime, &pi_installation::auth_path(home)).await?;
    Ok(auth.authenticated && auth.models.iter().any(|model| model.id == settings.model))
}

fn official_auth_url(value: &str) -> Result<tauri::Url, String> {
    if value.len() > MAX_AUTH_LINE {
        return Err("login_failed".into());
    }
    let url = tauri::Url::parse(value).map_err(|_| "login_failed".to_owned())?;
    let query: Vec<_> = url.query_pairs().collect();
    let redirects: Vec<_> = query
        .iter()
        .filter(|(key, _)| key == "redirect_uri")
        .collect();
    let responses: Vec<_> = query
        .iter()
        .filter(|(key, _)| key == "response_type")
        .collect();
    if url.scheme() != "https"
        || url.host_str() != Some("auth.openai.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/api/accounts/authorize"
        || url.fragment().is_some()
        || redirects.len() != 1
        || redirects[0].1 != "http://127.0.0.1:1455/auth/callback"
        || responses.len() != 1
        || responses[0].1 != "code"
    {
        return Err("login_failed".into());
    }
    Ok(url)
}

fn update_login(
    state: &PiSetupState,
    generation: u64,
    phase: &str,
    code: Option<&str>,
    finished: bool,
) {
    if let Ok(mut inner) = state.0.lock() {
        if inner.generation == generation {
            inner.status = LoginStatus {
                phase: phase.into(),
                code: code.map(str::to_owned),
            };
            if finished {
                inner.cancel = None;
            }
        }
    }
}

async fn stop_login_child(child: &mut Child) {
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"{\"type\":\"cancel\"}\n").await;
        let _ = stdin.shutdown().await;
    }
    if tokio::time::timeout(Duration::from_secs(5), child.wait())
        .await
        .is_err()
    {
        let _ = child.kill().await;
        let _ = child.wait().await;
    }
}

async fn run_login(
    runtime: RuntimePaths,
    auth_path: PathBuf,
    state: PiSetupState,
    generation: u64,
    cancel: CancellationToken,
    open: impl Fn(&str) -> Result<(), String>,
) -> Result<(), String> {
    let mut child = auth_command(&runtime, &auth_path, "--login")
        .arg("--timeout-seconds")
        .arg("600")
        .spawn()
        .map_err(|_| "runtime_unavailable".to_owned())?;
    let stderr = child.stderr.take().ok_or("login_failed")?;
    let drain = tokio::spawn(async move {
        let mut stderr = stderr;
        let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
    });
    let stdout = child
        .stdout
        .take()
        .ok_or("login_failed")?
        .take(MAX_AUTH_OUTPUT + 1);
    let mut lines = BufReader::new(stdout).lines();
    let deadline = tokio::time::sleep(LOGIN_TIMEOUT);
    tokio::pin!(deadline);
    let mut browser_opened = false;
    let mut connected = false;
    let result = loop {
        tokio::select! {
            _ = cancel.cancelled() => break Err("login_cancelled".into()),
            _ = &mut deadline => break Err("login_timeout".into()),
            line = lines.next_line() => {
                let line = match line { Ok(Some(line)) => line, Ok(None) => break Ok(()), Err(_) => break Err("login_failed".into()) };
                if line.len() > MAX_AUTH_LINE { break Err("login_failed".into()); }
                let record: serde_json::Value = match serde_json::from_str(&line) { Ok(value) => value, Err(_) => break Err("login_failed".into()) };
                match record.get("type").and_then(serde_json::Value::as_str) {
                    Some("auth_url") if !browser_opened => {
                        let Some(value) = record.get("url").and_then(serde_json::Value::as_str) else { break Err("login_failed".into()); };
                        let url = match official_auth_url(value) { Ok(url) => url, Err(error) => break Err(error) };
                        if open(url.as_str()).is_err() { break Err("browser_unavailable".into()); }
                        browser_opened = true;
                        update_login(&state, generation, "waiting", None, false);
                    },
                    Some("login_progress") => {},
                    Some("login_result") if record.get("connected") == Some(&serde_json::Value::Bool(true)) => connected = true,
                    Some("auth_error") => {
                        let code = match record.get("code").and_then(serde_json::Value::as_str) {
                            Some("login_cancelled") => "login_cancelled", Some("login_timeout") => "login_timeout", _ => "login_failed",
                        };
                        break Err(code.into());
                    },
                    _ => break Err("login_failed".into()),
                }
            },
        }
    };
    let outcome = if result.is_ok() && connected && browser_opened {
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(status)) if status.success() => Ok(()),
            _ => {
                stop_login_child(&mut child).await;
                Err("login_failed".into())
            }
        }
    } else {
        stop_login_child(&mut child).await;
        result.and(Err("login_failed".into()))
    };
    drain.abort();
    outcome
}

#[tauri::command]
pub fn continuity_pi_login_status(
    window: Window,
    state: State<'_, PiSetupState>,
) -> Result<LoginStatus, String> {
    require_main(&window)?;
    login_snapshot(&state)
}

#[tauri::command]
pub async fn continuity_pi_login_start(
    app: AppHandle,
    window: Window,
    state: State<'_, PiSetupState>,
) -> Result<LoginStatus, String> {
    require_main(&window)?;
    let runtime =
        pi_installation::runtime_paths(&app).map_err(|_| "runtime_unavailable".to_owned())?;
    pi_installation::verify_node(&runtime).await?;
    let auth_path = pi_installation::auth_path(&home()?);
    let (generation, cancel, result) = reserve_login(&state)?;
    let owned = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let open = |url: &str| {
            app.opener()
                .open_url(url, None::<&str>)
                .map_err(|_| "browser_unavailable".into())
        };
        match run_login(runtime, auth_path, owned.clone(), generation, cancel, open).await {
            Ok(()) => update_login(&owned, generation, "connected", None, true),
            Err(error) => update_login(
                &owned,
                generation,
                if error == "login_cancelled" {
                    "cancelled"
                } else {
                    "error"
                },
                Some(&error),
                true,
            ),
        }
    });
    Ok(result)
}

fn reserve_login(state: &PiSetupState) -> Result<(u64, CancellationToken, LoginStatus), String> {
    let mut inner = state.0.lock().map_err(|_| "setup_unavailable".to_owned())?;
    if inner.cancel.is_some() {
        return Err("login_busy".into());
    }
    let cancel = CancellationToken::new();
    inner.generation = inner.generation.wrapping_add(1);
    inner.cancel = Some(cancel.clone());
    inner.status = LoginStatus {
        phase: "starting".into(),
        code: None,
    };
    Ok((inner.generation, cancel, inner.status.clone()))
}

#[tauri::command]
pub fn continuity_pi_login_cancel(
    window: Window,
    state: State<'_, PiSetupState>,
) -> Result<LoginStatus, String> {
    require_main(&window)?;
    let mut inner = state.0.lock().map_err(|_| "setup_unavailable".to_owned())?;
    if let Some(cancel) = &inner.cancel {
        cancel.cancel();
        inner.status.phase = "cancelling".into();
    }
    Ok(inner.status.clone())
}

pub fn shutdown(state: &PiSetupState) {
    if let Ok(inner) = state.0.lock() {
        if let Some(cancel) = &inner.cancel {
            cancel.cancel();
        }
    }
}

#[tauri::command]
pub async fn continuity_pi_setup_save(
    app: AppHandle,
    window: Window,
    state: State<'_, PiSetupState>,
    cwd: Option<String>,
    mut settings: Settings,
) -> Result<SetupStatus, String> {
    require_main(&window)?;
    if state
        .0
        .lock()
        .map_err(|_| "setup_unavailable".to_owned())?
        .cancel
        .is_some()
    {
        return Err("login_busy".into());
    }
    if !known_workspace(cwd.as_deref()) {
        return Err("workspace_unavailable".into());
    }
    bind_workspace(
        &mut settings,
        cwd.as_deref().ok_or("workspace_unavailable")?,
    )?;
    let home = home()?;
    let runtime =
        pi_installation::runtime_paths(&app).map_err(|_| "runtime_unavailable".to_owned())?;
    let auth = verified_metadata(&runtime, &pi_installation::auth_path(&home)).await?;
    if !auth.authenticated {
        return Err("authentication_required".into());
    }
    if !auth.models.iter().any(|model| model.id == settings.model) {
        return Err("model_unavailable".into());
    }
    {
        let mut inner = state.0.lock().map_err(|_| "setup_unavailable".to_owned())?;
        if inner.cancel.is_some() {
            return Err("login_busy".into());
        }
        pi_installation::save(&home, &settings).map_err(|_| "configuration_invalid".to_owned())?;
        if matches!(inner.status.phase.as_str(), "error" | "cancelled") {
            inner.status = LoginStatus::default();
        }
    }
    continuity_pi_setup_status(app, window, state, cwd).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_urls_are_restricted_to_the_official_oauth_endpoint() {
        assert!(official_auth_url(
            "https://auth.openai.com/api/accounts/authorize?state=transient&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback"
        )
        .is_ok());
        for value in [
            "http://auth.openai.com/api/accounts/authorize",
            "https://auth.openai.com.attacker.invalid/api/accounts/authorize",
            "https://user:secret@auth.openai.com/api/accounts/authorize",
            "https://auth.openai.com:444/api/accounts/authorize",
            "https://auth.openai.com/log-in",
            "file:///private/auth.json",
            "https://auth.openai.com/api/accounts/authorize#secret",
        ] {
            assert!(official_auth_url(value).is_err());
        }
    }

    #[test]
    fn metadata_is_typed_and_never_contains_credentials_or_browser_urls() {
        let record = br#"{"protocol":1,"type":"auth_status","authenticated":false,"authentication":"missing","models":[{"id":"model","name":"Model"}]}"#;
        assert!(parse_metadata(record).is_ok());
        assert!(parse_metadata(br#"{"protocol":1,"type":"auth_status","authenticated":true,"authentication":"missing","models":[]}"#).is_err());
        assert!(parse_metadata(br#"{"protocol":1,"type":"auth_status","authenticated":false,"authentication":"missing","models":[],"token":"PRIVATE"}"#).is_err());
        let state = PiSetupState::default();
        update_login(&state, 0, "waiting", None, false);
        let text = serde_json::to_string(&login_snapshot(&state).unwrap()).unwrap();
        assert_eq!(text, r#"{"phase":"waiting","code":null}"#);
    }

    #[test]
    fn stale_login_completion_cannot_override_current_attempt() {
        let state = PiSetupState::default();
        state.0.lock().unwrap().generation = 2;
        update_login(&state, 1, "connected", None, true);
        assert_eq!(login_snapshot(&state).unwrap().phase, "idle");
        let cancel = CancellationToken::new();
        state.0.lock().unwrap().cancel = Some(cancel.clone());
        shutdown(&state);
        assert!(cancel.is_cancelled());
    }
}

#[cfg(all(test, unix))]
mod lifecycle_tests {
    use super::*;

    fn fixture(script: &str) -> (tempfile::TempDir, RuntimePaths, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let entry = directory.path().join("login.sh");
        std::fs::write(&entry, script).unwrap();
        let runtime = RuntimePaths {
            node: PathBuf::from("/bin/sh"),
            worker: entry.clone(),
            diagnostic: entry.clone(),
            auth_entry: entry,
            manifest_fingerprint: "fixture".into(),
            version: "fixture".into(),
        };
        let path = directory.path().join("owned-pid");
        (directory, runtime, path)
    }

    #[test]
    fn a_cancelled_attempt_keeps_exclusive_ownership_until_cleanup_finishes() {
        let state = PiSetupState::default();
        let (generation, cancel, _) = reserve_login(&state).unwrap();
        assert!(reserve_login(&state).is_err());
        cancel.cancel();
        assert!(reserve_login(&state).is_err());
        update_login(
            &state,
            generation,
            "cancelled",
            Some("login_cancelled"),
            true,
        );
        assert!(reserve_login(&state).is_ok());
    }

    #[tokio::test]
    async fn a_completed_browser_flow_reaps_the_exact_login_child() {
        let (_directory,runtime,path)=fixture("printf '%s' \"$$\" > \"$3\"\nprintf '%s\\n' '{\"type\":\"auth_url\",\"url\":\"https://auth.openai.com/api/accounts/authorize?state=fixture&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback\"}' '{\"type\":\"login_result\",\"connected\":true}'\n");
        let state = PiSetupState::default();
        let (generation, cancel, _) = reserve_login(&state).unwrap();
        run_login(runtime, path.clone(), state, generation, cancel, |_| Ok(()))
            .await
            .unwrap();
        let pid: libc::pid_t = std::fs::read_to_string(path).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[tokio::test]
    async fn cancellation_closes_the_browser_login_without_an_orphan_process() {
        let (_directory,runtime,path)=fixture("printf '%s' \"$$\" > \"$3\"\nprintf '%s\\n' '{\"type\":\"auth_url\",\"url\":\"https://auth.openai.com/api/accounts/authorize?state=fixture&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A1455%2Fauth%2Fcallback\"}'\nread -r request\n");
        let state = PiSetupState::default();
        let (generation, cancel, _) = reserve_login(&state).unwrap();
        let observed = state.clone();
        let stop = cancel.clone();
        let pid_path = path.clone();
        let task = tokio::spawn(async move {
            run_login(runtime, path, observed, generation, cancel, |_| Ok(())).await
        });
        for _ in 0..100 {
            if login_snapshot(&state).unwrap().phase == "waiting" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(login_snapshot(&state).unwrap().phase, "waiting");
        stop.cancel();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), task)
                .await
                .unwrap()
                .unwrap()
                .unwrap_err(),
            "login_cancelled"
        );
        let pid: libc::pid_t = std::fs::read_to_string(pid_path).unwrap().parse().unwrap();
        assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    #[tokio::test]
    async fn an_unexpected_url_never_reaches_the_browser_and_failure_is_redacted() {
        let (_directory,runtime,path)=fixture("printf '%s' \"$$\" > \"$3\"\nprintf '%s\\n' '{\"type\":\"auth_url\",\"url\":\"https://PRIVATE.invalid/api/accounts/authorize\"}'\nread -r request\n");
        let state = PiSetupState::default();
        let (generation, cancel, _) = reserve_login(&state).unwrap();
        let result = run_login(runtime, path, state, generation, cancel, |_| {
            panic!("must not open untrusted URLs")
        })
        .await;
        assert_eq!(result.unwrap_err(), "login_failed");
    }
}

#[cfg(test)]
mod workspace_permission_tests {
    use super::*;

    #[test]
    fn approval_for_one_folder_never_configures_another_folder_without_explicit_save() {
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path().join("profile");
        let first = temp.path().join("project a");
        let second = temp.path().join("project b");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        let mut settings = Settings {
            enabled: true,
            permissions: PortablePermissions {
                read: true,
                write: true,
                commands: vec![],
            },
            ..Settings::default()
        };
        bind_workspace(&mut settings, first.to_str().unwrap()).unwrap();
        pi_installation::save(&home, &settings).unwrap();
        let path = home.join("continuity/pi-worker.json");
        let before = std::fs::read(&path).unwrap();
        assert!(configured_for_workspace(&settings, first.to_str()));
        assert!(!configured_for_workspace(&settings, second.to_str()));
        assert!(!configured_for_workspace(&settings, None));
        assert_eq!(
            std::fs::read(&path).unwrap(),
            before,
            "read-only readiness never mutates preferences"
        );
        assert!(
            bind_workspace(&mut settings, second.to_str().unwrap()).is_err(),
            "stale supplied folder keys cannot be silently rebound"
        );
        settings.workspace_key = None;
        bind_workspace(&mut settings, second.to_str().unwrap()).unwrap();
        pi_installation::save(&home, &settings).unwrap();
        assert!(!configured_for_workspace(&settings, first.to_str()));
        assert!(configured_for_workspace(&settings, second.to_str()));
        let text = String::from_utf8(std::fs::read(path).unwrap()).unwrap();
        assert!(!text.contains(first.to_str().unwrap()));
        assert!(!text.contains(second.to_str().unwrap()));
    }

    #[test]
    fn an_older_unbound_managed_setting_requires_a_workspace_review() {
        let temp = tempfile::tempdir().unwrap();
        let settings = Settings {
            enabled: true,
            ..Settings::default()
        };
        assert!(settings.validate().is_ok());
        assert!(!configured_for_workspace(&settings, temp.path().to_str()));
        let mut invalid = settings;
        invalid.workspace_key = Some("UPPERCASE_OR_PATH".into());
        assert!(invalid.validate().is_err());
    }
}
