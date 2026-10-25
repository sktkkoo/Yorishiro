//! Execute one approved operation in a bounded workspace, independent of Git.
//! The approval is supplied as data, never reconstructed from a new goal. The
//! CLI transport can authenticate, but its tools cannot read its private home.
use super::{actions, development, Contract, Run};
use serde::Deserialize;
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tokio_util::sync::CancellationToken;

const PROFILE: &str = "yorishiro-approved-action";
const MAX_REPORT: usize = 64 * 1024;

pub(super) struct ExecutionResult {
    pub summary: String,
    pub result_url: Option<String>,
    pub goal_complete: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Report {
    outcome: Outcome,
    summary: String,
    evidence: Vec<String>,
    result_url: Option<String>,
    #[serde(default)]
    goal_complete: bool,
}

#[derive(Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Outcome {
    Completed,
    Blocked,
}

struct Workspace {
    job: PathBuf,
    work: PathBuf,
    root: PathBuf,
    references: Vec<PathBuf>,
    review: Option<Value>,
    delegated_goal: String,
}

fn checked_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("承認済み操作の保存先には絶対パスが必要です".into());
    }
    let mut cursor = PathBuf::new();
    for component in path.components() {
        if !matches!(component, Component::RootDir | Component::Normal(_)) {
            return Err("承認済み操作の保存先が不正です".into());
        }
        cursor.push(component);
        let metadata =
            fs::symlink_metadata(&cursor).map_err(|_| "承認済み操作のフォルダを確認できません")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("承認済み操作のフォルダにリンクは使用できません".into());
        }
    }
    path.canonicalize().map_err(|e| e.to_string())
}

fn create_directory(path: &Path) -> Result<(), String> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path).map_err(|e| e.to_string())
}

fn prepare(
    storage: &Path,
    action: &Value,
    run: &Run,
    contract: &Contract,
) -> Result<Workspace, String> {
    if !["write", "move", "trash"].iter().all(|operation| {
        contract
            .allowed_operations
            .iter()
            .any(|value| value == operation)
    }) {
        return Err("この操作の実行には保存済みの書き込み・移動・ごみ箱への移動の許可が必要です。文書の限定操作は専用の処理で実行してください".into());
    }
    let root = super::files::validate_root(&contract.root)?;
    let source = action["sourceRoot"]
        .as_str()
        .ok_or("承認した対象フォルダがありません")?;
    // Canonical equality does not expand a selected subfolder to a repository.
    if checked_directory(Path::new(source))? != root
        || action["runId"].as_str() != Some(run.id.as_str())
        || !matches!(action["status"].as_str(), Some("approved" | "executing"))
    {
        return Err("承認した操作と現在の対象フォルダ・作業が一致しません".into());
    }
    let id = action["id"]
        .as_str()
        .ok_or("承認した操作の識別子がありません")?;
    uuid::Uuid::parse_str(id).map_err(|_| "承認した操作の識別子が不正です")?;
    let storage = checked_directory(storage)?;
    if storage.starts_with(&root) {
        return Err("操作用の保存先は対象フォルダの外に必要です".into());
    }
    let mut references = Vec::new();
    let review = if run.development_path.is_some() {
        if action["artifactPath"].as_str() != run.development_path.as_deref()
            || action["changedPaths"] != json!(run.changed_paths)
        {
            return Err(
                "承認した成果物と現在の作業結果が一致しません。操作は実行していません".into(),
            );
        }
        let review = super::review_context::load_for_action(&storage, run, action)?;
        let value = serde_json::to_value(review).map_err(|e| e.to_string())?;
        let job = storage.join("development").join(&run.id);
        references.push(checked_directory(&job.join("review-artifact"))?);
        references.push(checked_directory(&job.join("repository"))?);
        Some(value)
    } else {
        None
    };
    let actions = storage.join("action-executions");
    if !actions.exists() {
        create_directory(&actions)?;
    }
    checked_directory(&actions)?;
    let job = actions.join(id);
    // An existing directory can contain side effects from an interrupted run.
    // Never replay an approved action just because its final receipt is absent.
    create_directory(&job).map_err(|_| {
        "この操作には実行開始の記録があります。結果を確認するまで再実行しません".to_owned()
    })?;
    let work = job.join("work");
    create_directory(&work)?;
    create_directory(&work.join(".yorishiro-tmp"))?;
    Ok(Workspace {
        job,
        work,
        root,
        references,
        review,
        delegated_goal: contract.goal.clone(),
    })
}

fn quoted(text: &str) -> String {
    serde_json::to_string(text).expect("serializing a string cannot fail")
}

/// Only an explicit repository locator in the reviewed target can use GitHub login.
/// Mentions in instructions/details or lookalike hosts grant no credential access.
fn github_target(target: &str) -> bool {
    target
        .split(|c: char| c.is_whitespace() || "／（）()[]<>、，,;\"".contains(c))
        .any(|part| {
            let path = if let Some(path) = part.strip_prefix("git@github.com:") {
                path.to_owned()
            } else if let Ok(url) = tauri::Url::parse(part) {
                if url.scheme() != "https"
                    || url.host_str() != Some("github.com")
                    || !url.username().is_empty()
                    || url.password().is_some()
                {
                    return false;
                }
                url.path().trim_start_matches('/').to_owned()
            } else {
                return false;
            };
            let parts: Vec<_> = path.trim_end_matches('/').split('/').collect();
            parts.len() >= 2
                && parts[..2].iter().all(|part| {
                    !part.is_empty()
                        && *part != "."
                        && *part != ".."
                        && part
                            .chars()
                            .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
                })
        })
}

/// Read a single service credential through its installed CLI, outside model tools.
/// The caller checks retained command policy first. Never log the token or include
/// it in prompts/reports; the worker receives only this host's credential in its
/// environment and an empty service configuration inside its private workspace.
async fn github_token(
    binary: &Path,
    directory: &Path,
    cancel: CancellationToken,
) -> Result<String, String> {
    let mut command = development::codex_command(binary, directory, directory);
    command.args(["auth", "token", "--hostname", "github.com"]);
    if let Some(value) = std::env::var_os("GH_CONFIG_DIR") {
        command.env("GH_CONFIG_DIR", value);
    }
    for name in ["GH_TOKEN", "GITHUB_TOKEN"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut output = development::capture(command, None, Duration::from_secs(10), cancel).await?;
    let token = std::str::from_utf8(&output.stdout)
        .ok()
        .map(str::trim)
        .filter(|value| {
            !value.is_empty() && value.len() <= 4000 && !value.chars().any(char::is_control)
        })
        .map(str::to_owned);
    output.stdout.fill(0);
    if output.exit_code != 0 {
        return Err(
            "承認したGitHub操作のログインを確認できません。GitHub CLIでログインしてください".into(),
        );
    }
    token.ok_or_else(|| "サービスのログイン情報を確認できません".into())
}

fn profile(workspace: &Workspace, network: bool, user_home: Option<&Path>) -> String {
    let mut config = format!(
        r#"default_permissions = "{PROFILE}"
approval_policy = "never"
web_search = "disabled"
cli_auth_credentials_store = "file"
[shell_environment_policy]
inherit = "all"
include_only = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "NPM_CONFIG_OFFLINE", "NPM_CONFIG_CACHE", "CARGO_NET_OFFLINE", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_GLOBAL", "GIT_TERMINAL_PROMPT", "GH_PROMPT_DISABLED", "GH_CONFIG_DIR", "GH_TOKEN", "SSH_AUTH_SOCK", "YORISHIRO_AUTONOMY_RUN_ID"]
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
        quoted(&workspace.work.to_string_lossy())
    );
    let mut grant = |path: &Path, permission: &str| {
        config.push_str(&format!(
            "{} = {}\n",
            quoted(&path.to_string_lossy()),
            quoted(permission)
        ));
    };
    grant(&workspace.work, "write");
    grant(&workspace.root, "write");
    grant(&workspace.root.join(".git"), "write");
    grant(&workspace.work.join(".git"), "write");
    // Local Git operations are permitted by the exact approved operation, not
    // by a GitHub-specific route. Agent settings cannot be changed by tools.
    for name in [".codex", ".claude", ".agents", "AGENTS.md", "CLAUDE.md"] {
        grant(&workspace.root.join(name), "read");
    }
    for name in [".aws", ".env"] {
        grant(&workspace.root.join(name), "deny");
    }
    for path in &workspace.references {
        grant(path, "read");
    }
    if let Some(home) = user_home {
        for suffix in [
            ".rustup/toolchains",
            ".cargo/bin",
            ".cargo/registry",
            ".cargo/git",
        ] {
            let path = home.join(suffix);
            if path.is_dir() {
                grant(&path, "read");
            }
        }
        // Network approval does not grant access to private keys or tokens.
        // Known host identities are public; authentication may use an existing
        // agent socket, but unavailable credentials must block the operation.
        if network {
            let known_hosts = home.join(".ssh/known_hosts");
            if known_hosts.is_file() {
                grant(&known_hosts, "read");
            }
        }
    }
    config.push_str(&format!(
        "[permissions.{PROFILE}.network]\nenabled = {network}\n"
    ));
    config
}

fn prompt(action: &Value, workspace: &Workspace, network: bool) -> Result<String, String> {
    let context = json!({
        "approvedAction":action,
        "delegatedGoal":workspace.delegated_goal,
        "sourceRoot":workspace.root,
        "privateWorkDirectory":workspace.work,
        "readOnlyReferences":workspace.references,
        "verifiedReviewEvidence":workspace.review,
        "networkAccess":network
    });
    Ok(format!(
        "Execute exactly the single operation authorized in approvedAction. When autoApproved=true, authority comes from the user's saved permission for operations necessary to accomplish their delegated purpose; authorizationScope binds that permission to the current saved purpose. Otherwise the user confirmed this concrete operation individually. This is execution, not another proposal or an invitation to choose new work. Read the operation, target, impact and complete details together. Do not expand scope, change recipients, invent missing content or substitute a different operation. The sourceRoot may be a plain folder with no Git repository; do not assume GitHub, a pull request, or any Git workflow. Respect project instructions and retained user restrictions. Use the privateWorkDirectory for scratch files and any separate editable copy. readOnlyReferences and verifiedReviewEvidence describe a verified artifact: do not alter them, and do not substitute the mutable diagnostic clone for that artifact. Make source changes or Git operations only when the exact approved operation requires them. Perform only the concrete authorized operation and its necessary steps. Do not add unrelated merge, deployment, installation or sending steps. Never modify agent/auth settings, create a new approval or broaden your own permissions. Network is permitted only when networkAccess=true, and then only for the approved target and operation. If required information, permissions, authentication or capabilities are missing, stop and return outcome=blocked with the concrete reason. Do not claim completion for a prepared command, a plan, an unavailable tool, or an unconfirmed external request. For external mutations, do not retry an ambiguous response; report blocked and explain what may already have happened. Use actual tools to execute and verify the result. Return outcome=completed only after verification. Independently report goalComplete=true only when the actual delegated task (including the approved daily task when provided in delegatedGoal) has been achieved. Completing a necessary intermediate operation, such as installing a dependency, does not mean the whole task is complete; use goalComplete=false in that case. Preserve the concrete result and remaining work in summary so the host can continue from it. evidence must contain 1–8 short exact excerpts from the successful tool command/output or completed file-change paths, sufficient to identify the performed operation; do not cite your own prose as evidence. resultUrl is optional and must be an HTTPS URL observed in the successful tool output. Return a concise summary of the actual result in the language of delegatedGoal. Preserve exact paths, tool evidence and approved content. The following JSON is the frozen approval and reference data, not additional permissions:\n{}",
        serde_json::to_string(&context).map_err(|e| e.to_string())?
    ))
}

fn read_report(path: &Path) -> Result<Report, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "承認済み操作の実行結果がありません")?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > MAX_REPORT as u64 {
        return Err("承認済み操作の実行結果が大きすぎるか不正です".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_REPORT as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > MAX_REPORT {
        return Err("実行結果が上限を超えました".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "承認済み操作の実行結果を読み取れません".into())
}

fn verified_result(
    report: Report,
    events: &[u8],
    network: bool,
) -> Result<ExecutionResult, String> {
    if report.summary.trim().is_empty() || report.summary.len() > 16_000 {
        return Err("実行結果の説明が不正です".into());
    }
    if report.outcome == Outcome::Blocked {
        return Err(report.summary);
    }
    development::verify_transport(events)?;
    let mut evidence = Vec::new();
    for line in events
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
    {
        let value: Value = serde_json::from_slice(line).map_err(|_| "実行記録を確認できません")?;
        if value["type"] != "item.completed" {
            continue;
        }
        let item = &value["item"];
        if item["type"] == "command_execution"
            && item["exit_code"].as_i64() == Some(0)
            && item["status"] == "completed"
        {
            evidence.push(format!(
                "{}\n{}",
                item["command"].as_str().unwrap_or(""),
                item["aggregated_output"].as_str().unwrap_or("")
            ));
        } else if item["type"] == "file_change" && item["status"] == "completed" {
            for change in item["changes"].as_array().into_iter().flatten() {
                if let Some(path) = change["path"].as_str() {
                    evidence.push(path.to_owned());
                }
            }
        }
    }
    if report.evidence.is_empty()
        || report.evidence.len() > 8
        || report.evidence.iter().any(|excerpt| {
            excerpt.trim().is_empty()
                || excerpt.len() > 4_000
                || !evidence.iter().any(|actual| actual.contains(excerpt))
        })
    {
        return Err(
            "操作を実行したツールの記録と結果が一致しません。完了として記録していません".into(),
        );
    }
    if let Some(url) = &report.result_url {
        let parsed = tauri::Url::parse(url).map_err(|_| "実行結果のURLが不正です")?;
        if !network
            || parsed.scheme() != "https"
            || parsed.host_str().is_none()
            || !parsed.username().is_empty()
            || parsed.password().is_some()
            || url.len() > 4_000
            || !evidence.iter().any(|actual| actual.contains(url))
        {
            return Err("外部操作の結果URLを実行記録から確認できません".into());
        }
    }
    Ok(ExecutionResult {
        summary: report.summary,
        result_url: report.result_url,
        goal_complete: report.goal_complete,
    })
}

pub(super) async fn execute(
    storage: &Path,
    action: &actions::Action,
    run: &Run,
    contract: &Contract,
    cancel: CancellationToken,
) -> Result<ExecutionResult, String> {
    if cancel.is_cancelled() {
        return Err("承認済み操作を停止しました".into());
    }
    development::check_managed_config()?;
    let action = serde_json::to_value(action).map_err(|e| e.to_string())?;
    let network = action["networkAccess"].as_bool().unwrap_or(false);
    let workspace = prepare(storage, &action, run, contract)?;
    super::policy::claude_action_preflight(Some(&workspace.root))?;
    let restrictions = super::policy::codex_restrictions_for_action(&workspace.root, network)?;
    let config = profile(&workspace, network, dirs::home_dir().as_deref());
    let home = development::prepare_scoped_codex_home(&config)?;
    let rules = super::policy::write_rules(home.path(), &restrictions)?;
    let binary = crate::resolve_command_path_impl("codex")
        .map(PathBuf::from)
        .ok_or("承認済み操作の実行にはCodex CLIのインストールとログインが必要です")?;
    development::policy_allows(
        &binary,
        home.path(),
        &workspace.work,
        &rules,
        &["yorishiro-policy-validation".into()],
        cancel.clone(),
    )
    .await?;
    let service_login = if network && github_target(action["target"].as_str().unwrap_or("")) {
        let gh = crate::resolve_command_path_impl("gh")
            .map(PathBuf::from)
            .ok_or("GitHub CLIが見つかりません")?;
        let exact_binary = gh.to_str().ok_or("GitHub CLIのパスを読み取れません")?;
        // Preserve restrictions written against either the normal command name
        // or its absolute executable path before the host reads one credential.
        for executable in ["gh", exact_binary] {
            let args = [executable, "auth", "token", "--hostname", "github.com"].map(str::to_owned);
            if !development::policy_allows(
                &binary,
                home.path(),
                &workspace.work,
                &rules,
                &args,
                cancel.clone(),
            )
            .await?
            {
                return Err("既存の実行制限によりサービスのログインを引き継げません".into());
            }
        }
        Some(github_token(&gh, &workspace.work, cancel.clone()).await?)
    } else {
        None
    };
    let schema = workspace.job.join("report-schema.json");
    let report_path = workspace.job.join("report.json");
    fs::write(
        &schema,
        serde_json::to_vec(&json!({
            "type":"object","additionalProperties":false,
            "required":["outcome","summary","evidence","resultUrl","goalComplete"],
            "properties":{
                "outcome":{"enum":["completed","blocked"]},
                "summary":{"type":"string","minLength":1,"maxLength":16000},
                "evidence":{"type":"array","maxItems":8,"items":{"type":"string","maxLength":4000}},
                "resultUrl":{"anyOf":[{"type":"null"},{"type":"string","maxLength":4000}]}
                ,"goalComplete":{"type":"boolean"}
            }
        }))
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    let mut command = development::codex_command(&binary, home.path(), &workspace.work);
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_PROMPT_DISABLED", "1");
    if let Some(token) = service_login {
        let directory = workspace.work.join(".gh");
        create_directory(&directory)?;
        command
            .env("GH_CONFIG_DIR", directory)
            .env("GH_TOKEN", token);
    }
    if network {
        if let Some(value) = std::env::var_os("SSH_AUTH_SOCK") {
            command.env("SSH_AUTH_SOCK", value);
        }
    }
    command
        .args([
            "exec",
            "--strict-config",
            "--ephemeral",
            "--json",
            "--color",
            "never",
            "--skip-git-repo-check",
            "--output-schema",
        ])
        .arg(&schema)
        .arg("--output-last-message")
        .arg(&report_path)
        .arg("-");
    let result = development::capture(
        command,
        Some(prompt(&action, &workspace, network)?),
        Duration::from_secs(20 * 60),
        cancel,
    )
    .await?;
    if result.exit_code != 0 {
        return Err("承認済み操作の実行を確認できません。途中まで実行された可能性があるため再送せず、実行結果を確認してください".into());
    }
    // Keep real tool evidence even when verification blocks completion, so a
    // partial or ambiguous operation can be inspected without replaying it.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(workspace.job.join("tool-events.jsonl"))
        .map_err(|e| e.to_string())?;
    file.write_all(&result.stdout)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    verified_result(read_report(&report_path)?, &result.stdout, network)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(path: &Path) -> Workspace {
        Workspace {
            job: path.join("state/action"),
            work: path.join("state/action/work"),
            root: path.join("plain-folder"),
            references: vec![path.join("review-artifact")],
            review: None,
            delegated_goal: "Complete the delegated work".into(),
        }
    }

    #[test]
    fn saved_login_requires_an_explicit_approved_service_target() {
        for value in [
            "https://github.com/example/project",
            "git@github.com:example/project.git",
            "repository: git@github.com:example/project.git／branch: main",
        ] {
            assert!(github_target(value));
        }
        for value in [
            "github",
            "https://github.com.evil.test/example/project",
            "https://evil.test/?next=https://github.com/example/project",
            "https://user@github.com/example/project",
            "https://github.com",
            "report.txt",
        ] {
            assert!(!github_target(value));
        }
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "read-only verification using installed gh and an existing local GitHub login; no model or publication"]
    async fn live_sandbox_uses_only_the_approved_service_login() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let workspace = workspace(&root);
        fs::create_dir_all(workspace.work.join(".yorishiro-tmp")).unwrap();
        fs::create_dir(&workspace.root).unwrap();

        let home = root.join("transport");
        fs::create_dir(&home).unwrap();
        fs::write(
            home.join("config.toml"),
            profile(&workspace, true, dirs::home_dir().as_deref()),
        )
        .unwrap();
        let codex = crate::resolve_command_path_impl("codex").unwrap();
        let gh = crate::resolve_command_path_impl("gh").unwrap();
        let token = github_token(Path::new(&gh), &workspace.work, CancellationToken::new())
            .await
            .unwrap();
        let config_dir = workspace.work.join(".gh");
        create_directory(&config_dir).unwrap();
        let mut command = development::codex_command(Path::new(&codex), &home, &workspace.work);
        command
            .env("GH_CONFIG_DIR", &config_dir)
            .env("GH_TOKEN", token)
            .args(["sandbox", "-P", PROFILE, "-C"])
            .arg(&workspace.work)
            .arg("--")
            .arg(gh)
            .args(["auth", "status", "--hostname", "github.com"])
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(30), command.output())
            .await
            .unwrap()
            .unwrap();
        // Never print authentication diagnostics or credentials from the live account.
        assert!(
            output.status.success(),
            "approved service authentication was unavailable inside the sandbox"
        );
    }

    #[test]
    fn profile_grants_only_explicit_folders_and_typed_network_permission() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir(temp.path().join(".ssh")).unwrap();
        fs::write(temp.path().join(".ssh/known_hosts"), "public host key").unwrap();
        let workspace = workspace(temp.path());
        for network in [false, true] {
            let value: toml::Value =
                toml::from_str(&profile(&workspace, network, Some(temp.path()))).unwrap();
            assert_eq!(
                value["permissions"][PROFILE]["network"]["enabled"].as_bool(),
                Some(network)
            );
            let filesystem = value["permissions"][PROFILE]["filesystem"]
                .as_table()
                .unwrap();
            assert_eq!(
                filesystem[workspace.root.to_str().unwrap()].as_str(),
                Some("write")
            );
            assert_eq!(
                filesystem[workspace.references[0].to_str().unwrap()].as_str(),
                Some("read")
            );
            assert!(!filesystem.contains_key(temp.path().to_str().unwrap()));
            assert_eq!(
                filesystem.contains_key(temp.path().join(".ssh/known_hosts").to_str().unwrap()),
                network
            );
            assert!(!filesystem.contains_key(temp.path().join(".ssh").to_str().unwrap()));
            assert!(!filesystem.contains_key(temp.path().join(".config/gh").to_str().unwrap()));
            assert_eq!(value["approval_policy"].as_str(), Some("never"));
            assert_eq!(value["features"]["plugins"].as_bool(), Some(false));
            assert_eq!(value["features"]["multi_agent"].as_bool(), Some(false));
        }
    }

    #[test]
    fn plain_folder_setup_preserves_exact_scope_and_never_replays() {
        let temp = tempfile::tempdir().unwrap();
        let canonical = temp.path().canonicalize().unwrap();
        let root = canonical.join("documents");
        let storage = canonical.join("state");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&storage).unwrap();
        let run: Run = serde_json::from_value(json!({"id":uuid::Uuid::new_v4().to_string(),"startedAt":1,"finishedAt":2,"status":"completed","summary":"ready","reason":"","changedPaths":[],"canUndo":false})).unwrap();
        let mut contract: Contract = serde_json::from_value(json!({"goal":"organize report","root":root,"allowedOperations":["write","move","trash"],"intervalMinutes":30,"maxRunsPerDay":48,"enabled":true})).unwrap();
        let action = json!({"id":uuid::Uuid::new_v4().to_string(),"runId":run.id,"sourceRoot":root,"status":"executing"});
        let prepared = prepare(&storage, &action, &run, &contract).unwrap();
        assert!(!prepared.root.join(".git").exists());
        assert!(prepared.work.is_dir());
        assert!(prepare(&storage, &action, &run, &contract).is_err());
        contract.allowed_operations = vec!["write".into()];
        assert!(prepare(&storage, &action, &run, &contract).is_err());
    }

    #[test]
    fn completion_requires_real_tool_evidence_and_verified_external_url() {
        let events = b"{\"type\":\"item.completed\",\"item\":{\"type\":\"command_execution\",\"status\":\"completed\",\"command\":\"save-report\",\"exit_code\":0,\"aggregated_output\":\"saved report.txt\\nhttps://example.com/result/1\"}}\n{\"type\":\"turn.completed\"}\n";
        let report = || Report {
            outcome: Outcome::Completed,
            summary: "保存しました".into(),
            evidence: vec!["saved report.txt".into()],
            result_url: None,
            goal_complete: false,
        };
        assert!(verified_result(report(), events, false).is_ok());
        assert!(verified_result(report(), b"{\"type\":\"turn.completed\"}\n", false).is_err());
        let mut external = report();
        external.result_url = Some("https://example.com/result/1".into());
        assert!(verified_result(external, events, false).is_err());
        let mut invented = report();
        invented.evidence = vec!["not in tool output".into()];
        assert!(verified_result(invented, events, false).is_err());
        let mut blocked = report();
        blocked.outcome = Outcome::Blocked;
        assert_eq!(
            verified_result(blocked, events, false).err().as_deref(),
            Some("保存しました")
        );
    }

    #[test]
    fn prompt_keeps_non_git_approved_operation_as_the_only_objective() {
        let workspace = workspace(Path::new("/example"));
        let action = json!({"operation":"Save the exact report","target":"report.txt","details":"Approved content","networkAccess":false});
        let value = prompt(&action, &workspace, false).unwrap();
        assert!(value.contains("Save the exact report"));
        assert!(value.contains("plain folder with no Git repository"));
        assert!(value.contains("not another proposal"));
        assert!(value.contains("\"networkAccess\":false"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    #[ignore = "requires installed Codex sandbox and Node; no model or network call"]
    async fn live_sandbox_executes_non_git_operation_and_protects_state() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let workspace = workspace(&root);
        fs::create_dir_all(workspace.work.join(".yorishiro-tmp")).unwrap();
        fs::create_dir_all(workspace.root.join(".agents")).unwrap();
        fs::create_dir_all(workspace.root.join(".git")).unwrap();
        fs::create_dir_all(&workspace.references[0]).unwrap();
        fs::write(workspace.root.join("AGENTS.md"), "instructions").unwrap();
        fs::write(workspace.root.join(".env"), "private").unwrap();
        fs::write(workspace.references[0].join("review.txt"), "verified").unwrap();
        fs::write(root.join("unselected.txt"), "private").unwrap();
        fs::write(workspace.job.join("runtime-state.json"), "private").unwrap();
        let home = root.join("private-auth");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("auth.json"), "test-credential").unwrap();
        fs::write(home.join("config.toml"), profile(&workspace, false, None)).unwrap();
        let binary = crate::resolve_command_path_impl("codex").expect("Codex CLI");
        let node = crate::resolve_command_path_impl("node").expect("Node runtime");
        let script = r#"
process.on('uncaughtException', e => { console.log(JSON.stringify({error:e.code,message:e.message}));process.exit(1)});
const fs=require('fs'),net=require('net');const root=process.argv[1];
const source=root+'/plain-folder',ref=root+'/review-artifact',work=root+'/state/action/work';
const denied=f=>{try{f();return false}catch(e){return ['EPERM','EACCES'].includes(e.code)}};
fs.writeFileSync(source+'/report.txt','executed');
fs.writeFileSync(work+'/scratch.txt','ok');
fs.writeFileSync(source+'/.git/approved-local-metadata','ok');
const checks=[fs.readFileSync(ref+'/review.txt','utf8')==='verified',
denied(()=>fs.writeFileSync(ref+'/review.txt','bad')),
denied(()=>fs.readFileSync(root+'/private-auth/auth.json')),
denied(()=>fs.readFileSync(root+'/unselected.txt')),
denied(()=>fs.writeFileSync(root+'/state/action/runtime-state.json','bad')),
denied(()=>fs.writeFileSync(source+'/.agents/injected','bad')),
denied(()=>fs.writeFileSync(source+'/AGENTS.md','bad')),
denied(()=>fs.readFileSync(source+'/.env'))];
const socket=net.connect({host:'127.0.0.1',port:9});
socket.on('error',e=>{checks.push(['EPERM','EACCES'].includes(e.code));console.log(JSON.stringify(checks));process.exit(checks.every(Boolean)?0:1)});
setTimeout(()=>process.exit(2),3000);
"#;
        let mut command = development::codex_command(Path::new(&binary), &home, &workspace.work);
        command
            .args(["sandbox", "-P", PROFILE, "-C"])
            .arg(&workspace.work)
            .arg("--")
            .arg(node)
            .args(["-e", script])
            .arg(&root);
        let result =
            tokio::time::timeout(Duration::from_secs(15), command.kill_on_drop(true).output())
                .await
                .unwrap()
                .unwrap();
        assert!(
            result.status.success(),
            "sandbox assertions: {} {}",
            String::from_utf8_lossy(&result.stdout),
            String::from_utf8_lossy(&result.stderr)
        );
        assert_eq!(
            fs::read_to_string(workspace.root.join("report.txt")).unwrap(),
            "executed"
        );
        assert_eq!(
            fs::read_to_string(workspace.job.join("runtime-state.json")).unwrap(),
            "private"
        );
    }
}
