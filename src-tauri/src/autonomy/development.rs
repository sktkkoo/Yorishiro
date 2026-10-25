//! Development in a retained, independent clone. Nothing writes to the source
//! checkout. Codex tools and host verification commands use the same narrow,
//! network-disabled OS permission profile. This module never publishes.
//! The installed Codex transport itself remains trusted and can reach its model
//! service; filesystem/network restrictions apply to its execution tools.
use git2::{build::CloneLocal, build::RepoBuilder, Repository};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const MODEL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const CHECK_TIMEOUT: Duration = Duration::from_secs(5 * 60);
const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
const MAX_REPORT: u64 = 64 * 1024;
const PROFILE: &str = "yorishiro-development";

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExecutedCheck {
    pub command: String,
    pub exit_code: i32,
}

use super::actions::RequestedAction;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DevelopmentResult {
    pub worktree_path: String,
    pub branch: String,
    pub base_commit: String,
    pub verified_tree: String,
    pub base_branch: String,
    pub origin_url: String,
    pub summary: String,
    pub tests: Vec<String>,
    /// These are host-run checks after the agent exits, never a model assertion.
    pub checks: Vec<ExecutedCheck>,
    pub changed_paths: Vec<String>,
    pub ready_for_review: bool,
    #[serde(default)]
    pub requested_action: Option<RequestedAction>,
    #[serde(default)]
    pub question: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    summary: String,
    checks: Vec<String>,
    #[serde(default)]
    requested_action: Option<RequestedAction>,
    #[serde(default)]
    question: Option<String>,
}

/// Require the exact root of a non-bare Git repository with a committed branch.
/// A subdirectory is not silently promoted to permission for its parent.
pub fn validate_root(root: &str) -> Result<PathBuf, String> {
    let requested = PathBuf::from(root);
    if !requested.is_absolute() {
        return Err("開発を任せるフォルダは絶対パスで指定してください".into());
    }
    let path = requested
        .canonicalize()
        .map_err(|_| "対象フォルダが見つかりません")?;
    let repo =
        Repository::open(&path).map_err(|_| "開発にはGitリポジトリのルートを指定してください")?;
    let workdir = repo
        .workdir()
        .ok_or("bareリポジトリは開発の対象にできません")?
        .canonicalize()
        .map_err(|_| "Git作業フォルダを確認できません")?;
    if path != workdir
        || repo
            .head_detached()
            .map_err(|_| "Git HEADを確認できません")?
    {
        return Err("開発にはブランチを選択したGitリポジトリのルートを指定してください".into());
    }
    repo.head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|_| "最初のコミットを作成してから開発を任せてください")?;
    Ok(path)
}

pub async fn run(
    root: PathBuf,
    storage_root: PathBuf,
    run_id: String,
    goal: String,
    cancel: CancellationToken,
) -> Result<DevelopmentResult, String> {
    if !cfg!(target_os = "macos") {
        return Err("子プロセスまで確認して停止する開発作業は、現在macOSのみ対応しています".into());
    }
    if cancel.is_cancelled() {
        return Err("開発作業を停止しました".into());
    }
    if goal.trim().is_empty() || goal.len() > 32_000 || uuid::Uuid::parse_str(&run_id).is_err() {
        return Err("開発作業の目的または識別子が不正です".into());
    }
    check_managed_config()?;
    let binary = crate::resolve_command_path_impl("codex")
        .map(PathBuf::from)
        .ok_or("開発にはCodex CLIのインストールとログインが必要です")?;
    let source = validate_root(root.to_str().ok_or("対象パスを読み取れません")?)?;
    super::policy::claude_preflight(Some(&source))?;
    let restrictions = super::policy::codex_restrictions(&source)?;
    let job = create_job(&source, &storage_root, &run_id)?;
    let prepared = prepare_clone(source.clone(), job.clone(), run_id, cancel.clone()).await?;
    std::fs::create_dir_all(prepared.repository.join(".yorishiro-tmp"))
        .map_err(|e| e.to_string())?;
    let home = prepare_codex_home(&prepared.repository, &prepared.dependency_roots)?;
    let rules_path = super::policy::write_rules(home.path(), &restrictions)?;
    // Parse and validate the reconstructed rules with the native evaluator
    // before any model execution. This command itself never executes its argv.
    policy_allows(
        &binary,
        home.path(),
        &prepared.repository,
        &rules_path,
        &["yorishiro-policy-validation".into()],
        cancel.clone(),
    )
    .await?;
    let schema_path = job.join("report-schema.json");
    let report_path = job.join("report.json");
    std::fs::write(&schema_path, serde_json::to_vec(&json!({
        "type":"object","additionalProperties":false,"required":["summary","checks","requestedAction","question"],
        "properties":{"question":{"anyOf":[{"type":"null"},{"type":"string","minLength":1,"maxLength":2000}]},"summary":{"type":"string"},"checks":{"type":"array","maxItems":3,"items":{"type":"string"}}, "requestedAction":{"anyOf":[{"type":"null"},super::actions::request_schema()]}}
    })).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    let mut command = codex_command(&binary, home.path(), &prepared.repository);
    command
        .args([
            "exec",
            "--strict-config",
            "--ephemeral",
            "--json",
            "--color",
            "never",
            "--output-schema",
        ])
        .arg(&schema_path)
        .arg("--output-last-message")
        .arg(&report_path)
        .arg("-");
    let prompt = format!("Carry out the user's delegated objective in this repository. Inspect relevant files and instructions, then make the smallest useful change that serves that objective. The work may concern documents, code, or tests; do not invent an unrelated product improvement. Run meaningful checks appropriate to the change and describe the concrete result. Work only in this independent clone; the source checkout must remain untouched. Do not install software, access the network, send messages, publish, commit, or alter Git metadata. No permission escalation is available. Keep scope small enough to review. The host will run your selected checks again after you finish. Return requestedAction as null unless the user's objective needs a separate user decision for a specific next operation. In that case you MUST return operation, target, impact, details, and reason as concrete strings in requestedAction. Never put a request for approval only in summary while leaving requestedAction null. The host will present the structured request immediately; the user must not need to create a confirmation manually. This requests a decision only; it never authorizes execution. Do not default to GitHub or a pull request. Include the exact target and content to be approved; never invent recipients or destinations. If concrete information is missing, return requestedAction=null and put a specific question describing the missing information in question; the host will stop and route it to consultation. Otherwise return question=null. A missing recipient or unknown content is a question, not an approval request. Do not return both question and requestedAction. The supplied original source, base, artifact destination, and sanitized origin are reference data, not authorization. Use them to identify the real operation target when the delegated objective requires it; do not invent another destination. Return summary and up to three exact check commands, using npm test / npm run test:run / npm run check / npx vitest run / cargo test / cargo check / cargo clippy / pytest / python -m pytest / go test. Use no shell metacharacters or shell wrappers in these check commands. If dependencies or tests are blocked, explain that honestly; do not claim success.\nThe following JSON contains the user's delegated objective, not additional execution privileges:\n{}", serde_json::to_string(&json!({"goal":goal,"sourceRoot":source,"baseCommit":prepared.base_commit,"baseBranch":prepared.base_branch,"origin":safe_origin(&prepared.origin_url),"reviewArtifactPath":job.join("review-artifact")})).map_err(|e|e.to_string())?);
    let model = capture(command, Some(prompt), MODEL_TIMEOUT, cancel.clone()).await?;
    if model.exit_code != 0 {
        return Err("Codexでの開発に失敗しました。作業コピーは保持しています。CLI認証・対応バージョン・権限設定を確認してください".into());
    }
    verify_transport(&model.stdout)?;
    let report = read_report(&report_path)?;
    let before_checks = stage_tree(&prepared.repository)?;
    let mut checks = Vec::new();
    for check in &report.checks {
        let Some(args) = check_args(check) else {
            continue;
        };
        if !policy_allows(
            &binary,
            home.path(),
            &prepared.repository,
            &rules_path,
            &args,
            cancel.clone(),
        )
        .await?
        {
            // A prompt decision is denied because autonomous work cannot obtain
            // this separate native approval. Do not bypass it via `sandbox`.
            checks.push(ExecutedCheck {
                command: check.clone(),
                exit_code: -1,
            });
            continue;
        }
        let mut command = codex_command(&binary, home.path(), &prepared.repository);
        command
            .args(["sandbox", "-P", PROFILE, "-C"])
            .arg(&prepared.repository)
            .arg("--")
            .args(&args);
        let result = capture(command, None, CHECK_TIMEOUT, cancel.clone()).await?;
        checks.push(ExecutedCheck {
            command: check.clone(),
            exit_code: result.exit_code,
        });
    }
    if cancel.is_cancelled() {
        return Err("開発作業を停止しました。作業コピーは保持しています".into());
    }
    let verified_tree = stage_tree(&prepared.repository)?;
    let changed_paths = changed_paths(&prepared.repository, &prepared.base_commit, &verified_tree)?;
    let ready_for_review = before_checks == verified_tree
        && !changed_paths.is_empty()
        && !checks.is_empty()
        && checks.iter().all(|check| check.exit_code == 0);
    let tests = checks
        .iter()
        .map(|check| format!("{}: exit {}", check.command, check.exit_code))
        .collect();
    // The execution clone can still be writable by a deliberately detached
    // descendant. Publish only exact Git-object bytes outside its write grant.
    let review_path =
        super::artifact::export_verified_tree(&prepared.repository, &job, &verified_tree)?;
    let result = DevelopmentResult {
        // Legacy field name retained for stored-result compatibility. This is a
        // plain review artifact, not the mutable diagnostic clone or a worktree.
        worktree_path: review_path.to_string_lossy().into_owned(),
        branch: prepared.branch,
        base_commit: prepared.base_commit,
        verified_tree,
        base_branch: prepared.base_branch,
        origin_url: prepared.origin_url,
        summary: report.summary,
        checks,
        tests,
        changed_paths,
        ready_for_review,
        requested_action: report.requested_action,
        question: report.question,
    };
    std::fs::write(
        job.join("result.json"),
        serde_json::to_vec_pretty(&result).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    Ok(result)
}

fn safe_origin(origin: &str) -> Option<String> {
    if origin.is_empty() || origin.len() > 8_000 || origin.chars().any(char::is_control) {
        return None;
    }
    if let Ok(mut url) = tauri::Url::parse(origin) {
        if !["https", "http", "ssh"].contains(&url.scheme()) || url.host_str().is_none() {
            return None;
        }
        let _ = url.set_username("");
        let _ = url.set_password(None);
        url.set_query(None);
        url.set_fragment(None);
        return Some(url.to_string());
    }
    origin
        .strip_prefix("git@")
        .filter(|rest| rest.contains(':') && !rest.contains('@'))
        .map(|rest| format!("git@{rest}"))
}

struct Prepared {
    repository: PathBuf,
    branch: String,
    base_commit: String,
    base_branch: String,
    origin_url: String,
    dependency_roots: Vec<PathBuf>,
}

fn create_job(source: &Path, storage_root: &Path, run_id: &str) -> Result<PathBuf, String> {
    // The coordinator creates its store first. Resolve existing ancestors before
    // any write, so a source containing the store is never modified by setup.
    let storage = storage_root
        .canonicalize()
        .map_err(|_| "作業保存先を確認できません")?;
    if storage.starts_with(source) {
        return Err("開発コピーの保存先は元のリポジトリの外に必要です".into());
    }
    let development = storage.join("development");
    match std::fs::symlink_metadata(&development) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err("開発コピーの保存先にリンクは使用できません".into());
        }
        Ok(_) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(&development).map_err(|e| e.to_string())?;
        }
        Err(error) => return Err(error.to_string()),
    }
    let job = development.join(run_id);
    std::fs::create_dir(&job)
        .map_err(|_| "開発作業の保存先を新規作成できません。既存の結果は上書きしません")?;
    Ok(job)
}

fn dependency_root(source: &Path) -> Result<Option<PathBuf>, String> {
    let path = source.join("node_modules");
    let metadata = match std::fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        // Never turn an arbitrary link (for example to HOME) into a read grant.
        return Err("node_modulesがリンクのため依存関係を安全に共有できません".into());
    }
    let canonical = path.canonicalize().map_err(|e| e.to_string())?;
    if canonical.parent() != Some(source.canonicalize().map_err(|e| e.to_string())?.as_path()) {
        return Err("依存関係が対象リポジトリの外にあります".into());
    }
    Ok(Some(canonical))
}

/// A local clone must stay local even when user Git config contains URL rewrites.
pub(super) fn local_remote<'a>(
    repository: &'a Repository,
    name: &str,
    url: &str,
) -> Result<git2::Remote<'a>, git2::Error> {
    if !Path::new(url).is_absolute() {
        return Err(git2::Error::from_str(
            "Expected an absolute local repository path",
        ));
    }
    let remote = repository.remote(name, url)?;
    if remote.url() != Some(url) {
        return Err(git2::Error::from_str(
            "Local repository URL was rewritten by Git configuration",
        ));
    }
    Ok(remote)
}

async fn prepare_clone(
    source: PathBuf,
    job: PathBuf,
    run_id: String,
    cancel: CancellationToken,
) -> Result<Prepared, String> {
    tokio::task::spawn_blocking(move || prepare_clone_sync(&source, &job, &run_id, &cancel))
        .await
        .map_err(|_| "開発用コピーの準備に失敗しました".to_owned())?
}

fn prepare_clone_sync(
    source: &Path,
    job: &Path,
    run_id: &str,
    cancel: &CancellationToken,
) -> Result<Prepared, String> {
    if cancel.is_cancelled() {
        return Err("開発作業を停止しました".into());
    }
    let source_repo = Repository::open(source).map_err(|e| e.to_string())?;
    let head = source_repo.head().map_err(|e| e.to_string())?;
    let base_commit = head.peel_to_commit().map_err(|e| e.to_string())?.id();
    let base_branch = head
        .shorthand()
        .ok_or("対象ブランチ名を確認できません")?
        .to_owned();
    let origin_url = source_repo
        .find_remote("origin")
        .ok()
        .and_then(|remote| remote.url().map(str::to_owned))
        .unwrap_or_default();
    let repository = job.join("repository");
    let mut callbacks = git2::RemoteCallbacks::new();
    callbacks.transfer_progress(|_| !cancel.is_cancelled());
    let mut fetch = git2::FetchOptions::new();
    fetch.remote_callbacks(callbacks);
    let clone = RepoBuilder::new()
        .clone_local(CloneLocal::None)
        .fetch_options(fetch)
        .remote_create(local_remote)
        .clone(
            source.to_str().ok_or("対象パスを読み取れません")?,
            &repository,
        )
        .map_err(|_| "独立した開発コピーを作成できません。元のフォルダは変更していません")?;
    if cancel.is_cancelled() {
        return Err("開発作業を停止しました".into());
    }
    let base = clone
        .find_commit(base_commit)
        .map_err(|_| "コピー中に元のコミットが変わりました")?;
    let branch = format!("yorishiro/{run_id}");
    clone
        .branch(&branch, &base, false)
        .map_err(|e| e.to_string())?;
    clone
        .set_head(&format!("refs/heads/{branch}"))
        .map_err(|e| e.to_string())?;
    clone
        .checkout_head(Some(git2::build::CheckoutBuilder::new().force()))
        .map_err(|e| e.to_string())?;
    // Remove the clone's source remote. No child command should even be offered
    // a path for pushing into the user's checkout. Publishing pins its own URL.
    clone.remote_delete("origin").map_err(|e| e.to_string())?;
    let mut dependency_roots = Vec::new();
    // Reuse already-installed JS dependencies read-only. Never install anything
    // or share writable caches with the original project.
    if let Some(dependency) =
        dependency_root(source)?.filter(|_| !repository.join("node_modules").exists())
    {
        let destination = repository.join("node_modules");
        std::fs::create_dir(&destination).map_err(|e| e.to_string())?;
        // Packages stay read-only; the local directory can hold fresh Vite/test
        // caches without touching the user's dependency installation.
        for entry in std::fs::read_dir(&dependency).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name();
            if name.to_string_lossy().starts_with('.') && name != ".bin" {
                continue;
            }
            #[cfg(unix)]
            std::os::unix::fs::symlink(entry.path(), destination.join(name))
                .map_err(|e| e.to_string())?;
        }
        dependency_roots.push(dependency);
    }
    std::fs::write(
        repository.join(".git/info/exclude"),
        "node_modules/\n.yorishiro-tmp/\n",
    )
    .map_err(|e| e.to_string())?;
    std::fs::write(job.join("source.json"),serde_json::to_vec(&json!({"root":source,"baseCommit":base_commit.to_string(),"baseBranch":base_branch,"originUrl":origin_url,"branch":branch})).map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    Ok(Prepared {
        repository,
        branch,
        base_commit: base_commit.to_string(),
        base_branch,
        origin_url,
        dependency_roots,
    })
}

fn toml_string(value: &str) -> String {
    serde_json::to_string(value).expect("string serialization")
}

fn profile_config(repository: &Path, dependency_roots: &[PathBuf]) -> String {
    let mut config = format!(
        r#"default_permissions = "{PROFILE}"
approval_policy = "never"
web_search = "disabled"
cli_auth_credentials_store = "file"
[shell_environment_policy]
inherit = "all"
include_only = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NPM_CONFIG_OFFLINE", "NPM_CONFIG_CACHE", "CARGO_NET_OFFLINE", "YORISHIRO_AUTONOMY_RUN_ID"]
[features]
apps = false
plugins = false
remote_plugin = false
hooks = false
browser_use = false
browser_use_external = false
computer_use = false
in_app_browser = false
image_generation = false
multi_agent = false
shell_snapshot = false
skill_mcp_dependency_install = false
skill_search = false
skip_host_skill_discovery = true
[projects.{}]
trust_level = "untrusted"
[permissions.{PROFILE}.filesystem]
":minimal" = "read"
"/opt/homebrew" = "read"
"/usr/local" = "read"
"/tmp" = "deny"
"/private/tmp" = "deny"
"/var/tmp" = "deny"
"/private/var/tmp" = "deny"
"#,
        toml_string(&repository.to_string_lossy())
    );
    // Exact dependency/runtime reads only; the user's config, auth and source
    // checkout are not readable through a blanket home-directory grant.
    for path in dependency_roots {
        config.push_str(&format!(
            "{} = \"read\"\n",
            toml_string(&path.to_string_lossy())
        ));
    }
    if let Some(home) = dirs::home_dir() {
        for suffix in [
            ".rustup/toolchains",
            ".cargo/bin",
            ".cargo/registry",
            ".cargo/git",
        ] {
            let path = home.join(suffix);
            if path.is_dir() {
                config.push_str(&format!(
                    "{} = \"read\"\n",
                    toml_string(&path.to_string_lossy())
                ));
            }
        }
    }
    config.push_str(&format!(
        r#"[permissions.{PROFILE}.filesystem.":workspace_roots"]
"." = "write"
".git" = "read"
".codex" = "read"
".agents" = "read"
".aws" = "deny"
".env" = "deny"
[permissions.{PROFILE}.network]
enabled = false
"#
    ));
    config
}

fn prepare_codex_home(
    repository: &Path,
    dependency_roots: &[PathBuf],
) -> Result<tempfile::TempDir, String> {
    let directory = tempfile::Builder::new()
        .prefix("yorishiro-development-auth-")
        .tempdir()
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700))
            .map_err(|e| e.to_string())?;
    }
    let source_home = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(crate::home_dir_or_err()?.join(".codex"));
    let path = source_home.join("auth.json");
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| "Codex CLIでログインし、ファイル形式の認証情報を用意してください")?;
    if !metadata.is_file() || metadata.len() > 1024 * 1024 {
        return Err("Codex認証ファイルを安全に読み取れません".into());
    }
    let auth = std::fs::read(&path).map_err(|_| "Codex認証ファイルを読み取れません")?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(directory.path().join("auth.json"))
        .and_then(|mut file| file.write_all(&auth))
        .map_err(|_| "開発用の一時認証を準備できません")?;
    std::fs::write(
        directory.path().join("config.toml"),
        profile_config(repository, dependency_roots),
    )
    .map_err(|e| e.to_string())?;
    Ok(directory)
}

pub(super) fn check_managed_config() -> Result<(), String> {
    for path in [
        "/etc/codex/config.toml",
        "/etc/codex/managed_config.toml",
        "/etc/codex/requirements.toml",
        "/Library/Managed Preferences/com.openai.codex.plist",
    ] {
        match std::fs::metadata(path) {
            Ok(metadata) if metadata.len() > 0 => {
                return Err(
                    "管理されたCodex設定があります。開発用の限定権限を検証できないため停止しました"
                        .into(),
                )
            }
            Ok(_) => (),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("Codex管理設定を確認できません".into()),
        }
    }
    Ok(())
}

fn codex_command(binary: &Path, home: &Path, repository: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .env_clear()
        .current_dir(repository)
        .env("CODEX_HOME", home)
        // The app's PATH may contain parent-agent shell shims and unrelated
        // repository binaries. They are neither runtime dependencies nor part
        // of the clone's read grants; inheriting them can also break npm's
        // subprocess launch. Resolve the trusted Codex binary before clearing
        // the environment and expose only the supported runtime directories.
        .env("PATH", development_path())
        .env("TMPDIR", repository.join(".yorishiro-tmp"))
        .env("NPM_CONFIG_OFFLINE", "true")
        .env("NPM_CONFIG_CACHE", repository.join(".yorishiro-tmp/npm"))
        .env("CARGO_NET_OFFLINE", "true")
        .env("LANG", "en_US.UTF-8")
        .env("LC_ALL", "en_US.UTF-8");
    // HOME is the actual user home (never redirected), so existing toolchains
    // locate their read-only installations; OS policy does not grant home reads.
    if let Some(user_home) = dirs::home_dir() {
        command.env("HOME", user_home);
    }
    command
}

fn development_path() -> String {
    let mut paths = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/bin"),
        PathBuf::from("/usr/sbin"),
        PathBuf::from("/sbin"),
    ];
    if let Some(home) = dirs::home_dir() {
        paths.insert(0, home.join(".cargo/bin"));
    }
    std::env::join_paths(paths)
        .expect("known runtime paths contain no separator")
        .to_string_lossy()
        .into_owned()
}

async fn policy_allows(
    binary: &Path,
    home: &Path,
    repository: &Path,
    rules: &Path,
    args: &[String],
    cancel: CancellationToken,
) -> Result<bool, String> {
    let mut command = codex_command(binary, home, repository);
    command
        .args(["execpolicy", "check", "--rules"])
        .arg(rules)
        .arg("--")
        .args(args);
    let result = capture(command, None, Duration::from_secs(10), cancel).await?;
    if result.exit_code != 0 {
        return Err("既存の実行制限を検証できません".into());
    }
    super::policy::command_allowed(&result.stdout)
}

fn read_report(path: &Path) -> Result<Report, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| "Codexの開発結果がありません")?;
    if !metadata.is_file() || metadata.len() > MAX_REPORT {
        return Err("開発結果の形式が不正です".into());
    }
    let mut text = Vec::new();
    std::fs::File::open(path)
        .map_err(|e| e.to_string())?
        .take(MAX_REPORT + 1)
        .read_to_end(&mut text)
        .map_err(|e| e.to_string())?;
    let report: Report = serde_json::from_slice(&text).map_err(|_| "開発結果を読み取れません")?;
    if report.summary.trim().is_empty() || report.summary.len() > 16000 || report.checks.len() > 3 {
        return Err("開発結果が大きすぎるか不正です".into());
    }
    if let Some(request) = &report.requested_action {
        request.validate()?;
    }
    if let Some(question) = &report.question {
        if question.trim().is_empty() || question.len() > 2_000 || report.requested_action.is_some()
        {
            return Err("情報の質問と操作の承認依頼を分けて返してください".into());
        }
    }
    Ok(report)
}

/// Plain argv only, with no host shell interpretation. Repository tests may
/// execute scripts, so every check runs under the same OS sandbox as model tools.
/// The host records actual completion instead of trusting the model assertion.
fn check_args(command: &str) -> Option<Vec<String>> {
    if command.is_empty()
        || command.len() > 1000
        || command
            .chars()
            .any(|c| c.is_control() || ";&|$><`\\\"'(){}".contains(c))
    {
        return None;
    }
    let args: Vec<String> = command.split_whitespace().map(str::to_owned).collect();
    let words: Vec<&str> = args.iter().map(String::as_str).collect();
    let allowed = matches!(
        words.as_slice(),
        ["npm", "test", ..]
            | ["npm", "run", "test", ..]
            | ["npm", "run", "test:run", ..]
            | ["npm", "run", "check", ..]
            | ["npx", "vitest", "run", ..]
            | ["cargo", "test", ..]
            | ["cargo", "check", ..]
            | ["cargo", "clippy", ..]
            | ["pytest", ..]
            | ["python", "-m", "pytest", ..]
            | ["python3", "-m", "pytest", ..]
            | ["go", "test", ..]
    );
    // Do not let flags load arbitrary compiler/plugin config, install packages,
    // change working directories, or select a different Cargo manifest.
    let forbidden = [
        "--prefix",
        "--workspace",
        "--workspaces",
        "--config",
        "--manifest-path",
        "--registry",
        "--package",
        "-p",
        "-c",
        "--cache",
        "--userconfig",
        "--globalconfig",
    ];
    if !allowed
        || words.iter().any(|word| {
            forbidden
                .iter()
                .any(|bad| word == bad || word.starts_with(&format!("{bad}=")))
        })
    {
        return None;
    }
    Some(args)
}

fn stage_tree(repository: &Path) -> Result<String, String> {
    let repo = Repository::open(repository).map_err(|e| e.to_string())?;
    let mut index = repo.index().map_err(|e| e.to_string())?;
    index
        .add_all(["*"], git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    index.update_all(["*"], None).map_err(|e| e.to_string())?;
    let tree = index.write_tree().map_err(|e| e.to_string())?;
    index.write().map_err(|e| e.to_string())?;
    Ok(tree.to_string())
}

fn changed_paths(
    repository: &Path,
    base_commit: &str,
    verified_tree: &str,
) -> Result<Vec<String>, String> {
    let repo = Repository::open(repository).map_err(|e| e.to_string())?;
    if repo
        .head()
        .and_then(|head| head.peel_to_commit())
        .map_err(|e| e.to_string())?
        .id()
        .to_string()
        != base_commit
    {
        return Err("開発コピーのGit基準が変更されました".into());
    }
    // Derive review metadata from the same immutable tree as the artifact, not
    // from a worktree a detached test process might still be changing.
    let base = repo
        .find_commit(git2::Oid::from_str(base_commit).map_err(|e| e.to_string())?)
        .and_then(|commit| commit.tree())
        .map_err(|e| e.to_string())?;
    let verified = repo
        .find_tree(git2::Oid::from_str(verified_tree).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let diff = repo
        .diff_tree_to_tree(Some(&base), Some(&verified), None)
        .map_err(|e| e.to_string())?;
    let mut paths = Vec::new();
    for entry in diff.deltas() {
        let path = entry
            .new_file()
            .path()
            .or_else(|| entry.old_file().path())
            .and_then(Path::to_str)
            .ok_or("変更ファイル名を読み取れません")?;
        if path.starts_with(".yorishiro-tmp/") || path == ".yorishiro-tmp" {
            continue;
        }
        if path.chars().any(char::is_control) || path.len() > 4096 {
            return Err("変更ファイル名が不正です".into());
        }
        paths.push(path.to_owned());
    }
    if paths.len() > 256 {
        return Err("一回の開発変更が大きすぎます。コピーは保持しています".into());
    }
    Ok(paths)
}

fn verify_transport(bytes: &[u8]) -> Result<(), String> {
    let mut completed = false;
    for line in bytes
        .split(|b| *b == b'\n')
        .filter(|line| !line.iter().all(u8::is_ascii_whitespace))
    {
        let value: Value =
            serde_json::from_slice(line).map_err(|_| "Codex開発イベントの形式が不正です")?;
        let kind = value
            .get("type")
            .and_then(Value::as_str)
            .ok_or("Codex開発イベントの種別がありません")?;
        if kind == "turn.failed" || kind == "error" {
            return Err("Codexの開発処理が完了しませんでした".into());
        }
        if kind == "turn.completed" {
            completed = true;
        }
        if kind.starts_with("item.") {
            if let Some(item_type) = value.pointer("/item/type").and_then(Value::as_str) {
                if matches!(
                    item_type,
                    "mcp_tool_call"
                        | "web_search"
                        | "image_generation"
                        | "computer_use"
                        | "collab_tool_call"
                ) {
                    return Err("開発用に許可していないツールが使用されました".into());
                }
            }
        }
    }
    if completed {
        Ok(())
    } else {
        Err("Codexの開発完了を確認できません".into())
    }
}

struct Captured {
    exit_code: i32,
    stdout: Vec<u8>,
}
struct Process {
    child: tokio::process::Child,
    supervisor: super::process_supervisor::Supervisor,
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.child.start_kill();
    }
}
async fn bounded(mut reader: impl AsyncRead + Unpin) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let count = reader
            .read(&mut chunk)
            .await
            .map_err(|_| "開発プロセスの出力を取得できません")?;
        if count == 0 {
            return Ok(data);
        }
        if data.len() + count > OUTPUT_LIMIT {
            return Err("開発プロセスの出力が上限を超えました".into());
        }
        data.extend_from_slice(&chunk[..count]);
    }
}
async fn capture(
    mut command: Command,
    input: Option<String>,
    timeout: Duration,
    cancel: CancellationToken,
) -> Result<Captured, String> {
    if cancel.is_cancelled() {
        return Err("開発作業を停止しました".into());
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut supervisor = super::process_supervisor::Supervisor::prepare(&mut command)?;
    let child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            supervisor.finish().await;
            return Err("開発プロセスを開始できません".into());
        }
    };
    if let Some(pid) = child.id() {
        supervisor.attach(pid);
    }
    let mut process = Process { supervisor, child };
    let (Some(stdout), Some(stderr)) = (process.child.stdout.take(), process.child.stderr.take())
    else {
        let _ = process.child.start_kill();
        process.supervisor.finish().await;
        let _ = process.child.wait().await;
        return Err("開発プロセスの出力を準備できません".into());
    };
    let stdin = process.child.stdin.take();
    let work = async {
        let write = async {
            if let (Some(mut stdin), Some(input)) = (stdin, input) {
                stdin
                    .write_all(input.as_bytes())
                    .await
                    .map_err(|_| "開発指示を送信できません")?;
                stdin
                    .shutdown()
                    .await
                    .map_err(|_| "開発指示を完了できません")?;
            }
            Ok::<_, String>(())
        };
        let wait = async {
            process
                .child
                .wait()
                .await
                .map_err(|_| "開発プロセスを待機できません".to_owned())
        };
        let (status, stdout, _stderr, ()) =
            tokio::try_join!(wait, bounded(stdout), bounded(stderr), write)?;
        Ok(Captured {
            exit_code: status.code().unwrap_or(-1),
            stdout,
        })
    };
    let result = tokio::select! {biased;_=cancel.cancelled()=>Err("開発作業を停止しました。作業コピーは保持しています".into()),_=tokio::time::sleep(timeout)=>Err("開発作業が制限時間を超えました。作業コピーは保持しています".into()),result=work=>result};
    let _ = process.child.start_kill();
    process.supervisor.finish().await;
    let _ = process.child.wait().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_separates_missing_information_from_approval() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.json");
        let mut report = json!({"summary":"Ready for next step","checks":[],"requestedAction":null,"question":"Who should receive this report?"});
        std::fs::write(&path, serde_json::to_vec(&report).unwrap()).unwrap();
        assert_eq!(
            read_report(&path).unwrap().question.as_deref(),
            Some("Who should receive this report?")
        );
        report["requestedAction"] = json!({"operation":"Send","target":"Some recipient","impact":"Delivery","details":"Message","reason":"Goal"});
        std::fs::write(&path, serde_json::to_vec(&report).unwrap()).unwrap();
        assert!(read_report(&path).is_err());
        report["requestedAction"] = json!(null);
        report["question"] = json!(" ");
        std::fs::write(&path, serde_json::to_vec(&report).unwrap()).unwrap();
        assert!(read_report(&path).is_err());
    }
    #[test]
    fn source_context_never_includes_remote_credentials() {
        assert_eq!(
            safe_origin("https://username:secret@example.test/repository?token=secret#secret")
                .as_deref(),
            Some("https://example.test/repository")
        );
        assert_eq!(
            safe_origin("git@example.test:team/repository.git").as_deref(),
            Some("git@example.test:team/repository.git")
        );
        assert!(safe_origin("file:///private/path").is_none());
    }

    #[test]
    fn generic_request_is_structured_bounded_and_optional_for_old_reports() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("report.json");
        std::fs::write(&path, br#"{"summary":"done","checks":["npm test"]}"#).unwrap();
        assert!(read_report(&path).unwrap().requested_action.is_none());
        let request = json!({"operation":"Send prepared message","target":"Specified recipient","impact":"Recipient receives content","details":"Exact body","reason":"Needed for objective"});
        std::fs::write(
            &path,
            serde_json::to_vec(&json!({"summary":"done","checks":[],"requestedAction":request}))
                .unwrap(),
        )
        .unwrap();
        assert!(read_report(&path).unwrap().requested_action.is_some());
        for invalid in [
            json!({"kind":"publishPullRequest","reason":"old"}),
            json!({"operation":"x","target":"","impact":"x","details":"x","reason":"x"}),
        ] {
            std::fs::write(
                &path,
                serde_json::to_vec(
                    &json!({"summary":"done","checks":[],"requestedAction":invalid}),
                )
                .unwrap(),
            )
            .unwrap();
            assert!(read_report(&path).is_err());
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires installed Codex sandbox and Python; no model call"]
    async fn live_sandbox_detached_children_stop_on_every_capture_exit() {
        let mut unrelated = Command::new("/bin/sleep")
            .arg("30")
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        for mode in ["normal", "cancel", "timeout", "overflow"] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            let repository = root.join("repository");
            let home = root.join("auth");
            std::fs::create_dir_all(repository.join(".git")).unwrap();
            std::fs::create_dir(repository.join(".yorishiro-tmp")).unwrap();
            std::fs::create_dir(&home).unwrap();
            std::fs::write(home.join("config.toml"), profile_config(&repository, &[])).unwrap();
            let script = repository.join("fixture.py");
            std::fs::write(
                &script,
                r#"import os,sys,time,pathlib
root=pathlib.Path(sys.argv[1]); mode=sys.argv[2]
assert os.environ.get('YORISHIRO_AUTONOMY_RUN_ID')
if os.fork()==0:
 os.setsid()
 if os.fork(): os._exit(0)
 fd=os.open('/dev/null',os.O_RDWR)
 for n in (0,1,2): os.dup2(fd,n)
 (root/'detached.pid').write_text(str(os.getpid()))
 time.sleep(2)
 (root/'survived').write_text('leaked')
 time.sleep(10)
 os._exit(0)
for n in range(200):
 if (root/'detached.pid').exists(): break
 time.sleep(.01)
if mode=='normal': os._exit(0)
if mode=='overflow':
 sys.stdout.write('x'*5000000); sys.stdout.flush()
time.sleep(20)
"#,
            )
            .unwrap();
            let binary = crate::resolve_command_path_impl("codex").unwrap();
            let python = crate::resolve_command_path_impl("python3").unwrap();
            let mut command = codex_command(Path::new(&binary), &home, &repository);
            command
                .args(["sandbox", "-P", PROFILE, "-C"])
                .arg(&repository)
                .arg("--")
                .arg(python)
                .arg(&script)
                .arg(&repository)
                .arg(mode);
            let cancel = CancellationToken::new();
            if mode == "cancel" {
                let token = cancel.clone();
                let ready = repository.join("detached.pid");
                tokio::spawn(async move {
                    for _ in 0..200 {
                        if ready.exists() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    token.cancel();
                });
            }
            let limit = if mode == "timeout" {
                Duration::from_millis(800)
            } else {
                Duration::from_secs(8)
            };
            let result = tokio::time::timeout(
                Duration::from_secs(12),
                capture(command, None, limit, cancel),
            )
            .await
            .expect("cleanup acknowledged");
            if mode == "normal" {
                assert_eq!(result.unwrap().exit_code, 0);
            } else {
                assert!(result.is_err(), "{mode}");
            }
            assert!(
                repository.join("detached.pid").exists(),
                "fixture did not detach: {mode}"
            );
            tokio::time::sleep(Duration::from_millis(2100)).await;
            assert!(
                !repository.join("survived").exists(),
                "detached process survived: {mode}"
            );
            assert!(
                unrelated.try_wait().unwrap().is_none(),
                "unrelated process was killed"
            );
        }
        unrelated.kill().await.unwrap();
        unrelated.wait().await.unwrap();
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires installed Codex execpolicy evaluator; no model call"]
    async fn live_native_policy_denies_host_checks_without_running_them() {
        let directory = tempfile::tempdir().unwrap();
        let repository = directory.path().canonicalize().unwrap();
        let home = repository.join("auth");
        std::fs::create_dir(&home).unwrap();
        let mut restrictions = super::super::policy::codex_restrictions(&repository).unwrap();
        restrictions.push_str("prefix_rule(pattern=[\"npm\",\"test\"],decision=\"prompt\")\nprefix_rule(pattern=[\"/bin/touch\"],decision=\"forbidden\")\n");
        let rules = super::super::policy::write_rules(&home, &restrictions).unwrap();
        let binary = crate::resolve_command_path_impl("codex").expect("Codex CLI");
        for args in [
            vec!["npm".into(), "test".into()],
            vec![
                "/bin/touch".into(),
                repository
                    .join("must-not-exist")
                    .to_string_lossy()
                    .into_owned(),
            ],
        ] {
            assert!(!policy_allows(
                Path::new(&binary),
                &home,
                &repository,
                &rules,
                &args,
                CancellationToken::new()
            )
            .await
            .unwrap());
        }
        assert!(!repository.join("must-not-exist").exists());
        assert!(policy_allows(
            Path::new(&binary),
            &home,
            &repository,
            &rules,
            &["cargo".into(), "check".into()],
            CancellationToken::new()
        )
        .await
        .unwrap());
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires installed Codex sandbox and Node; no model call"]
    async fn live_sandbox_blocks_source_auth_git_and_network() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let repository = root.join("repository");
        let home = root.join("auth");
        std::fs::create_dir_all(repository.join(".git")).unwrap();
        std::fs::create_dir(repository.join(".yorishiro-tmp")).unwrap();
        std::fs::create_dir(&home).unwrap();
        std::fs::write(home.join("auth.json"), "dummy-test-credential").unwrap();
        std::fs::write(root.join("source.txt"), "untouched").unwrap();
        std::os::unix::fs::symlink(root.join("source.txt"), repository.join("link")).unwrap();
        std::fs::write(home.join("config.toml"), profile_config(&repository, &[])).unwrap();
        let binary = crate::resolve_command_path_impl("codex").expect("Codex CLI");
        let node = crate::resolve_command_path_impl("node").expect("Node runtime");
        let script = r#"
const fs=require('fs'), net=require('net'); const root=process.argv[1];
const denied=(f)=>{try{f();return false}catch(e){return ['EPERM','EACCES'].includes(e.code)}};
fs.writeFileSync('allowed.txt','ok');
const checks=[
 denied(()=>fs.readFileSync(root+'/source.txt')),
 denied(()=>fs.writeFileSync(root+'/source.txt','bad')),
 denied(()=>fs.readFileSync('link')),
 denied(()=>fs.writeFileSync('link','bad')),
 denied(()=>fs.readFileSync(root+'/auth/auth.json')),
 denied(()=>fs.writeFileSync('.git/probe','bad')),
 denied(()=>fs.renameSync('.git','renamed-git'))
];
const socket=net.connect({host:'127.0.0.1',port:9});
socket.on('error',e=>{checks.push(['EPERM','EACCES'].includes(e.code));console.log(JSON.stringify(checks));process.exit(checks.every(Boolean)?0:1)});
setTimeout(()=>process.exit(2),3000);
"#;
        let mut command = codex_command(Path::new(&binary), &home, &repository);
        command
            .args(["sandbox", "-P", PROFILE, "-C"])
            .arg(&repository)
            .arg("--")
            .arg(node)
            .args(["-e", script])
            .arg(&root);
        let output = capture(
            command,
            None,
            Duration::from_secs(15),
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(
            output.exit_code,
            0,
            "sandbox assertions: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        assert_eq!(
            std::fs::read_to_string(root.join("source.txt")).unwrap(),
            "untouched"
        );
        assert_eq!(
            std::fs::read_to_string(repository.join("allowed.txt")).unwrap(),
            "ok"
        );
    }

    #[test]
    fn job_store_cannot_modify_source_or_follow_development_link() {
        let (directory, root) = fixture();
        let source = root.canonicalize().unwrap();
        assert!(create_job(&source, &source, "job").is_err());
        assert!(!source.join("development").exists());
        let store = directory.path().join("store");
        std::fs::create_dir(&store).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&source, store.join("development")).unwrap();
            assert!(create_job(&source, &store, "job").is_err());
            assert!(!source.join("job").exists());
        }
    }

    #[cfg(unix)]
    #[test]
    fn dependencies_cannot_grant_read_access_to_link_target() {
        let (directory, root) = fixture();
        assert!(dependency_root(&root).unwrap().is_none());
        std::os::unix::fs::symlink(directory.path(), root.join("node_modules")).unwrap();
        assert!(dependency_root(&root).is_err());
        std::fs::remove_file(root.join("node_modules")).unwrap();
        std::fs::create_dir(root.join("node_modules")).unwrap();
        assert_eq!(
            dependency_root(&root).unwrap(),
            Some(root.join("node_modules").canonicalize().unwrap())
        );
    }

    /// Explicit local verification only: consumes one authenticated model call,
    /// runs only in a temporary toy repository, never the user's source files.
    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires installed authenticated Codex CLI and makes a model request"]
    async fn live_development_changes_only_clone_and_runs_real_checks() {
        let (directory, root) = fixture();
        for (path, contents) in [
            ("package.json", "{\"private\":true,\"scripts\":{\"test\":\"node --test\"}}"),
            ("add.js", "module.exports = (a, b) => a - b;\n"),
            ("add.test.js", "const test=require('node:test'); const assert=require('node:assert/strict'); const add=require('./add'); test('addition',()=>{assert.equal(add(2,3),5);assert.equal(add(-2,3),1);});\n"),
        ] {
            std::fs::write(root.join(path), contents).unwrap();
        }
        let repo = Repository::open(&root).unwrap();
        let tree_id = stage_tree(&root).unwrap();
        let tree = repo
            .find_tree(git2::Oid::from_str(&tree_id).unwrap())
            .unwrap();
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        let signature = git2::Signature::now("Fixture", "fixture@example.invalid").unwrap();
        repo.commit(
            Some("HEAD"),
            &signature,
            &signature,
            "failing addition fixture",
            &tree,
            &[&head],
        )
        .unwrap();
        let source_head = repo.head().unwrap().target().unwrap();
        let store = directory.path().join("store");
        std::fs::create_dir(&store).unwrap();
        let result = run(root.clone(), store, uuid::Uuid::new_v4().to_string(),
            "Fix add.js so it adds the two numbers correctly. Keep the existing tests unchanged. Run npm test and return that exact check command. This tiny fixture needs no dependencies or installation.".into(),
            CancellationToken::new()).await.expect("isolated development run");
        assert!(result.ready_for_review, "result: {result:?}");
        assert_eq!(result.changed_paths, vec!["add.js"]);
        assert!(result
            .checks
            .iter()
            .any(|check| check.command == "npm test" && check.exit_code == 0));
        assert_eq!(
            std::fs::read_to_string(root.join("add.js")).unwrap(),
            "module.exports = (a, b) => a - b;\n"
        );
        assert_eq!(repo.head().unwrap().target().unwrap(), source_head);
        assert!(!root.join(".yorishiro-tmp").exists());
    }
    fn fixture() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("source");
        let repo = Repository::init(&path).unwrap();
        std::fs::write(path.join("README.md"), "original\n").unwrap();
        let mut index = repo.index().unwrap();
        index.add_path(Path::new("README.md")).unwrap();
        let oid = index.write_tree().unwrap();
        let tree = repo.find_tree(oid).unwrap();
        let signature = git2::Signature::now("Fixture", "fixture@example.invalid").unwrap();
        repo.commit(Some("HEAD"), &signature, &signature, "seed", &tree, &[])
            .unwrap();
        (directory, path)
    }
    #[test]
    fn requires_exact_committed_repository_root() {
        let (dir, root) = fixture();
        assert_eq!(
            validate_root(root.to_str().unwrap()).unwrap(),
            root.canonicalize().unwrap()
        );
        let nested = root.join("nested");
        std::fs::create_dir(&nested).unwrap();
        assert!(validate_root(nested.to_str().unwrap()).is_err());
        assert!(validate_root(dir.path().to_str().unwrap()).is_err());
        assert!(validate_root("relative").is_err());
    }
    #[test]
    fn clone_is_independent_and_ignores_uncommitted_source_work() {
        let (dir, root) = fixture();
        std::fs::write(root.join("README.md"), "unsaved user work\n").unwrap();
        std::fs::write(root.join("private.txt"), "untracked\n").unwrap();
        let job = dir.path().join("job");
        std::fs::create_dir(&job).unwrap();
        let result = prepare_clone_sync(
            &root,
            &job,
            &uuid::Uuid::new_v4().to_string(),
            &CancellationToken::new(),
        )
        .unwrap();
        assert_eq!(
            std::fs::read_to_string(result.repository.join("README.md")).unwrap(),
            "original\n"
        );
        assert!(!result.repository.join("private.txt").exists());
        assert!(Repository::open(&result.repository)
            .unwrap()
            .find_remote("origin")
            .is_err());
        std::fs::write(result.repository.join("README.md"), "clone change\n").unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "unsaved user work\n"
        );
        assert_eq!(
            changed_paths(
                &result.repository,
                &result.base_commit,
                &stage_tree(&result.repository).unwrap()
            )
            .unwrap(),
            vec!["README.md"]
        );
    }
    #[test]
    fn checks_are_shell_free_and_reject_configuration_escape() {
        for value in [
            "npm run test:run",
            "npx vitest run src/example.test.ts",
            "cargo test --lib",
            "go test ./...",
        ] {
            assert!(check_args(value).is_some(), "{value}")
        }
        for value in [
            "echo npm test",
            "npm test; touch /tmp/bad",
            "npm test --prefix /outside",
            "cargo test --manifest-path=/outside/Cargo.toml",
            "npx --yes bad",
            "sh -c npm test",
            "npm test $(bad)",
        ] {
            assert!(check_args(value).is_none(), "{value}")
        }
    }
    #[test]
    fn profile_disables_external_authority_and_protects_git() {
        let config = profile_config(Path::new("/work/repository"), &[]);
        for text in [
            "approval_policy = \"never\"",
            "network]",
            "enabled = false",
            "plugins = false",
            "apps = false",
            "hooks = false",
            "\".git\" = \"read\"",
            "trust_level = \"untrusted\"",
        ] {
            assert!(config.contains(text), "{text}");
        }
        assert!(!config.contains("danger-full-access"));
        assert!(!config.contains(":root"));
    }
    #[test]
    fn transport_needs_completion_and_rejects_nonlocal_tools() {
        assert!(verify_transport(
            b"{\"type\":\"thread.started\"}\n{\"type\":\"turn.completed\"}\n"
        )
        .is_ok());
        assert!(verify_transport(b"{\"type\":\"thread.started\"}\n").is_err());
        assert!(verify_transport(b"{\"type\":\"turn.failed\"}\n").is_err());
        assert!(verify_transport(b"{\"type\":\"item.completed\",\"item\":{\"type\":\"mcp_tool_call\"}}\n{\"type\":\"turn.completed\"}\n").is_err());
    }
    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn cancellation_and_output_bounds_stop_child() {
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            task_cancel.cancel();
        });
        let mut command = Command::new("/bin/sleep");
        command.arg("20");
        assert!(capture(command, None, Duration::from_secs(2), cancel)
            .await
            .err()
            .unwrap()
            .contains("停止"));
        assert!(bounded(&vec![0; OUTPUT_LIMIT + 1][..]).await.is_err());
    }
}
