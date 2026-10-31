//! Optional, exact GitHub delivery using the installed CLI's native login.
//! No service tokens enter a model transport. Model-owned Git configuration is
//! never used by a native command; only verified objects enter a fresh repository.
use super::{action_worker::ExecutionResult, development};
use git2::{ObjectType, Oid, Repository, RepositoryInitOptions};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::Duration;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

#[derive(Clone, Debug, Deserialize, Serialize, JsonSchema, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Delivery {
    pub repository: String,
    pub remote_url: String,
    pub branch: String,
    pub base_branch: String,
    pub title: String,
    pub body: String,
}

impl Delivery {
    pub(super) fn validate(&self, target: &str, network: bool) -> Result<(), String> {
        let parts: Vec<_> = self.repository.split('/').collect();
        if !network
            || parts.len() != 2
            || parts.iter().any(|part| {
                part.is_empty()
                    || part.len() > 100
                    || matches!(*part, "." | "..")
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b"-_.".contains(&b))
            })
            || self.remote_url != format!("https://github.com/{}.git", self.repository)
            || !target
                .split_whitespace()
                .any(|value| value == self.remote_url)
            || self.branch == self.base_branch
            || [&self.branch, &self.base_branch].iter().any(|value| {
                value.len() > 240
                    || value.starts_with('-')
                    || !git2::Reference::is_valid_name(&format!("refs/heads/{value}"))
            })
            || self.title.trim().is_empty()
            || self.title.len() > 500
            || self.title.contains(['\0', '\n', '\r'])
            || self.body.trim().is_empty()
            || self.body.len() > 12_000
            || self.body.contains('\0')
        {
            return Err("GitHub公開操作のリポジトリ・ブランチ・PR内容が不正です".into());
        }
        let hosts = super::action_worker::network_hosts(target)?;
        if hosts != ["api.github.com", "github.com"] {
            return Err(
                "GitHub公開操作には承認対象に正確なリモートURLと https://api.github.com が必要です"
                    .into(),
            );
        }
        Ok(())
    }
}

fn directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("公開用コピーの保存先が不正です".into());
    }
    let mut cursor = PathBuf::new();
    for part in path.components() {
        if !matches!(part, Component::RootDir | Component::Normal(_)) {
            return Err("公開用コピーの保存先が不正です".into());
        }
        cursor.push(part);
        let metadata = fs::symlink_metadata(&cursor).map_err(|_| "公開用コピーを確認できません")?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err("公開用コピーの保存先にリンクは使用できません".into());
        }
    }
    path.canonicalize()
        .map_err(|_| "公開用コピーを確認できません".into())
}

fn text<'a>(review: &'a Value, key: &str) -> Result<&'a str, String> {
    review[key]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("公開する検証済み成果物に {key} がありません"))
}

fn origin_matches(origin: &str, delivery: &Delivery) -> bool {
    let https = format!("https://github.com/{}", delivery.repository);
    let ssh = format!("git@github.com:{}", delivery.repository);
    let ssh_url = format!("ssh://git@github.com/{}", delivery.repository);
    [https, ssh, ssh_url]
        .iter()
        .any(|value| origin == value || origin == format!("{value}.git"))
}

/// Copy only the reachable, hash-verified Git object graph, never config/hooks,
/// alternates, working files, or credentials from the model-owned repository.
fn import_objects(source: &Repository, target: &Repository, roots: &[Oid]) -> Result<(), String> {
    let input = source
        .odb()
        .map_err(|_| "Gitオブジェクトを読み出せません")?;
    let output = target
        .odb()
        .map_err(|_| "公開用Gitオブジェクトを保存できません")?;
    let mut pending = roots.to_vec();
    let mut seen = BTreeSet::new();
    let mut bytes = 0usize;
    while let Some(oid) = pending.pop() {
        if !seen.insert(oid) {
            continue;
        }
        if seen.len() > 200_000 {
            return Err("公開するGit履歴が上限を超えました".into());
        }
        let object = input
            .read(oid)
            .map_err(|_| "公開に必要なGit履歴がそろっていません")?;
        bytes = bytes
            .checked_add(object.len())
            .ok_or("Git履歴が大きすぎます")?;
        if bytes > 512 * 1024 * 1024 {
            return Err("公開するGit履歴が上限を超えました".into());
        }
        let actual = output
            .write(object.kind(), object.data())
            .map_err(|_| "公開用Git履歴を保存できません")?;
        if actual != oid {
            return Err("Gitオブジェクトの内容が識別子と一致しません".into());
        }
        match object.kind() {
            ObjectType::Commit => {
                let commit = source
                    .find_commit(oid)
                    .map_err(|_| "Gitコミットが不正です")?;
                pending.push(commit.tree_id());
                pending.extend(commit.parent_ids());
            }
            ObjectType::Tree => {
                let tree = source.find_tree(oid).map_err(|_| "Gitツリーが不正です")?;
                for entry in &tree {
                    if matches!(entry.kind(), Some(ObjectType::Tree | ObjectType::Blob)) {
                        pending.push(entry.id());
                    }
                }
            }
            ObjectType::Blob => (),
            _ => return Err("公開対象に未対応のGitオブジェクトがあります".into()),
        }
    }
    Ok(())
}

struct Prepared {
    path: PathBuf,
    commit: Oid,
}

fn prepare_repository(
    job: &Path,
    work: &Path,
    review: &Value,
    delivery: &Delivery,
) -> Result<Prepared, String> {
    let job = directory(job)?;
    let work = directory(work)?;
    if text(review, "branch")? != delivery.branch
        || text(review, "baseBranch")? != delivery.base_branch
        || !origin_matches(text(review, "origin")?, delivery)
    {
        return Err("公開先とブランチが検証済み成果物の記録と一致しません".into());
    }
    let base = Oid::from_str(text(review, "baseCommit")?).map_err(|_| "基準コミットが不正です")?;
    let verified =
        Oid::from_str(text(review, "verifiedTree")?).map_err(|_| "検証済みツリーが不正です")?;
    let artifact = directory(Path::new(text(review, "artifactPath")?))?;
    let diagnostic = directory(
        &artifact
            .parent()
            .ok_or("成果物の保存先が不正です")?
            .join("repository"),
    )?;
    let reference = Repository::open(&diagnostic).map_err(|_| "検証済みGit履歴を開けません")?;
    directory(reference.path())?;
    let mut preserved = None;
    let candidate = work.join("repository");
    let editable = if candidate.exists() {
        let candidate = directory(&candidate)?;
        let repo =
            Repository::open(&candidate).map_err(|_| "先行操作のGitコピーを確認できません")?;
        if repo.workdir().and_then(|path| path.canonicalize().ok()) != Some(candidate) {
            return Err("先行操作のGitコピーのルートが一致しません".into());
        }
        directory(repo.path())?;
        let head = repo
            .head()
            .map_err(|_| "先行操作のコミットを確認できません")?;
        if head.name() != Some(format!("refs/heads/{}", delivery.branch).as_str()) {
            return Err("先行操作のブランチが検証済みの記録と一致しません".into());
        }
        let commit = head
            .peel_to_commit()
            .map_err(|_| "先行操作のコミットを確認できません")?;
        if commit.id() != base {
            if commit.tree_id() != verified
                || commit.parent_count() != 1
                || commit.parent_id(0).ok() != Some(base)
            {
                return Err(
                    "先行操作のコミットが検証済みツリーと基準コミットに一致しません".into(),
                );
            }
            preserved = Some(commit.id());
        }
        drop(commit);
        drop(head);
        Some(repo)
    } else {
        // An unexpected differently named clone must not be silently replaced
        // with a new commit. Its existing result needs an explicit handoff.
        for entry in fs::read_dir(&work)
            .map_err(|_| "先行操作のコピーを確認できません")?
            .take(100)
        {
            let path = entry
                .map_err(|_| "先行操作のコピーを確認できません")?
                .path();
            if path.join(".git").exists() {
                return Err(
                    "先行操作のGitコピーの場所を確認できません。既存のコミットは作り直していません"
                        .into(),
                );
            }
        }
        None
    };
    let path = job.join("native-repository");
    fs::create_dir(&path).map_err(|_| "この公開操作の開始記録はすでに存在します。再送しません")?;
    let mut options = RepositoryInitOptions::new();
    options
        .no_reinit(true)
        .external_template(false)
        .initial_head(&delivery.branch);
    let repository =
        Repository::init_opts(&path, &options).map_err(|_| "公開用Gitコピーを作成できません")?;
    import_objects(&reference, &repository, &[base, verified])?;
    let oid = if let Some(oid) = preserved {
        import_objects(
            editable.as_ref().ok_or("既存のコミットがありません")?,
            &repository,
            &[oid],
        )?;
        oid
    } else {
        let tree = repository
            .find_tree(verified)
            .map_err(|_| "検証済みツリーを読み出せません")?;
        let parent = repository
            .find_commit(base)
            .map_err(|_| "基準コミットを読み出せません")?;
        let author = git2::Signature::now("Yorishiro", "yorishiro@users.noreply.github.com")
            .map_err(|_| "公開コミットの署名を作成できません")?;
        repository
            .commit(None, &author, &author, &delivery.title, &tree, &[&parent])
            .map_err(|_| "検証済み変更をコミットできません")?
    };
    repository
        .reference(
            &format!("refs/heads/{}", delivery.branch),
            oid,
            false,
            "approved verified delivery",
        )
        .map_err(|_| "公開用ブランチを保存できません")?;
    Ok(Prepared { path, commit: oid })
}

fn command(binary: &Path, directory: &Path) -> Result<Command, String> {
    let mut command = Command::new(binary);
    command
        .env_clear()
        .current_dir(directory)
        .env("HOME", crate::home_dir_or_err()?)
        .env("PATH", crate::build_path_env())
        .env("LANG", "en_US.UTF-8")
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .env("GH_NO_UPDATE_NOTIFIER", "1")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_ASKPASS", "/usr/bin/false")
        .env("SSH_ASKPASS", "/usr/bin/false");
    Ok(command)
}

fn receipt(
    job: &Path,
    step: &str,
    status: &str,
    output: Option<&development::Captured>,
) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .append(true)
        .create(true)
        .open(job.join("native-events.jsonl"))
        .map_err(|_| "公開操作の実行記録を保存できません")?;
    let value = json!({"step":step,"status":status,"exitCode":output.map(|value| value.exit_code),
        "output":output.map(|value| String::from_utf8_lossy(&value.stdout).into_owned())});
    serde_json::to_writer(&mut file, &value).map_err(|_| "公開操作の実行記録を保存できません")?;
    file.write_all(b"\n")
        .and_then(|_| file.sync_all())
        .map_err(|_| "公開操作の実行記録を保存できません".into())
}

async fn run(
    job: &Path,
    step: &str,
    command: Command,
    mutation: bool,
    cancel: CancellationToken,
) -> Result<development::Captured, String> {
    if cancel.is_cancelled() {
        return Err("公開操作を停止しました。次の通信は実行していません".into());
    }
    receipt(job, step, "started", None)?;
    let result = development::capture(command, None, Duration::from_secs(5 * 60), cancel).await
        .map_err(|error| if mutation { format!("{step}の結果を確認できません。途中まで実行された可能性があるため再送しません: {error}") } else { error })?;
    receipt(job, step, "finished", Some(&result))?;
    if result.exit_code != 0 {
        return Err(if mutation {
            format!("{step}の完了を確認できません。外部に反映済みの可能性があるため同じ操作は再送しません。実行記録を確認してください")
        } else {
            format!("{step}を確認できません。インストール済みGitHub CLIのログインと対象リポジトリへのアクセスを確認してください")
        });
    }
    Ok(result)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PullRequest {
    url: String,
    head_ref_name: String,
    base_ref_name: String,
    head_ref_oid: String,
    title: String,
    body: String,
}

fn verified_pr(
    pr: &PullRequest,
    delivery: &Delivery,
    commit: Option<Oid>,
) -> Result<String, String> {
    let prefix = format!("https://github.com/{}/pull/", delivery.repository);
    if pr
        .url
        .strip_prefix(&prefix)
        .is_none_or(|number| number.is_empty() || !number.bytes().all(|b| b.is_ascii_digit()))
        || pr.head_ref_name != delivery.branch
        || pr.base_ref_name != delivery.base_branch
        || pr.title != delivery.title
        || pr.body != delivery.body
        || commit.is_some_and(|oid| pr.head_ref_oid != oid.to_string())
    {
        return Err("既存または作成済みPRの対象・内容・コミットが承認内容に一致しません。PRを追加作成せず停止しました".into());
    }
    Ok(pr.url.clone())
}

pub(super) async fn execute(
    job: &Path,
    work: &Path,
    review: &Value,
    delivery: &Delivery,
    cancel: CancellationToken,
) -> Result<ExecutionResult, String> {
    if cancel.is_cancelled() {
        return Err("公開操作を停止しました".into());
    }
    let git = crate::resolve_command_path_impl("git")
        .map(PathBuf::from)
        .ok_or("公開操作にはGitが必要です")?;
    let gh = crate::resolve_command_path_impl("gh")
        .map(PathBuf::from)
        .ok_or("GitHubへの公開にはログイン済みGitHub CLIが必要です")?;
    execute_with_tools(job, work, review, delivery, cancel, &git, &gh).await
}

async fn execute_with_tools(
    job: &Path,
    work: &Path,
    review: &Value,
    delivery: &Delivery,
    cancel: CancellationToken,
    git: &Path,
    gh: &Path,
) -> Result<ExecutionResult, String> {
    if cancel.is_cancelled() {
        return Err("公開操作を停止しました".into());
    }
    let prepared = {
        let job = job.to_path_buf();
        let work = work.to_path_buf();
        let review = review.clone();
        let delivery = delivery.clone();
        tauri::async_runtime::spawn_blocking(move || {
            prepare_repository(&job, &work, &review, &delivery)
        })
        .await
        .map_err(|_| "公開用Git履歴の準備を確認できません")??
    };
    if cancel.is_cancelled() {
        return Err("公開操作を停止しました。外部への通信は実行していません".into());
    }
    let fields = "url,headRefName,baseRefName,headRefOid,title,body";
    let mut list = command(gh, &prepared.path)?;
    list.args([
        "pr",
        "list",
        "--repo",
        &delivery.repository,
        "--head",
        &delivery.branch,
        "--base",
        &delivery.base_branch,
        "--state",
        "open",
        "--json",
        fields,
    ]);
    let listed = run(job, "既存PRの確認", list, false, cancel.clone()).await?;
    let existing: Vec<PullRequest> =
        serde_json::from_slice(&listed.stdout).map_err(|_| "既存PRの確認結果を読み取れません")?;
    if existing.len() > 1 {
        return Err("同じブランチに複数のPRがあります。追加作成せず確認してください".into());
    }
    let existing_url = existing
        .first()
        .map(|pr| verified_pr(pr, delivery, None))
        .transpose()?;
    let helper = format!(
        "!'{}' auth git-credential",
        gh.to_string_lossy().replace('\'', "'\\''")
    );
    let mut push = command(git, &prepared.path)?;
    push.args([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
    ])
    .arg(format!("credential.helper={helper}"))
    .args([
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "http.followRedirects=false",
        "-c",
        "http.sslVerify=true",
        "push",
        "--porcelain",
        "--no-verify",
        &delivery.remote_url,
        &format!("HEAD:refs/heads/{}", delivery.branch),
    ]);
    run(job, "検証済みコミットのpush", push, true, cancel.clone()).await?;
    let url = if let Some(url) = existing_url {
        url
    } else {
        let body_path = job.join("approved-pr-body.txt");
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&body_path)
            .map_err(|_| "承認済みPR本文を保存できません")?;
        file.write_all(delivery.body.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "承認済みPR本文を保存できません")?;
        let mut create = command(gh, &prepared.path)?;
        create
            .args([
                "pr",
                "create",
                "--repo",
                &delivery.repository,
                "--head",
                &delivery.branch,
                "--base",
                &delivery.base_branch,
                "--title",
                &delivery.title,
                "--body-file",
            ])
            .arg(&body_path);
        let created = run(job, "PR作成", create, true, cancel.clone()).await?;
        let output = String::from_utf8(created.stdout)
            .map_err(|_| "作成済みPRのURLを読み取れません。再作成せず実行記録を確認してください")?;
        let prefix = format!("https://github.com/{}/pull/", delivery.repository);
        output
            .lines()
            .map(str::trim)
            .find(|line| {
                line.strip_prefix(&prefix).is_some_and(|number| {
                    !number.is_empty() && number.bytes().all(|b| b.is_ascii_digit())
                })
            })
            .ok_or("PR作成後のURLを確認できません。再作成せず実行記録を確認してください")?
            .to_owned()
    };
    let mut view = command(gh, &prepared.path)?;
    view.args([
        "pr",
        "view",
        &url,
        "--repo",
        &delivery.repository,
        "--json",
        fields,
    ]);
    let observed = run(job, "公開済みPRの検証", view, false, cancel).await?;
    let pr: PullRequest = serde_json::from_slice(&observed.stdout).map_err(|_| {
        "作成済みPRの検証結果を読み取れません。再作成せず実行記録を確認してください"
    })?;
    let url = verified_pr(&pr, delivery, Some(prepared.commit))?;
    let summary = format!(
        "検証済み変更をpushし、PRを確認しました: {url}\nコミット: {}\n公開用コピー: {}",
        prepared.commit,
        prepared.path.display()
    );
    let report = json!({"outcome":"completed","summary":summary,"resultUrl":url,"goalComplete":false,
        "evidence":[prepared.commit.to_string(),url]});
    fs::write(
        job.join("native-result.json"),
        serde_json::to_vec_pretty(&report).map_err(|_| "公開結果を保存できません")?,
    )
    .map_err(|_| {
        "公開結果を保存できません。PRは作成済みの可能性があります。再作成せず確認してください"
    })?;
    Ok(ExecutionResult {
        summary,
        result_url: Some(url),
        goal_complete: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn delivery() -> Delivery {
        Delivery {
            repository: "example/project".into(),
            remote_url: "https://github.com/example/project.git".into(),
            branch: "yorishiro/verified".into(),
            base_branch: "main".into(),
            title: "Fix the delegated behavior".into(),
            body: "Reviewed verified change.".into(),
        }
    }
    #[test]
    fn capability_requires_exact_explicit_destinations_and_safe_payload() {
        let good = delivery();
        let target = format!("{} https://api.github.com", good.remote_url);
        assert!(good.validate(&target, true).is_ok());
        assert!(good.validate(&target, false).is_err());
        assert!(good.validate(&good.remote_url, true).is_err());
        assert!(good
            .validate(&format!("{target} https://unexpected.example"), true)
            .is_err());
        for branch in [
            "main",
            "../main",
            "--all",
            "branch:refs/heads/main",
            "invalid name",
        ] {
            let mut bad = good.clone();
            bad.branch = branch.into();
            assert!(bad.validate(&target, true).is_err(), "{branch}");
        }
        let mut bad = good.clone();
        bad.remote_url = "https://user:secret@github.com/example/project.git".into();
        assert!(bad.validate(&target, true).is_err());
        let mut bad = good.clone();
        bad.repository = "example/project/other".into();
        assert!(bad.validate(&target, true).is_err());
    }

    fn fixture() -> (tempfile::TempDir, PathBuf, PathBuf, Value, Delivery, Oid) {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let original = root.join("development");
        fs::create_dir(&original).unwrap();
        let repository = Repository::init(original.join("repository")).unwrap();
        let sig = git2::Signature::now("Fixture", "fixture@example.test").unwrap();
        fs::write(repository.workdir().unwrap().join("file.txt"), "base").unwrap();
        let mut index = repository.index().unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        let base_tree = repository.find_tree(index.write_tree().unwrap()).unwrap();
        let base = repository
            .commit(Some("HEAD"), &sig, &sig, "base", &base_tree, &[])
            .unwrap();
        fs::write(repository.workdir().unwrap().join("file.txt"), "verified").unwrap();
        index.add_path(Path::new("file.txt")).unwrap();
        let verified = index.write_tree().unwrap();
        let artifact = original.join("review-artifact");
        fs::create_dir(&artifact).unwrap();
        fs::write(artifact.join("file.txt"), "verified").unwrap();
        let job = root.join("job");
        let work = root.join("work");
        fs::create_dir(&job).unwrap();
        fs::create_dir(&work).unwrap();
        let delivery = delivery();
        let review = json!({"artifactPath":artifact,"baseCommit":base.to_string(),"verifiedTree":verified.to_string(),"branch":delivery.branch,"baseBranch":delivery.base_branch,"origin":delivery.remote_url});
        (temp, job, work, review, delivery, base)
    }

    #[test]
    fn new_delivery_uses_only_verified_objects_without_diagnostic_worktree_changes() {
        let (_temp, job, work, review, delivery, base) = fixture();
        let diagnostic = Path::new(review["artifactPath"].as_str().unwrap())
            .parent()
            .unwrap()
            .join("repository");
        fs::write(diagnostic.join("file.txt"), "unverified later edit").unwrap();
        let result = prepare_repository(&job, &work, &review, &delivery).unwrap();
        let repo = Repository::open(&result.path).unwrap();
        let commit = repo.find_commit(result.commit).unwrap();
        assert_eq!(
            commit.tree_id().to_string(),
            review["verifiedTree"].as_str().unwrap()
        );
        assert_eq!(commit.parent_id(0).unwrap(), base);
        assert_eq!(
            fs::read_to_string(diagnostic.join("file.txt")).unwrap(),
            "unverified later edit"
        );
        assert!(prepare_repository(&job, &work, &review, &delivery).is_err());
    }

    #[test]
    fn native_copy_retains_verified_commit_but_never_imports_model_configuration() {
        let (_temp, job, work, review, delivery, base) = fixture();
        let diagnostic = Path::new(review["artifactPath"].as_str().unwrap())
            .parent()
            .unwrap()
            .join("repository");
        let source = Repository::open(&diagnostic).unwrap();
        let editable = Repository::init(work.join("repository")).unwrap();
        let tree = Oid::from_str(review["verifiedTree"].as_str().unwrap()).unwrap();
        import_objects(&source, &editable, &[tree, base]).unwrap();
        let tree = editable.find_tree(tree).unwrap();
        let base = editable.find_commit(base).unwrap();
        let sig = git2::Signature::now("Existing Author", "existing@example.test").unwrap();
        let oid = editable
            .commit(
                None,
                &sig,
                &sig,
                "Original verified commit",
                &tree,
                &[&base],
            )
            .unwrap();
        editable
            .reference(&format!("refs/heads/{}", delivery.branch), oid, false, "")
            .unwrap();
        editable
            .set_head(&format!("refs/heads/{}", delivery.branch))
            .unwrap();
        editable
            .config()
            .unwrap()
            .set_str("url.https://evil.example/.insteadOf", "https://github.com/")
            .unwrap();
        editable
            .config()
            .unwrap()
            .set_str("credential.helper", "!malicious-helper")
            .unwrap();
        let prepared = prepare_repository(&job, &work, &review, &delivery).unwrap();
        assert_eq!(prepared.commit, oid);
        let fresh = Repository::open(prepared.path).unwrap();
        let config = fs::read_to_string(fresh.path().join("config")).unwrap();
        assert!(!config.contains("evil.example"));
        assert!(!config.contains("malicious-helper"));
        let mut altered = review.clone();
        altered["branch"] = json!("wrong");
        assert!(prepare_repository(&job, &work, &altered, &delivery).is_err());
    }

    #[test]
    fn result_must_match_exact_repository_content_and_commit() {
        let delivery = delivery();
        let oid = Oid::from_str("0123456789012345678901234567890123456789").unwrap();
        let mut pr = PullRequest {
            url: "https://github.com/example/project/pull/42".into(),
            head_ref_name: delivery.branch.clone(),
            base_ref_name: delivery.base_branch.clone(),
            head_ref_oid: oid.to_string(),
            title: delivery.title.clone(),
            body: delivery.body.clone(),
        };
        assert!(verified_pr(&pr, &delivery, Some(oid)).is_ok());
        pr.url = "https://github.com/other/project/pull/42".into();
        assert!(verified_pr(&pr, &delivery, Some(oid)).is_err());
    }

    #[cfg(target_os = "macos")]
    fn executable(path: &Path, content: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::write(path, content).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(target_os = "macos")]
    async fn mock_delivery(fail_create: bool) -> (Result<ExecutionResult, String>, String, String) {
        let (_temp, job, work, review, delivery, _base) = fixture();
        let log = job.join("calls.txt");
        let git_args = job.join("git-args.txt");
        let gh = job.join("fixture-gh");
        let git = job.join("fixture-git");
        let quote =
            |path: &Path| format!("'{}'", path.display().to_string().replace('\'', "'\\''"));
        let guard =
            "if [ -n \"$GH_TOKEN$GITHUB_TOKEN$GH_CONFIG_DIR$SSH_AUTH_SOCK\" ]; then exit 77; fi";
        executable(&git, &format!("#!/bin/sh\n{guard}\nprintf 'git push\\n' >> {}\nprintf '%s\\n' \"$@\" > {}\nprintf 'Pushed verified branch\\n'\n", quote(&log), quote(&git_args)));
        // The only real Git command in this fixture is local rev-parse. Both
        // external mutations are test scripts and cannot contact a service.
        let local_git = crate::resolve_command_path_impl("git").unwrap();
        let local_git = quote(Path::new(&local_git));
        let create = if fail_create {
            "exit 42"
        } else {
            "printf 'https://github.com/example/project/pull/42\\n'"
        };
        executable(
            &gh,
            &format!(
                r#"#!/bin/sh
{guard}
printf 'gh %s %s\n' "$1" "$2" >> {log}
case "$1 $2" in
'pr list') printf '[]\n';;
'pr create') {create};;
'pr view')
  oid=$({local_git} rev-parse HEAD) || exit 43
  printf '{{"url":"https://github.com/example/project/pull/42","headRefName":"yorishiro/verified","baseRefName":"main","headRefOid":"%s","title":"Fix the delegated behavior","body":"Reviewed verified change."}}\n' "$oid";;
*) exit 44;;
esac
"#,
                log = quote(&log)
            ),
        );
        let result = execute_with_tools(
            &job,
            &work,
            &review,
            &delivery,
            CancellationToken::new(),
            &git,
            &gh,
        )
        .await;
        let calls = fs::read_to_string(log).unwrap();
        let args = fs::read_to_string(git_args).unwrap();
        (result, calls, args)
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn native_commands_publish_and_verify_with_fixed_argv_without_forwarding_secrets() {
        let (result, calls, args) = mock_delivery(false).await;
        let result = result.unwrap();
        assert_eq!(
            result.result_url.as_deref(),
            Some("https://github.com/example/project/pull/42")
        );
        assert!(!result.goal_complete);
        assert_eq!(calls, "gh pr list\ngit push\ngh pr create\ngh pr view\n");
        assert!(args.contains("core.hooksPath=/dev/null\n"));
        assert!(args.contains("credential.helper=\n"));
        assert!(args.contains("http.followRedirects=false\n"));
        assert!(args.ends_with(
            "https://github.com/example/project.git\nHEAD:refs/heads/yorishiro/verified\n"
        ));
        assert!(!args.contains("--force"));
    }

    #[cfg(target_os = "macos")]
    #[tokio::test]
    async fn ambiguous_pr_creation_is_never_retried_or_reported_complete() {
        let (result, calls, _args) = mock_delivery(true).await;
        assert!(result.err().unwrap().contains("再送しません"));
        assert_eq!(calls, "gh pr list\ngit push\ngh pr create\n");
    }
}
