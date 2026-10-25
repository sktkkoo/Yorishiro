//! Host-owned publication of an explicitly delegated GitHub draft PR.
//!
//! The model has no credentials or network permission. Publication uses the
//! repository identity captured at save time, host-executed check receipts, an
//! independent clone, and a durable no-retry marker before any remote mutation.

use super::development::DevelopmentResult;
use base64::Engine;
use git2::{DiffOptions, Repository};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

const MAX_OUTPUT: u64 = 1024 * 1024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
const UNCERTAIN: &str = "GitHubへの公開結果を確認できません。ブランチやPRが作成された可能性があります。自動で再送せず、GitHubを確認してください。";

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

fn open_root(root: &Path) -> Result<Repository, String> {
    let root = fs::canonicalize(root).map_err(|_| "リポジトリを確認できません")?;
    let repo = Repository::open(&root).map_err(|_| "対象フォルダはGitリポジトリではありません")?;
    if repo.is_bare()
        || repo
            .workdir()
            .and_then(|p| fs::canonicalize(p).ok())
            .as_ref()
            != Some(&root)
    {
        return Err("Gitリポジトリのルートフォルダを指定してください".into());
    }
    Ok(repo)
}

pub fn capture_scope(root: &Path) -> Result<RepositoryScope, String> {
    let repo = open_root(root)?;
    let remote = repo
        .find_remote("origin")
        .map_err(|_| "originが設定されていません")?;
    let github_repo = github_repository(remote.url().ok_or("originのURLを取得できません")?)?;
    let head = repo.head().map_err(|_| "現在のブランチを取得できません")?;
    if !head.is_branch() {
        return Err("ブランチを選んでから開発作業を任せてください".into());
    }
    let base_branch = head
        .shorthand()
        .ok_or("ブランチ名を取得できません")?
        .to_owned();
    checked_branch(&base_branch)?;
    Ok(RepositoryScope {
        remote_url: format!("https://github.com/{github_repo}.git"),
        github_repo,
        base_branch,
    })
}

pub fn validate_scope(root: &Path, scope: &RepositoryScope) -> Result<(), String> {
    if &capture_scope(root)? != scope {
        return Err(
            "リポジトリまたはベースブランチが設定時から変わりました。範囲を設定し直してください"
                .into(),
        );
    }
    Ok(())
}

fn validate_publication(scope: &RepositoryScope, result: &DevelopmentResult) -> Result<(), String> {
    if github_repository(&scope.remote_url)? != scope.github_repo
        || github_repository(&result.origin_url)? != scope.github_repo
        || scope.remote_url != format!("https://github.com/{}.git", scope.github_repo)
        || result.base_branch != scope.base_branch
    {
        return Err("公開先が保存済みのリポジトリと一致しません".into());
    }
    checked_branch(&scope.base_branch)?;
    let suffix = result
        .branch
        .strip_prefix("yorishiro/")
        .ok_or("開発ブランチが不正です")?;
    if uuid::Uuid::parse_str(suffix).is_err()
        || !result.ready_for_review
        || result.checks.is_empty()
        || result.checks.iter().any(|check| check.exit_code != 0)
    {
        return Err("検証が完了していない変更は自動でPRにできません".into());
    }
    Ok(())
}

fn allowed_path(path: &str) -> bool {
    if path.is_empty() || path.len() > 4096 || path.chars().any(char::is_control) {
        return false;
    }
    Path::new(path).components().all(|component| {
        let Component::Normal(name) = component else {
            return false;
        };
        let name = name.to_string_lossy().to_ascii_lowercase();
        !name.starts_with('.')
            && !matches!(
                name.as_str(),
                "agents.md" | "claude.md" | "id_rsa" | "id_ed25519"
            )
            && !name.ends_with(".pem")
            && !name.ends_with(".key")
            && !name.ends_with(".p12")
            && !name.ends_with(".pfx")
    })
}

fn changed_files(
    repo: &Repository,
    result: &DevelopmentResult,
) -> Result<BTreeSet<String>, String> {
    let base = git2::Oid::from_str(&result.base_commit).map_err(|_| "開始コミットが不正です")?;
    let head = repo.head().map_err(|_| "開発ブランチを取得できません")?;
    if head.shorthand() != Some(result.branch.as_str()) || head.target() != Some(base) {
        return Err("開発中にGit履歴が変更されたため公開を停止しました".into());
    }
    let tree = repo
        .find_commit(base)
        .and_then(|commit| commit.tree())
        .map_err(|_| "開始コミットを取得できません")?;
    let mut options = DiffOptions::new();
    options.include_untracked(true).recurse_untracked_dirs(true);
    let diff = repo
        .diff_tree_to_workdir_with_index(Some(&tree), Some(&mut options))
        .map_err(|_| "変更差分を確認できません")?;
    let root = repo.workdir().ok_or("作業フォルダがありません")?;
    let mut paths = BTreeSet::new();
    let mut size = 0u64;
    for delta in diff.deltas() {
        for file in [delta.old_file(), delta.new_file()] {
            let Some(path) = file.path() else { continue };
            let path = path
                .to_str()
                .ok_or("UTF-8以外のファイル名は自動公開できません")?;
            if !allowed_path(path)
                || file.mode() == git2::FileMode::Link
                || file.mode() == git2::FileMode::Commit
            {
                return Err(
                    "設定・認証・ワークフロー・シンボリックリンクの変更は自動公開できません".into(),
                );
            }
            if paths.insert(path.to_owned()) {
                let destination = root.join(path);
                // Check every ancestor, including removed files' remaining parents.
                let mut current = root.to_path_buf();
                for component in Path::new(path).components() {
                    current.push(component);
                    match fs::symlink_metadata(&current) {
                        Ok(metadata) if metadata.file_type().is_symlink() => {
                            return Err("シンボリックリンクは自動公開できません".into())
                        }
                        Ok(_) => {}
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
                        Err(_) => return Err("変更ファイルを検査できません".into()),
                    }
                }
                match fs::metadata(&destination) {
                    Ok(metadata) => {
                        if !metadata.is_file() || metadata.len() > 1024 * 1024 {
                            return Err("通常の小さなソースファイルだけを自動公開できます".into());
                        }
                        size = size.saturating_add(metadata.len());
                        let bytes =
                            fs::read(destination).map_err(|_| "変更ファイルを検査できません")?;
                        if bytes.contains(&0) {
                            return Err("バイナリファイルの変更は自動公開できません".into());
                        }
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(_) => return Err("変更ファイルを検査できません".into()),
                }
            }
        }
    }
    if paths.is_empty() || paths.len() > 200 || size > 5 * 1024 * 1024 {
        return Err("自動公開できる変更量を超えたか、変更がありません".into());
    }
    if paths != result.changed_paths.iter().cloned().collect() {
        return Err("検証後に変更ファイルの一覧が変わりました。公開を停止しました".into());
    }
    Ok(paths)
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
        .map_err(|_| "公開記録が既にあるか、保存できません。再送せず状態を確認してください")?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| "公開前の記録を保存できません")?;
    if let Some(parent) = path.parent() {
        fs::File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|_| "公開前の記録を確定できません")?;
    }
    Ok(())
}

fn clean_command(binary: &Path, cwd: &Path) -> Command {
    let mut command = Command::new(binary);
    command
        .current_dir(cwd)
        .env("PATH", crate::build_path_env());
    for (key, _) in std::env::vars_os() {
        let key_name = key.to_string_lossy();
        if key_name.starts_with("GIT_")
            || matches!(
                key_name.as_ref(),
                "BASH_ENV"
                    | "ENV"
                    | "NODE_OPTIONS"
                    | "NODE_PATH"
                    | "SSH_ASKPASS"
                    | "GH_DEBUG"
                    | "GH_FORCE_TTY"
                    | "GH_HOST"
                    | "GH_PROMPT_DISABLED"
            )
        {
            command.env_remove(key);
        }
    }
    command
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_SYSTEM", "/dev/null")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1");
    command
}

async fn captured(mut command: Command, cancel: CancellationToken) -> Result<Vec<u8>, String> {
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
    let mut child = command.spawn().map_err(|_| "公開用のCLIを開始できません")?;
    let pid = child.id();
    let stdout = child.stdout.take().ok_or("公開CLIの出力を読めません")?;
    let stderr = child.stderr.take().ok_or("公開CLIの診断を読めません")?;
    let read = |stream: tokio::process::ChildStdout| async move {
        let mut bytes = Vec::new();
        stream
            .take(MAX_OUTPUT + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "公開CLIの出力を読めません")?;
        if bytes.len() as u64 > MAX_OUTPUT {
            return Err("公開CLIの出力が長すぎます");
        }
        Ok::<_, &str>(bytes)
    };
    let work = async {
        let diagnostics = async {
            let mut bytes = Vec::new();
            stderr
                .take(MAX_OUTPUT + 1)
                .read_to_end(&mut bytes)
                .await
                .map_err(|_| "公開CLIの診断を読めません")?;
            if bytes.len() as u64 > MAX_OUTPUT {
                return Err("公開CLIの診断が長すぎます");
            }
            Ok::<_, &str>(())
        };
        let (status, output, ()) = tokio::try_join!(
            async { child.wait().await.map_err(|_| "公開CLIを待機できません") },
            read(stdout),
            diagnostics
        )?;
        if !status.success() {
            return Err("公開CLIが失敗しました。GitHubの認証と権限を確認してください");
        }
        Ok(output)
    };
    let result = tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("公開を停止しました"),
        _ = tokio::time::sleep(COMMAND_TIMEOUT) => Err("公開処理が時間切れになりました"),
        result = work => result,
    };
    #[cfg(unix)]
    if let Some(pid) = pid {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.start_kill();
    let _ = child.wait().await;
    result.map_err(str::to_owned)
}

fn validate_clone(root: &Path, result: &DevelopmentResult) -> Result<(), String> {
    let repo = open_root(root)?;
    let git_dir = root.join(".git");
    if fs::symlink_metadata(&git_dir)
        .map_err(|_| "開発リポジトリを確認できません")?
        .file_type()
        .is_symlink()
        || !git_dir.is_dir()
        || repo.path().canonicalize().ok() != git_dir.canonicalize().ok()
        || git_dir.join("commondir").exists()
        || git_dir.join("objects/info/alternates").exists()
    {
        return Err("独立した開発用クローンだけを公開できます".into());
    }
    changed_files(&repo, result)?;
    Ok(())
}

fn commit_checked_changes(
    root: &Path,
    result: &DevelopmentResult,
    title: &str,
) -> Result<String, String> {
    let repo = open_root(root)?;
    let paths = changed_files(&repo, result)?;
    let mut index = repo
        .index()
        .map_err(|_| "Gitインデックスを取得できません")?;
    for path in &paths {
        if root.join(path).exists() {
            index
                .add_path(Path::new(path))
                .map_err(|_| "変更を追加できません")?;
        } else {
            index
                .remove_path(Path::new(path))
                .map_err(|_| "削除差分を追加できません")?;
        }
    }
    index
        .write()
        .map_err(|_| "Gitインデックスを保存できません")?;
    let tree_id = index
        .write_tree()
        .map_err(|_| "変更ツリーを作成できません")?;
    if tree_id.to_string() != result.verified_tree {
        return Err("検証後に内容が変わりました。再検証するまで公開できません".into());
    }
    let tree = repo
        .find_tree(tree_id)
        .map_err(|_| "変更ツリーを読み取れません")?;
    let previous = repo
        .find_commit(
            git2::Oid::from_str(&result.base_commit).map_err(|_| "開始コミットが不正です")?,
        )
        .map_err(|_| "開始コミットを読み取れません")?;
    let signature = git2::Signature::now("Yorishiro Autonomy", "autonomy@users.noreply.github.com")
        .map_err(|_| "コミット署名を作成できません")?;
    let commit = repo
        .commit(
            Some("HEAD"),
            &signature,
            &signature,
            title,
            &tree,
            &[&previous],
        )
        .map_err(|_| "開発コミットを作成できません")?;
    Ok(commit.to_string())
}

pub async fn publish(
    scope: &RepositoryScope,
    result: &DevelopmentResult,
    cancel: CancellationToken,
) -> Result<String, String> {
    validate_publication(scope, result)?;
    if cancel.is_cancelled() {
        return Err("公開を停止しました".into());
    }
    let root = PathBuf::from(&result.worktree_path);
    validate_clone(&root, result)?;
    let git_dir = root.join(".git");
    let parent = root.parent().ok_or("開発フォルダが不正です")?;
    let marker = parent.join("publication-intent.json");
    if marker.exists() {
        return Err(UNCERTAIN.into());
    }
    let git = PathBuf::from(crate::resolve_command_path_impl("git").ok_or("Gitが見つかりません")?);
    let gh = PathBuf::from(
        crate::resolve_command_path_impl("gh")
            .ok_or("GitHub CLIをインストールしてログインしてください")?,
    );
    // The worker cannot write .git. Replace the clone's config anyway so a
    // credential helper, include, URL rewrite, hook or external diff cannot run.
    let config = format!("[core]\nrepositoryformatversion = 0\nfilemode = true\nbare = false\nlogallrefupdates = true\nhooksPath = /dev/null\n[remote \"origin\"]\nurl = {}\n", scope.remote_url);
    let config_path = git_dir.join("config");
    if fs::symlink_metadata(&config_path)
        .map_err(|_| "Git設定を確認できません")?
        .file_type()
        .is_symlink()
    {
        return Err("Git設定がシンボリックリンクです".into());
    }
    fs::write(&config_path, config).map_err(|_| "公開用Git設定を作成できません")?;
    let mut whitespace = clean_command(&git, &root);
    whitespace.args([
        "-c",
        "core.hooksPath=/dev/null",
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--check",
        &result.base_commit,
    ]);
    captured(whitespace, cancel.clone()).await?;
    let mut auth = clean_command(&gh, parent);
    auth.args(["auth", "token", "--hostname", "github.com"]);
    let token = captured(auth, cancel.clone()).await?;
    let token = std::str::from_utf8(&token)
        .map_err(|_| "GitHub認証を読み取れません")?
        .trim();
    if token.is_empty() || token.chars().any(char::is_whitespace) {
        return Err("GitHub認証が不正です".into());
    }
    let title = format!(
        "Autonomous improvement: {}",
        result
            .summary
            .lines()
            .next()
            .unwrap_or("Review proposed changes")
            .chars()
            .take(100)
            .collect::<String>()
    );
    let commit = commit_checked_changes(&root, result, &title)?;
    let mut body = format!(
        "{}\n\nValidation performed in the isolated development workspace:\n",
        result.summary
    );
    for check in &result.checks {
        body.push_str(&format!(
            "- `{}` (exit {})\n",
            check.command.replace('`', "'"),
            check.exit_code
        ));
    }
    body.push_str("\nCreated under the user's delegated repository scope. This is a draft for review; it has not been merged or deployed.\n");
    let body_path = parent.join("pull-request-body.md");
    private_file(&body_path, body.as_bytes())?;
    if cancel.is_cancelled() {
        return Err("公開を停止しました".into());
    }
    let intent = serde_json::to_vec(&serde_json::json!({"repository":scope.github_repo,"branch":result.branch,"commit":commit.to_string(),"status":"publication-may-have-started"})).map_err(|_| "公開記録を作成できません")?;
    private_file(&marker, &intent)?;
    let encoded =
        base64::engine::general_purpose::STANDARD.encode(format!("x-access-token:{token}"));
    let mut push = clean_command(&git, &root);
    push.args([
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "push",
        "--porcelain",
        "--",
        &scope.remote_url,
        &format!("HEAD:refs/heads/{}", result.branch),
    ]);
    push.env("GIT_CONFIG_COUNT", "1")
        .env("GIT_CONFIG_KEY_0", "http.https://github.com/.extraHeader")
        .env(
            "GIT_CONFIG_VALUE_0",
            format!("AUTHORIZATION: basic {encoded}"),
        );
    captured(push, cancel.clone())
        .await
        .map_err(|_| UNCERTAIN.to_owned())?;
    let mut pr = clean_command(&gh, parent);
    pr.env("GH_TOKEN", token)
        .args([
            "pr",
            "create",
            "--repo",
            &scope.github_repo,
            "--draft",
            "--base",
            &scope.base_branch,
            "--head",
            &result.branch,
            "--title",
            &title,
            "--body-file",
        ])
        .arg(&body_path);
    let output = captured(pr, cancel)
        .await
        .map_err(|_| UNCERTAIN.to_owned())?;
    let url = std::str::from_utf8(&output).map_err(|_| UNCERTAIN)?.trim();
    let prefix = format!("https://github.com/{}/pull/", scope.github_repo);
    if !url
        .strip_prefix(&prefix)
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err(UNCERTAIN.into());
    }
    // Retain the intent even on success: repeated publication of this run is
    // never automatic. The result receipt supports recovery after app failure.
    private_file(
        &parent.join("publication-result.json"),
        &serde_json::to_vec(&serde_json::json!({"url":url,"commit":commit.to_string()}))
            .map_err(|_| UNCERTAIN)?,
    )
    .map_err(|_| UNCERTAIN.to_owned())?;
    Ok(url.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn github_origin_is_pinned_without_credentials_or_options() {
        for url in [
            "https://github.com/team/project.git",
            "git@github.com:team/project.git",
            "https://github.com/team/project",
        ] {
            assert_eq!(github_repository(url).unwrap(), "team/project");
        }
        for url in [
            "https://user:secret@github.com/team/project",
            "https://github.com.evil/team/project",
            "ssh://git@github.com/team/project",
            "git@evil:team/project",
            "https://github.com/team/project?x=y",
            "https://github.com/team/../project",
            "https://github.com/team/-option",
            "--upload-pack=evil",
        ] {
            assert!(github_repository(url).is_err(), "accepted {url}");
        }
    }

    #[test]
    fn protected_paths_and_path_escape_are_not_auto_published() {
        for path in [
            "src/main.ts",
            "docs/guide.md",
            "package.json",
            "src-tauri/Cargo.toml",
        ] {
            assert!(allowed_path(path));
        }
        for path in [
            "../secret",
            "/etc/passwd",
            ".github/workflows/release.yml",
            "dir/.env",
            "AGENTS.md",
            "dir/CLAUDE.md",
            "keys/server.pem",
            "id_ed25519",
            "a\nb",
        ] {
            assert!(!allowed_path(path), "accepted {path}");
        }
    }

    #[test]
    fn publication_marker_is_durable_and_cannot_be_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("publication-intent.json");
        private_file(&path, b"first attempt").unwrap();
        assert!(private_file(&path, b"second attempt").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"first attempt");
    }

    #[test]
    fn scope_tracks_exact_repository_root_origin_and_branch() {
        let dir = tempfile::tempdir().unwrap();
        let repo = Repository::init(dir.path()).unwrap();
        repo.remote("origin", "git@github.com:team/project.git")
            .unwrap();
        let signature = git2::Signature::now("Test", "test@example.com").unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let tree = repo.find_tree(tree_id).unwrap();
        repo.commit(
            Some("refs/heads/main"),
            &signature,
            &signature,
            "initial",
            &tree,
            &[],
        )
        .unwrap();
        repo.set_head("refs/heads/main").unwrap();
        let scope = capture_scope(dir.path()).unwrap();
        assert_eq!(scope.remote_url, "https://github.com/team/project.git");
        assert_eq!(scope.base_branch, "main");
        validate_scope(dir.path(), &scope).unwrap();
        repo.remote_set_url("origin", "https://github.com/team/other.git")
            .unwrap();
        assert!(validate_scope(dir.path(), &scope).is_err());
        fs::create_dir(dir.path().join("subdir")).unwrap();
        assert!(capture_scope(&dir.path().join("subdir")).is_err());
    }
}
