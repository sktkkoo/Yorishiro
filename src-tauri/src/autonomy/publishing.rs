//! Explicit, single-use publication of a fully reviewed immutable artifact.
//! Preparation is entirely local. Only the approved frozen payload reaches the
//! trusted Git/GitHub transports; any ambiguous mutation is never retried.
use super::development::{DevelopmentResult, ExecutedCheck};
use base64::Engine;
use git2::{
    build::CloneLocal, build::RepoBuilder, IndexEntry, IndexTime, ObjectType, Oid, Repository,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
const MAX_OUTPUT: usize = 1024 * 1024;
const MAX_DIFF: usize = 256 * 1024;
const UNCERTAIN: &str = "GitHubへの送信結果が不明です。ブランチやPRが作成された可能性があります。再送せずGitHubで確認してください。";
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryScope {
    pub remote_url: String,
    pub github_repo: String,
    pub base_branch: String,
}

fn github_repository(remote: &str) -> Result<String, String> {
    let path = remote
        .strip_prefix("https://github.com/")
        .or_else(|| remote.strip_prefix("git@github.com:"))
        .ok_or("PRの作成先にはgithub.comのHTTPSまたはSSHリポジトリを指定してください")?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let parts: Vec<_> = path.split('/').collect();
    if parts.len() != 2
        || parts.iter().any(|part| {
            part.is_empty()
                || part.len() > 100
                || part.starts_with('.')
                || part.starts_with('-')
                || !part
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
        })
    {
        return Err("GitHubリポジトリの指定が不正です".into());
    }
    Ok(path.to_owned())
}

fn checked_branch(branch: &str) -> Result<(), String> {
    if branch.len() > 200
        || branch.starts_with('-')
        || !git2::Reference::is_valid_name(&format!("refs/heads/{branch}"))
    {
        return Err("PRのベースブランチが不正です".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PublicationReview {
    pub preparation_id: String,
    pub artifact_path: String,
    pub repository: String,
    pub base_branch: String,
    pub base_commit: String,
    pub head_branch: String,
    pub commit: String,
    pub artifact_tree: String,
    pub title: String,
    pub body: String,
    pub diff: String,
    pub changed_paths: Vec<String>,
    pub checks: Vec<ExecutedCheck>,
    pub source_root: String,
    pub payload_digest: String,
}

#[derive(Debug)]
pub enum PublicationError {
    NotStarted(String),
    Unknown(String),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Source {
    root: PathBuf,
    base_commit: String,
    base_branch: String,
    origin_url: String,
    branch: String,
}

fn directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("公開用の保存先が不正です".into());
    }
    let mut current = PathBuf::new();
    for part in path.components() {
        if !matches!(part, Component::RootDir | Component::Normal(_)) {
            return Err("公開用のパスが不正です".into());
        }
        current.push(part);
        let meta =
            fs::symlink_metadata(&current).map_err(|_| "公開用のフォルダが見つかりません")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("公開用フォルダのリンクは使用できません".into());
        }
    }
    Ok(current)
}

fn read_file(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "公開に必要なファイルを安全に読み取れません")?;
    let meta = file
        .metadata()
        .map_err(|_| "公開ファイルを確認できません")?;
    if !meta.is_file() || meta.len() > limit {
        return Err("公開ファイルが大きすぎるか通常ファイルではありません".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if meta.nlink() != 1 {
            return Err("公開ファイルのハードリンクは使用できません".into());
        }
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "公開ファイルを読み取れません")?;
    if bytes.len() as u64 > limit {
        return Err("公開ファイルが大きすぎます".into());
    }
    Ok(bytes)
}

fn private_file(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "公開記録が既にあるか保存できません。再送しないでください")?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "公開記録を確定できません")?;
    fs::File::open(path.parent().ok_or("公開記録の保存先が不正です")?)
        .and_then(|dir| dir.sync_all())
        .map_err(|_| "公開記録を確定できません".to_owned())
}

fn digest(review: &PublicationReview) -> Result<String, String> {
    let mut copy = review.clone();
    copy.payload_digest.clear();
    let bytes = serde_json::to_vec(&copy).map_err(|_| "承認内容を識別できません")?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn allowed_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 4096
        && !path.chars().any(char::is_control)
        && Path::new(path).components().all(|part| match part {
            Component::Normal(name) => {
                let name = name.to_string_lossy().to_ascii_lowercase();
                !name.starts_with('.')
                    && !matches!(
                        name.as_str(),
                        "agents.md" | "claude.md" | "id_rsa" | "id_ed25519"
                    )
                    && ![".pem", ".key", ".p12", ".pfx"]
                        .iter()
                        .any(|suffix| name.ends_with(suffix))
            }
            _ => false,
        })
}

/// Read the immutable review folder, never mutable diagnostic worktree files.
/// Raw buffer insertion avoids attributes/filters and produces an exact tree ID.
fn artifact_tree(repo: &Repository, artifact: &Path) -> Result<Oid, String> {
    directory(artifact)?;
    let mut index = repo.index().map_err(|_| "公開用インデックスを作れません")?;
    index
        .clear()
        .map_err(|_| "公開用インデックスを初期化できません")?;
    let mut pending = vec![artifact.to_path_buf()];
    let mut count = 0usize;
    let mut total = 0usize;
    let mut entries = 0usize;
    while let Some(dir) = pending.pop() {
        for entry in fs::read_dir(&dir).map_err(|_| "成果物を読み取れません")? {
            let path = entry.map_err(|_| "成果物を読み取れません")?.path();
            let relative = path
                .strip_prefix(artifact)
                .map_err(|_| "成果物のパスが不正です")?;
            entries += 1;
            if entries > 40000 || relative.components().count() > 64 {
                return Err("成果物のフォルダが公開の上限を超えています".into());
            }
            if relative
                .components()
                .any(|part| !matches!(part, Component::Normal(name) if name != ".git"))
            {
                return Err("成果物のパスが不正です".into());
            }
            let meta = fs::symlink_metadata(&path).map_err(|_| "成果物を確認できません")?;
            if meta.file_type().is_symlink() {
                return Err("成果物のリンクは公開できません".into());
            }
            if meta.is_dir() {
                directory(&path)?;
                pending.push(path);
                continue;
            }
            let bytes = read_file(&path, 32 * 1024 * 1024)?;
            count += 1;
            total = total.saturating_add(bytes.len());
            if count > 20_000 || total > 256 * 1024 * 1024 {
                return Err("成果物が公開の上限を超えています".into());
            }
            let path_bytes = relative
                .to_str()
                .ok_or("UTF-8以外の成果物パスは公開できません")?
                .as_bytes()
                .to_vec();
            #[cfg(unix)]
            let mode = {
                use std::os::unix::fs::PermissionsExt;
                if meta.permissions().mode() & 0o111 != 0 {
                    0o100755
                } else {
                    0o100644
                }
            };
            #[cfg(not(unix))]
            let mode = 0o100644;
            let entry = IndexEntry {
                ctime: IndexTime::new(0, 0),
                mtime: IndexTime::new(0, 0),
                dev: 0,
                ino: 0,
                mode,
                uid: 0,
                gid: 0,
                file_size: bytes.len() as u32,
                id: Oid::zero(),
                flags: 0,
                flags_extended: 0,
                path: path_bytes,
            };
            index
                .add_frombuffer(&entry, &bytes)
                .map_err(|_| "成果物ツリーを作れません")?;
        }
    }
    index
        .write_tree()
        .map_err(|_| "成果物ツリーを確定できません".into())
}

fn diff(repo: &Repository, base: Oid, tree: Oid) -> Result<(String, Vec<String>), String> {
    let before = repo
        .find_commit(base)
        .and_then(|commit| commit.tree())
        .map_err(|_| "元のコミットが保存されていません")?;
    let after = repo
        .find_tree(tree)
        .map_err(|_| "成果物ツリーがありません")?;
    let changes = repo
        .diff_tree_to_tree(Some(&before), Some(&after), None)
        .map_err(|_| "公開差分を作れません")?;
    let mut paths = BTreeSet::new();
    for change in changes.deltas() {
        for file in [change.old_file(), change.new_file()] {
            if let Some(path) = file.path() {
                let path = path.to_str().ok_or("差分のファイル名が不正です")?;
                if !allowed_path(path)
                    || matches!(file.mode(), git2::FileMode::Link | git2::FileMode::Commit)
                {
                    return Err("設定・認証・ワークフロー・リンクの変更はアプリから公開できません。成果物を手動で確認してください".into());
                }
                paths.insert(path.to_owned());
                if !file.id().is_zero() {
                    let blob = repo
                        .find_blob(file.id())
                        .map_err(|_| "差分の内容を読めません")?;
                    if blob.size() > 1024 * 1024 || blob.content().contains(&0) {
                        return Err("大きなファイルやバイナリ差分はアプリから公開できません".into());
                    }
                }
            }
        }
    }
    if paths.is_empty() || paths.len() > 200 {
        return Err("公開できる差分がないか、変更ファイルが多すぎます".into());
    }
    let mut text = Vec::new();
    let mut too_large = false;
    changes
        .print(git2::DiffFormat::Patch, |_, _, line| {
            let origin = line.origin();
            if matches!(origin, '+' | '-' | ' ') {
                text.push(origin as u8);
            }
            text.extend_from_slice(line.content());
            if text.len() > MAX_DIFF {
                too_large = true;
                false
            } else {
                true
            }
        })
        .map_err(|_| {
            if too_large {
                "差分全体を表示できる上限を超えています。省略した内容は承認できません"
            } else {
                "差分を作成できません"
            }
        })?;
    Ok((
        String::from_utf8(text).map_err(|_| "UTF-8以外の差分は表示できません")?,
        paths.into_iter().collect(),
    ))
}

pub fn prepare(job: &Path, run_id: &str) -> Result<PublicationReview, String> {
    let job = directory(job)?;
    uuid::Uuid::parse_str(run_id).map_err(|_| "作業IDが不正です")?;
    if job.join("publication-intent.json").exists() {
        return Err(UNCERTAIN.into());
    }
    let result: DevelopmentResult =
        serde_json::from_slice(&read_file(&job.join("result.json"), MAX_OUTPUT as u64)?).map_err(
            |_| "この結果には公開に必要な記録がありません。成果物を手動で確認してください",
        )?;
    let source: Source =
        serde_json::from_slice(&read_file(&job.join("source.json"), MAX_OUTPUT as u64)?)
            .map_err(|_| "元のリポジトリ記録がありません")?;
    let artifact = directory(&job.join("review-artifact"))?;
    if Path::new(&result.worktree_path) != artifact
        || result.base_commit != source.base_commit
        || result.base_branch != source.base_branch
        || result.branch != source.branch
        || result.branch != format!("yorishiro/{run_id}")
        || !result.ready_for_review
        || result.checks.is_empty()
        || result.checks.len() > 3
        || result
            .checks
            .iter()
            .any(|check| check.exit_code != 0 || check.command.len() > 1000)
    {
        return Err("検証済みの固定成果物と作業記録が一致しません。再検証するか成果物を手動で確認してください".into());
    }
    let source_root = directory(&source.root)?;
    super::policy::claude_preflight(Some(&source_root))?;
    super::policy::codex_restrictions(&source_root)?;
    let repository = github_repository(&source.origin_url)?;
    if github_repository(&result.origin_url)? != repository {
        return Err("公開先の記録が一致しません".into());
    }
    checked_branch(&source.base_branch)?;
    let base = Oid::from_str(&source.base_commit).map_err(|_| "元のコミットIDが不正です")?;
    let verified =
        Oid::from_str(&result.verified_tree).map_err(|_| "検証済みツリーIDが不正です")?;
    let diagnostic = directory(&job.join("repository"))?;
    let git_dir = directory(&diagnostic.join(".git"))?;
    if git_dir.join("commondir").exists() || git_dir.join("objects/info/alternates").exists() {
        return Err("独立した元履歴が保存されていません".into());
    }
    let preparation_id = uuid::Uuid::new_v4().to_string();
    let staging = job.join(format!("publication-{preparation_id}"));
    fs::create_dir(&staging).map_err(|_| "公開の確認用フォルダを作れません")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))
            .map_err(|_| "公開用フォルダを保護できません")?;
    }
    let repo = RepoBuilder::new()
        .bare(true)
        .clone_local(CloneLocal::None)
        .remote_create(super::development::local_remote)
        .clone(
            diagnostic.to_str().ok_or("元履歴のパスが不正です")?,
            &staging.join("git"),
        )
        .map_err(|_| "公開用の独立したGit履歴を作れません")?;
    // No worker-written worktree/config enters any executable transport.
    fs::write(
        repo.path().join("config"),
        "[core]\nrepositoryformatversion=0\nbare=true\nhooksPath=/dev/null\n",
    )
    .map_err(|_| "公開用Git設定を固定できません")?;
    let actual = artifact_tree(&repo, &artifact)?;
    if actual != verified {
        return Err("検証後に成果物が変更されています。新しい確認が必要です".into());
    }
    let (diff, changed_paths) = diff(&repo, base, actual)?;
    if changed_paths.iter().cloned().collect::<BTreeSet<_>>()
        != result.changed_paths.iter().cloned().collect()
    {
        return Err("変更ファイルの記録が一致しません".into());
    }
    let title = "Apply reviewed autonomous changes".to_owned();
    if result.summary.len() > 16000 {
        return Err("作業の説明が長すぎます".into());
    }
    let mut body = format!(
        "{}\n\nValidation in the isolated workspace:\n",
        result.summary
    );
    for check in &result.checks {
        body.push_str(&format!(
            "- `{}` — exit {}\n",
            check.command.replace('`', "'"),
            check.exit_code
        ));
    }
    body.push_str("\nThis draft pull request contains the exact artifact explicitly reviewed and approved in Yorishiro. Yorishiro does not issue merge or deployment commands. This pull request is a draft for review.\n");
    let head_branch = format!("yorishiro/{run_id}-{}", &preparation_id[..8]);
    checked_branch(&head_branch)?;
    let parent = repo
        .find_commit(base)
        .map_err(|_| "元のコミットがありません")?;
    let tree = repo
        .find_tree(actual)
        .map_err(|_| "成果物ツリーがありません")?;
    let signature = git2::Signature::now("Yorishiro Autonomy", "autonomy@users.noreply.github.com")
        .map_err(|_| "公開コミットを作れません")?;
    let commit = repo
        .commit(
            Some(&format!("refs/heads/{head_branch}")),
            &signature,
            &signature,
            &title,
            &tree,
            &[&parent],
        )
        .map_err(|_| "公開コミットを作れません")?;
    let mut review = PublicationReview {
        preparation_id,
        artifact_path: artifact.to_string_lossy().into_owned(),
        repository,
        base_branch: source.base_branch,
        base_commit: base.to_string(),
        head_branch,
        commit: commit.to_string(),
        artifact_tree: actual.to_string(),
        title,
        body,
        diff,
        changed_paths,
        checks: result.checks,
        source_root: source_root.to_string_lossy().into_owned(),
        payload_digest: String::new(),
    };
    review.payload_digest = digest(&review)?;
    private_file(&staging.join("body.md"), review.body.as_bytes())?;
    private_file(
        &staging.join("review.json"),
        &serde_json::to_vec(&review).map_err(|_| "確認内容を保存できません")?,
    )?;
    Ok(review)
}

fn revalidate(job: &Path, review: &PublicationReview) -> Result<PathBuf, String> {
    let job = directory(job)?;
    uuid::Uuid::parse_str(&review.preparation_id).map_err(|_| "承認IDが不正です")?;
    if digest(review)? != review.payload_digest {
        return Err("承認内容が変更されています。確認し直してください".into());
    }
    let staging = directory(&job.join(format!("publication-{}", review.preparation_id)))?;
    let saved: PublicationReview =
        serde_json::from_slice(&read_file(&staging.join("review.json"), MAX_OUTPUT as u64)?)
            .map_err(|_| "保存した承認内容を確認できません")?;
    if saved.payload_digest != review.payload_digest
        || digest(&saved)? != review.payload_digest
        || read_file(&staging.join("body.md"), MAX_OUTPUT as u64)? != review.body.as_bytes()
    {
        return Err("保存した承認内容が一致しません".into());
    }
    if Path::new(&review.artifact_path) != job.join("review-artifact") {
        return Err("成果物の保存先が一致しません".into());
    }
    let git = directory(&staging.join("git"))?;
    if read_file(&git.join("config"), 4096)?
        != b"[core]\nrepositoryformatversion=0\nbare=true\nhooksPath=/dev/null\n"
        || git.join("commondir").exists()
        || git.join("objects/info/alternates").exists()
    {
        return Err("公開用Git設定が変更されています".into());
    }
    let repo = Repository::open_bare(git).map_err(|_| "公開用履歴を開けません")?;
    let verified = Oid::from_str(&review.artifact_tree).map_err(|_| "成果物IDが不正です")?;
    if artifact_tree(&repo, Path::new(&review.artifact_path))? != verified {
        return Err("確認後に成果物が変更されています".into());
    }
    let commit_oid = Oid::from_str(&review.commit).map_err(|_| "公開コミットIDが不正です")?;
    let commit = repo
        .find_commit(commit_oid)
        .map_err(|_| "公開コミットがありません")?;
    if commit.tree_id() != verified
        || commit.parent_count() != 1
        || commit
            .parent_id(0)
            .map_err(|_| "公開履歴が不正です")?
            .to_string()
            != review.base_commit
        || commit.message() != Some(&review.title)
    {
        return Err("公開内容と承認内容が一致しません".into());
    }
    let odb = repo.odb().map_err(|_| "公開コミットを確認できません")?;
    let object = odb
        .read(commit_oid)
        .map_err(|_| "公開コミットを確認できません")?;
    if Oid::hash_object(ObjectType::Commit, object.data())
        .map_err(|_| "公開コミットを確認できません")?
        != commit_oid
    {
        return Err("公開コミットのハッシュが一致しません".into());
    }
    let (patch, paths) = diff(
        &repo,
        Oid::from_str(&review.base_commit).map_err(|_| "元コミットIDが不正です")?,
        verified,
    )?;
    if patch != review.diff || paths != review.changed_paths {
        return Err("確認した差分が変更されています".into());
    }
    if github_repository(&format!("https://github.com/{}", review.repository))? != review.repository
    {
        return Err("公開先が不正です".into());
    }
    checked_branch(&review.base_branch)?;
    checked_branch(&review.head_branch)?;
    Ok(staging)
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Operation {
    Policy,
    Auth,
    Ancestry,
    Push,
    PullRequest,
}
struct Request {
    operation: Operation,
    args: Vec<String>,
    cwd: PathBuf,
    token: Option<String>,
}
trait Transport: Sync {
    fn executable(&self, name: &str) -> String {
        name.to_owned()
    }
    fn run(
        &self,
        request: Request,
        cancel: CancellationToken,
    ) -> impl std::future::Future<Output = Result<Vec<u8>, String>> + Send;
}
struct Native {
    git: PathBuf,
    gh: PathBuf,
    codex: PathBuf,
    home: PathBuf,
    private: PathBuf,
}
impl Native {
    fn new(private: PathBuf) -> Result<Self, String> {
        let resolve = |name| {
            crate::resolve_command_path_impl(name)
                .map(PathBuf::from)
                .ok_or_else(|| format!("公開には{name} CLIのインストールが必要です"))
        };
        Ok(Self {
            git: resolve("git")?,
            gh: resolve("gh")?,
            codex: resolve("codex")?,
            home: dirs::home_dir().ok_or("ホームフォルダを確認できません")?,
            private,
        })
    }
}
impl Transport for Native {
    fn executable(&self, name: &str) -> String {
        (if name == "git" { &self.git } else { &self.gh })
            .to_string_lossy()
            .into_owned()
    }
    async fn run(&self, request: Request, cancel: CancellationToken) -> Result<Vec<u8>, String> {
        let binary = match request.operation {
            Operation::Policy => &self.codex,
            Operation::Push => &self.git,
            _ => &self.gh,
        };
        let mut command = Command::new(binary);
        command
            .env_clear()
            .env(
                "PATH",
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            )
            .env("HOME", &self.home)
            .env("LANG", "en_US.UTF-8")
            .env("CODEX_HOME", &self.private)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GH_PROMPT_DISABLED", "1")
            .env("GH_NO_UPDATE_NOTIFIER", "1")
            .env("GH_HOST", "github.com")
            .current_dir(&request.cwd)
            .args(&request.args);
        if request.operation == Operation::Auth {
            // Authentication lookup only. Never pass arbitrary Git/GH execution settings.
            for name in [
                "GH_CONFIG_DIR",
                "XDG_CONFIG_HOME",
                "GH_TOKEN",
                "GITHUB_TOKEN",
            ] {
                if let Some(value) = std::env::var_os(name) {
                    command.env(name, value);
                }
            }
        } else {
            command.env("GH_CONFIG_DIR", &self.private);
        }
        if let Some(token) = request.token {
            if request.operation == Operation::Push {
                command
                    .env("GIT_CONFIG_COUNT", "1")
                    .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraHeader")
                    .env(
                        "GIT_CONFIG_VALUE_0",
                        format!(
                            "AUTHORIZATION: basic {}",
                            base64::engine::general_purpose::STANDARD
                                .encode(format!("x-access-token:{token}"))
                        ),
                    );
            } else {
                command.env("GH_TOKEN", token);
            }
        }
        capture(command, cancel).await
    }
}
async fn bounded<R: AsyncRead + Unpin>(mut reader: R) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let mut chunk = [0; 8192];
    loop {
        let size = reader
            .read(&mut chunk)
            .await
            .map_err(|_| "公開プロセスの出力を読めません")?;
        if size == 0 {
            return Ok(bytes);
        }
        if bytes.len() + size > MAX_OUTPUT {
            return Err("公開プロセスの出力が上限を超えました".into());
        }
        bytes.extend_from_slice(&chunk[..size]);
    }
}
async fn capture(mut command: Command, cancel: CancellationToken) -> Result<Vec<u8>, String> {
    if cancel.is_cancelled() {
        return Err("公開を停止しました".into());
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut supervisor = super::process_supervisor::Supervisor::prepare(&mut command)?;
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(_) => {
            supervisor.finish().await;
            return Err("公開プロセスを開始できません".into());
        }
    };
    if let Some(pid) = child.id() {
        supervisor.attach(pid)
    }
    let result = if let (Some(stdout), Some(stderr)) = (child.stdout.take(), child.stderr.take()) {
        let work = async {
            let (status, output, _) = tokio::try_join!(
                async {
                    child
                        .wait()
                        .await
                        .map_err(|_| "公開プロセスを待機できません".to_owned())
                },
                bounded(stdout),
                bounded(stderr)
            )?;
            if !status.success() {
                return Err(
                    "公開コマンドに失敗しました。認証・権限・GitHub側の状態を確認してください"
                        .into(),
                );
            }
            Ok(output)
        };
        tokio::select! {biased;_=cancel.cancelled()=>Err("公開を停止しました".into()),_=tokio::time::sleep(Duration::from_secs(120))=>Err("公開処理が制限時間を超えました".into()),result=work=>result}
    } else {
        Err("公開プロセスの出力を準備できません".into())
    };
    let _ = child.start_kill();
    supervisor.finish().await;
    let _ = child.wait().await;
    result
}
fn encode_segment(text: &str) -> String {
    text.bytes()
        .map(|byte| {
            if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
                (byte as char).to_string()
            } else {
                format!("%{byte:02X}")
            }
        })
        .collect()
}
fn ancestry_proven(bytes: &[u8], base: &str) -> Result<(), String> {
    let value: Value = serde_json::from_slice(bytes).map_err(|_| "公開先の履歴を確認できません")?;
    if !matches!(
        value.get("status").and_then(Value::as_str),
        Some("ahead" | "identical")
    ) || value
        .pointer("/merge_base_commit/sha")
        .and_then(Value::as_str)
        != Some(base)
    {
        return Err("承認した元コミットが公開先のベース履歴に含まれていません。最新のベースから作業を確認し直してください".into());
    }
    Ok(())
}
fn policy_decision(bytes: &[u8], explicit_outbound: bool) -> Result<(), String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "既存の実行制限を検証できません")?;
    match value.get("decision").and_then(Value::as_str) {
        Some("prompt") if explicit_outbound => Ok(()),
        None if value
            .get("matchedRules")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty) =>
        {
            Ok(())
        }
        Some("prompt" | "forbidden") => {
            Err("既存の実行制限で公開処理が禁止されています。設定を確認してください".into())
        }
        _ => Err("既存の実行制限を検証できません".into()),
    }
}
fn push_args(review: &PublicationReview) -> Vec<String> {
    [
        "-c".into(),
        "core.hooksPath=/dev/null".into(),
        "-c".into(),
        "credential.helper=".into(),
        "-c".into(),
        "http.followRedirects=false".into(),
        "-c".into(),
        "protocol.allow=never".into(),
        "-c".into(),
        "protocol.https.allow=always".into(),
        "push".into(),
        "--porcelain".into(),
        format!("--force-with-lease=refs/heads/{}:", review.head_branch),
        format!("https://github.com/{}.git", review.repository),
        format!("{}:refs/heads/{}", review.commit, review.head_branch),
    ]
    .into()
}
fn pr_args(review: &PublicationReview, staging: &Path) -> Vec<String> {
    vec![
        "pr".into(),
        "create".into(),
        "--repo".into(),
        review.repository.clone(),
        "--base".into(),
        review.base_branch.clone(),
        "--head".into(),
        review.head_branch.clone(),
        "--title".into(),
        review.title.clone(),
        "--body-file".into(),
        staging.join("body.md").to_string_lossy().into_owned(),
        "--draft".into(),
    ]
}
pub async fn publish(
    job: &Path,
    review: &PublicationReview,
    cancel: CancellationToken,
) -> Result<String, PublicationError> {
    let staging = revalidate(job, review).map_err(PublicationError::NotStarted)?;
    super::development::check_managed_config().map_err(PublicationError::NotStarted)?;
    super::policy::claude_preflight(Some(Path::new(&review.source_root)))
        .map_err(PublicationError::NotStarted)?;
    let rules = super::policy::codex_restrictions(Path::new(&review.source_root))
        .map_err(PublicationError::NotStarted)?;
    let private = tempfile::tempdir_in(&staging)
        .map_err(|_| PublicationError::NotStarted("公開用の一時設定を作れません".into()))?;
    let rule_path =
        super::policy::write_rules(private.path(), &rules).map_err(PublicationError::NotStarted)?;
    let native = Native::new(private.path().to_owned()).map_err(PublicationError::NotStarted)?;
    publish_with(job, review, &staging, &rule_path, &native, cancel).await
}
async fn publish_with<T: Transport>(
    job: &Path,
    review: &PublicationReview,
    staging: &Path,
    rules: &Path,
    transport: &T,
    cancel: CancellationToken,
) -> Result<String, PublicationError> {
    use PublicationError::{NotStarted, Unknown};
    if job.join("publication-intent.json").exists() {
        return Err(Unknown(UNCERTAIN.into()));
    }
    revalidate(job, review).map_err(NotStarted)?;
    let push = push_args(review);
    let pr = pr_args(review, staging);
    let auth = vec![
        "auth".into(),
        "token".into(),
        "--hostname".into(),
        "github.com".into(),
    ];
    let compare = vec![
        "api".into(),
        "--hostname".into(),
        "github.com".into(),
        "--method".into(),
        "GET".into(),
        format!(
            "repos/{}/compare/{}...{}",
            review.repository,
            review.base_commit,
            encode_segment(&review.base_branch)
        ),
    ];
    for (program, args, outbound) in [
        ("gh", &auth, false),
        ("gh", &compare, false),
        ("git", &push, true),
        ("gh", &pr, true),
    ] {
        let mut variants = vec![(program.to_owned(), args.clone())];
        let executable = transport.executable(program);
        if executable != program {
            variants.push((executable, args.clone()));
        }
        if program == "git" {
            variants.push((program.to_owned(), args[10..].to_vec()));
        }
        for (program, argv) in variants {
            let mut check = vec![
                "execpolicy".into(),
                "check".into(),
                "--rules".into(),
                rules.to_string_lossy().into_owned(),
                "--".into(),
                program,
            ];
            check.extend(argv);
            let output = transport
                .run(
                    Request {
                        operation: Operation::Policy,
                        args: check,
                        cwd: staging.to_owned(),
                        token: None,
                    },
                    cancel.clone(),
                )
                .await
                .map_err(NotStarted)?;
            policy_decision(&output, outbound).map_err(NotStarted)?;
        }
    }
    let token = transport
        .run(
            Request {
                operation: Operation::Auth,
                args: auth,
                cwd: staging.to_owned(),
                token: None,
            },
            cancel.clone(),
        )
        .await
        .map_err(NotStarted)?;
    let token = String::from_utf8(token)
        .map_err(|_| NotStarted("GitHubの認証を確認できません".into()))?
        .trim()
        .to_owned();
    if token.is_empty() || token.len() > 8192 || token.chars().any(char::is_whitespace) {
        return Err(NotStarted("GitHubの認証を確認できません".into()));
    }
    let ancestry = transport
        .run(
            Request {
                operation: Operation::Ancestry,
                args: compare,
                cwd: staging.to_owned(),
                token: Some(token.clone()),
            },
            cancel.clone(),
        )
        .await
        .map_err(NotStarted)?;
    ancestry_proven(&ancestry, &review.base_commit).map_err(NotStarted)?;
    // Recheck after read-only network calls, before crossing the durable mutation boundary.
    revalidate(job, review).map_err(NotStarted)?;
    if cancel.is_cancelled() {
        return Err(NotStarted("公開を停止しました".into()));
    }
    private_file(&job.join("publication-intent.json"),&serde_json::to_vec(&json!({"payloadDigest":review.payload_digest,"repository":review.repository,"baseBranch":review.base_branch,"headBranch":review.head_branch,"commit":review.commit})).map_err(|_|NotStarted("公開記録を作れません".into()))?).map_err(NotStarted)?;
    transport
        .run(
            Request {
                operation: Operation::Push,
                args: push,
                cwd: staging.join("git"),
                token: Some(token.clone()),
            },
            cancel.clone(),
        )
        .await
        .map_err(|_| Unknown(UNCERTAIN.into()))?;
    let output = transport
        .run(
            Request {
                operation: Operation::PullRequest,
                args: pr,
                cwd: staging.to_owned(),
                token: Some(token),
            },
            cancel,
        )
        .await
        .map_err(|_| Unknown(UNCERTAIN.into()))?;
    let url = String::from_utf8(output)
        .map_err(|_| Unknown(UNCERTAIN.into()))?
        .trim()
        .to_owned();
    let prefix = format!("https://github.com/{}/pull/", review.repository);
    if !url
        .strip_prefix(&prefix)
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err(Unknown(UNCERTAIN.into()));
    }
    private_file(
        &job.join("publication-result.json"),
        &serde_json::to_vec(&json!({"payloadDigest":review.payload_digest,"pullRequestUrl":url}))
            .map_err(|_| Unknown(UNCERTAIN.into()))?,
    )
    .map_err(|_| Unknown(UNCERTAIN.into()))?;
    Ok(url)
}

#[cfg(test)]
#[path = "publishing_audit_tests.rs"]
mod audit_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    struct Mock {
        job: PathBuf,
        base: String,
        calls: Mutex<Vec<(Operation, Vec<String>)>>,
        fail: Option<Operation>,
        forbidden: bool,
        deny_canonical_git_push: bool,
        diverged: bool,
    }
    impl Transport for Mock {
        async fn run(&self, request: Request, _: CancellationToken) -> Result<Vec<u8>, String> {
            self.calls
                .lock()
                .unwrap()
                .push((request.operation, request.args.clone()));
            if matches!(request.operation, Operation::Push | Operation::PullRequest) {
                assert!(self.job.join("publication-intent.json").is_file());
                assert_eq!(request.token.as_deref(), Some("fixture-auth-token"));
            } else {
                assert!(!self.job.join("publication-intent.json").exists());
            }
            if self.fail == Some(request.operation) {
                return Err("transport result intentionally lost".into());
            }
            Ok(match request.operation {
                Operation::Policy=>if self.forbidden || (self.deny_canonical_git_push && request.args.windows(2).any(|pair| pair == ["git", "push"])) {br#"{"decision":"forbidden","matchedRules":[{}]}"#.to_vec()} else {br#"{"decision":"prompt","matchedRules":[{}]}"#.to_vec()},
                Operation::Auth=>b"fixture-auth-token\n".to_vec(),
                Operation::Ancestry=>serde_json::to_vec(&json!({"status":if self.diverged {"diverged"}else{"ahead"},"merge_base_commit":{"sha":self.base}})).unwrap(),
                Operation::Push=>b"created branch\n".to_vec(),
                Operation::PullRequest=>b"https://github.com/example/review-fixture/pull/17\n".to_vec(),
            })
        }
    }
    // Only outbound mutations have explicit card approval. Read-only commands
    // use unmatched policy output, preserving distinct native prompt boundaries.
    struct Approved(Mock);
    impl Transport for Approved {
        async fn run(
            &self,
            request: Request,
            cancel: CancellationToken,
        ) -> Result<Vec<u8>, String> {
            if request.operation == Operation::Policy
                && !self.0.forbidden
                && !request
                    .args
                    .iter()
                    .any(|arg| arg == "push" || arg == "create")
            {
                self.0
                    .calls
                    .lock()
                    .unwrap()
                    .push((request.operation, request.args));
                return Ok(br#"{"matchedRules":[]}"#.to_vec());
            }
            self.0.run(request, cancel).await
        }
    }
    fn mock(job: &Path, review: &PublicationReview, fail: Option<Operation>) -> Approved {
        Approved(Mock {
            job: job.to_owned(),
            base: review.base_commit.clone(),
            calls: Mutex::new(vec![]),
            fail,
            forbidden: false,
            deny_canonical_git_push: false,
            diverged: false,
        })
    }
    #[tokio::test]
    async fn exact_approved_payload_is_sent_once_after_durable_intent() {
        let fixture = audit_tests::fixture("note.md", b"before\n", b"after\n");
        let review = prepare(&fixture.job, &fixture.run_id).unwrap();
        let staging = revalidate(&fixture.job, &review).unwrap();
        let transport = mock(&fixture.job, &review, None);
        let url = publish_with(
            &fixture.job,
            &review,
            &staging,
            Path::new("/fixture.rules"),
            &transport,
            CancellationToken::new(),
        )
        .await
        .unwrap();
        assert_eq!(url, "https://github.com/example/review-fixture/pull/17");
        let calls = transport.0.calls.lock().unwrap().clone();
        let push = &calls
            .iter()
            .find(|(op, _)| *op == Operation::Push)
            .unwrap()
            .1;
        assert_eq!(push, &push_args(&review));
        assert!(push.contains(&format!(
            "--force-with-lease=refs/heads/{}:",
            review.head_branch
        )));
        let pr = &calls
            .iter()
            .find(|(op, _)| *op == Operation::PullRequest)
            .unwrap()
            .1;
        assert_eq!(pr, &pr_args(&review, &staging));
        assert_eq!(
            read_file(&staging.join("body.md"), 100_000).unwrap(),
            review.body.as_bytes()
        );
        let prior = calls.len();
        assert!(matches!(
            publish_with(
                &fixture.job,
                &review,
                &staging,
                Path::new("/fixture.rules"),
                &transport,
                CancellationToken::new()
            )
            .await,
            Err(PublicationError::Unknown(_))
        ));
        assert_eq!(transport.0.calls.lock().unwrap().len(), prior);
    }
    #[tokio::test]
    async fn unknown_push_or_pr_never_retries() {
        for operation in [Operation::Push, Operation::PullRequest] {
            let fixture = audit_tests::fixture("note.md", b"before\n", b"after\n");
            let review = prepare(&fixture.job, &fixture.run_id).unwrap();
            let staging = revalidate(&fixture.job, &review).unwrap();
            let transport = mock(&fixture.job, &review, Some(operation));
            assert!(matches!(
                publish_with(
                    &fixture.job,
                    &review,
                    &staging,
                    Path::new("/fixture.rules"),
                    &transport,
                    CancellationToken::new()
                )
                .await,
                Err(PublicationError::Unknown(_))
            ));
            let count = transport.0.calls.lock().unwrap().len();
            assert!(prepare(&fixture.job, &fixture.run_id).is_err());
            assert!(matches!(
                publish_with(
                    &fixture.job,
                    &review,
                    &staging,
                    Path::new("/fixture.rules"),
                    &transport,
                    CancellationToken::new()
                )
                .await,
                Err(PublicationError::Unknown(_))
            ));
            assert_eq!(transport.0.calls.lock().unwrap().len(), count);
        }
    }
    #[tokio::test]
    async fn native_denial_unproven_ancestry_and_tampering_stop_before_mutation() {
        for mode in ["forbidden", "ancestry", "tampered"] {
            let fixture = audit_tests::fixture("note.md", b"before\n", b"after\n");
            let review = prepare(&fixture.job, &fixture.run_id).unwrap();
            let staging = revalidate(&fixture.job, &review).unwrap();
            let mut transport = mock(&fixture.job, &review, None);
            match mode {
                "forbidden" => transport.0.forbidden = true,
                "ancestry" => transport.0.diverged = true,
                _ => fs::write(fixture.job.join("review-artifact/note.md"), "unreviewed").unwrap(),
            }
            assert!(matches!(
                publish_with(
                    &fixture.job,
                    &review,
                    &staging,
                    Path::new("/fixture.rules"),
                    &transport,
                    CancellationToken::new()
                )
                .await,
                Err(PublicationError::NotStarted(_))
            ));
            assert!(!fixture.job.join("publication-intent.json").exists());
            assert!(!transport
                .0
                .calls
                .lock()
                .unwrap()
                .iter()
                .any(|(op, _)| matches!(op, Operation::Push | Operation::PullRequest)));
        }
    }
    #[tokio::test]
    async fn git_configuration_prefix_does_not_bypass_git_push_denial() {
        let fixture = audit_tests::fixture("note.md", b"before\n", b"after\n");
        let review = prepare(&fixture.job, &fixture.run_id).unwrap();
        let staging = revalidate(&fixture.job, &review).unwrap();
        let mut transport = mock(&fixture.job, &review, None);
        transport.0.deny_canonical_git_push = true;
        assert!(matches!(
            publish_with(
                &fixture.job,
                &review,
                &staging,
                Path::new("/fixture.rules"),
                &transport,
                CancellationToken::new()
            )
            .await,
            Err(PublicationError::NotStarted(_))
        ));
        let calls = transport.0.calls.lock().unwrap();
        assert!(calls
            .iter()
            .any(|(operation, args)| *operation == Operation::Policy
                && args.windows(2).any(|pair| pair == ["git", "push"])));
        assert!(calls
            .iter()
            .all(|(operation, _)| *operation == Operation::Policy));
        assert!(!fixture.job.join("publication-intent.json").exists());
    }

    #[test]
    fn native_prompt_is_only_satisfied_for_explicit_outbound_card() {
        let prompt = br#"{"decision":"prompt","matchedRules":[{}]}"#;
        assert!(policy_decision(prompt, true).is_ok());
        assert!(policy_decision(prompt, false).is_err());
        assert!(policy_decision(br#"{"decision":"forbidden","matchedRules":[{}]}"#, true).is_err());
        assert!(policy_decision(br#"{}"#, true).is_err());
    }
}
