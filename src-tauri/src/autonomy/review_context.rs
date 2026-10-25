//! Read-only, bounded review evidence from host-owned result metadata and the
//! exported artifact. No checkout, index, command, transport, or publication.
use git2::{ObjectType, Oid, Repository};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::path::{Component, Path, PathBuf};

const MAX_METADATA: usize = 64 * 1024;
const MAX_FILE: usize = 32 * 1024 * 1024;
const MAX_ARTIFACT: usize = 256 * 1024 * 1024;
const MAX_TEXT: usize = 256 * 1024;
const MAX_ENTRIES: usize = 20_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Source {
    root: String,
    base_commit: String,
    base_branch: String,
    branch: String,
    #[serde(default)]
    origin_url: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ResultRecord {
    worktree_path: String,
    base_commit: String,
    base_branch: String,
    branch: String,
    verified_tree: String,
    changed_paths: Vec<String>,
    checks: Vec<super::development::ExecutedCheck>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ReviewContext {
    pub source_root: String,
    artifact_path: String,
    base_commit: String,
    verified_tree: String,
    base_branch: String,
    branch: String,
    // A locator only. Its presence is not a request to publish to it.
    origin: Option<String>,
    pub checks: Vec<super::development::ExecutedCheck>,
    pub changes: Vec<Change>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Change {
    path: String,
    before: Option<String>,
    after: Option<String>,
    before_mode: Option<u32>,
    after_mode: Option<u32>,
}
#[derive(Clone, Copy, PartialEq, Eq)]
struct Entry {
    oid: Oid,
    mode: u32,
}

pub(super) fn saved_source_root(storage: &Path, run_id: &str) -> Result<String, String> {
    if uuid::Uuid::parse_str(run_id).is_err() {
        return Err("作業の識別子が不正です".into());
    }
    let path = storage.join("development").join(run_id).join("source.json");
    let source: Source = serde_json::from_slice(&read_file(&path, MAX_METADATA)?)
        .map_err(|_| "元の作業の記録を読み取れません")?;
    if !Path::new(&source.root).is_absolute()
        || source.root.len() > 8_000
        || source.root.contains('\0')
    {
        return Err("元の作業フォルダの記録が不正です".into());
    }
    Ok(source.root)
}

pub(super) fn load(storage: &Path, run: &super::Run) -> Result<ReviewContext, String> {
    if uuid::Uuid::parse_str(&run.id).is_err() || run.status != "completed" {
        return Err(
            "完了した作業の成果物を指定してください。未完了の結果はAIに相談してください".into(),
        );
    }
    let job = storage.join("development").join(&run.id);
    checked_directory(&job)?;
    let source: Source =
        serde_json::from_slice(&read_file(&job.join("source.json"), MAX_METADATA)?)
            .map_err(|_| "元の作業フォルダの記録を読み取れません")?;
    let result: ResultRecord =
        serde_json::from_slice(&read_file(&job.join("result.json"), MAX_METADATA)?)
            .map_err(|_| "保存された作業結果を読み取れません")?;
    let artifact = job.join("review-artifact");
    if !Path::new(&source.root).is_absolute()
        || source.root.len() > 8_000
        || source.root.contains('\0')
        || run
            .source_root
            .as_ref()
            .is_some_and(|root| root != &source.root)
        || source.base_commit != result.base_commit
        || source.base_branch != result.base_branch
        || source.branch != result.branch
        || result.worktree_path != artifact.to_string_lossy()
        || run.development_path.as_deref() != Some(result.worktree_path.as_str())
        || result.changed_paths != run.changed_paths
        || result.changed_paths.len() > 200
        || result.checks.len() > 10
        || result
            .checks
            .iter()
            .any(|check| check.command.len() > 8_000)
        || source.base_branch.len() > 2_000
        || source.branch.len() > 2_000
    {
        return Err("成果物と元の作業の記録が一致しません。承認内容を作成していません".into());
    }
    checked_directory(&artifact)?;
    let mut files = BTreeMap::new();
    let mut byte_count = 0;
    let mut entry_count = 0;
    let actual_tree = artifact_tree(
        &artifact,
        Path::new(""),
        0,
        &mut files,
        &mut byte_count,
        &mut entry_count,
    )?;
    let verified_tree =
        Oid::from_str(&result.verified_tree).map_err(|_| "検証済み成果物の識別子が不正です")?;
    if actual_tree != verified_tree {
        return Err("保存された成果物が検証時から変わっています。新しい確認が必要です".into());
    }
    let git = job.join("repository/.git");
    checked_directory(&git)?;
    // Opening the exact existing object database does not consult remotes,
    // checkout files, create objects, or mutate the retained clone.
    let repo = Repository::open_bare(&git).map_err(|_| "比較元のGitオブジェクトを開けません")?;
    let base = Oid::from_str(&source.base_commit).map_err(|_| "比較元の識別子が不正です")?;
    let commit = verified_object(&repo, base, ObjectType::Commit, MAX_METADATA)?;
    let first = commit
        .split(|byte| *byte == b'\n')
        .next()
        .ok_or("比較元のコミットが不正です")?;
    let tree = std::str::from_utf8(first)
        .ok()
        .and_then(|line| line.strip_prefix("tree "))
        .and_then(|oid| Oid::from_str(oid).ok())
        .ok_or("比較元のツリーが不正です")?;
    let mut before = BTreeMap::new();
    let mut base_entries = 0;
    base_tree(&repo, tree, "", 0, &mut before, &mut base_entries)?;
    let changed: Vec<String> = files
        .keys()
        .chain(before.keys())
        .cloned()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .filter(|path| files.get(path) != before.get(path))
        .filter(|path| path != ".yorishiro-tmp" && !path.starts_with(".yorishiro-tmp/"))
        .collect();
    if changed != result.changed_paths || changed.is_empty() {
        return Err("保存された変更一覧と成果物の内容が一致しません".into());
    }
    let mut text_bytes = 0;
    let mut changes = Vec::new();
    for path in changed {
        let old = before.get(&path);
        let new = files.get(&path);
        let old_text = old
            .map(|entry| {
                verified_object(&repo, entry.oid, ObjectType::Blob, MAX_TEXT)
                    .and_then(|bytes| checked_text(bytes, &mut text_bytes))
            })
            .transpose()?;
        let new_text = new
            .map(|entry| {
                let bytes = read_file(&artifact.join(&path), MAX_TEXT)?;
                if Oid::hash_object(ObjectType::Blob, &bytes).map_err(|e| e.to_string())?
                    != entry.oid
                {
                    return Err("確認中に成果物が変更されました".into());
                }
                checked_text(bytes, &mut text_bytes)
            })
            .transpose()?;
        changes.push(Change {
            path,
            before: old_text,
            after: new_text,
            before_mode: old.map(|entry| entry.mode),
            after_mode: new.map(|entry| entry.mode),
        });
    }
    Ok(ReviewContext {
        source_root: source.root,
        artifact_path: artifact.to_string_lossy().into_owned(),
        base_commit: source.base_commit,
        verified_tree: result.verified_tree,
        base_branch: source.base_branch,
        branch: source.branch,
        origin: safe_origin(&source.origin_url),
        checks: result.checks,
        changes,
    })
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
    // SCP-style Git locator; never expose any credential-like user component.
    origin
        .strip_prefix("git@")
        .filter(|rest| rest.contains(':') && !rest.contains('@'))
        .map(|rest| format!("git@{rest}"))
}
fn checked_text(bytes: Vec<u8>, total: &mut usize) -> Result<String, String> {
    *total = total
        .checked_add(bytes.len())
        .ok_or("変更内容が大きすぎます")?;
    if *total > MAX_TEXT || bytes.contains(&0) {
        return Err(
            "変更内容が大きすぎるか、テキスト以外のデータが含まれています。AIに相談してください"
                .into(),
        );
    }
    String::from_utf8(bytes)
        .map_err(|_| "テキストとして確認できない変更です。AIに相談してください".into())
}
fn checked_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("確認用データの保存先が不正です".into());
    }
    let mut cursor = PathBuf::new();
    for part in path.components() {
        match part {
            Component::RootDir | Component::Normal(_) => cursor.push(part),
            _ => return Err("確認用パスに相対参照は使用できません".into()),
        }
        let meta =
            fs::symlink_metadata(&cursor).map_err(|_| "確認に必要な保存データが見つかりません")?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err("確認用データのフォルダにリンクは使用できません".into());
        }
    }
    Ok(())
}
fn read_file(path: &Path, limit: usize) -> Result<Vec<u8>, String> {
    checked_directory(path.parent().ok_or("確認用パスが不正です")?)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| "確認に必要な保存データが見つかりません")?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit as u64 {
        return Err("確認用データが大きすぎるか、通常のファイルではありません".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options
        .open(path)
        .map_err(|_| "確認用データを安全に開けません")?;
    if !file.metadata().map_err(|e| e.to_string())?.is_file() {
        return Err("確認用データが通常のファイルではありません".into());
    }
    let mut bytes = Vec::new();
    file.take((limit + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > limit {
        return Err("確認用データが大きすぎます".into());
    }
    Ok(bytes)
}
fn name_valid(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.eq_ignore_ascii_case(".git")
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(char::is_control)
    {
        return Err("成果物に確認できないファイル名があります".into());
    }
    Ok(())
}
fn artifact_tree(
    root: &Path,
    relative: &Path,
    depth: usize,
    files: &mut BTreeMap<String, Entry>,
    total: &mut usize,
    entries: &mut usize,
) -> Result<Oid, String> {
    if depth > 64 {
        return Err("成果物の階層が深すぎます".into());
    }
    checked_directory(&root.join(relative))?;
    let mut children = Vec::new();
    for item in fs::read_dir(root.join(relative)).map_err(|e| e.to_string())? {
        *entries += 1;
        if *entries > MAX_ENTRIES {
            return Err("成果物の項目数が多すぎます".into());
        }
        let item = item.map_err(|e| e.to_string())?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| "成果物の名前を読み取れません")?;
        name_valid(&name)?;
        let meta = fs::symlink_metadata(item.path()).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err("成果物にリンクは使用できません".into());
        }
        let path = relative.join(&name);
        let (mode, oid) = if meta.is_dir() {
            (
                0o40000,
                artifact_tree(root, &path, depth + 1, files, total, entries)?,
            )
        } else if meta.is_file() {
            let bytes = read_file(
                &item.path(),
                MAX_FILE.min(MAX_ARTIFACT.saturating_sub(*total)),
            )?;
            *total += bytes.len();
            #[cfg(unix)]
            let executable = {
                use std::os::unix::fs::PermissionsExt;
                meta.permissions().mode() & 0o111 != 0
            };
            #[cfg(not(unix))]
            let executable = false;
            let mode = if executable { 0o100755 } else { 0o100644 };
            let oid = Oid::hash_object(ObjectType::Blob, &bytes).map_err(|e| e.to_string())?;
            files.insert(
                path.to_str().ok_or("成果物のパスが不正です")?.into(),
                Entry { mode, oid },
            );
            (mode, oid)
        } else {
            return Err("成果物に未対応のファイルが含まれています".into());
        };
        let sort = if mode == 0o40000 {
            format!("{name}/")
        } else {
            name.clone()
        };
        children.push((sort, name, mode, oid));
    }
    children.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    let mut tree = Vec::new();
    for (_, name, mode, oid) in children {
        tree.extend_from_slice(format!("{mode:o} {name}").as_bytes());
        tree.push(0);
        tree.extend_from_slice(oid.as_bytes());
    }
    Oid::hash_object(ObjectType::Tree, &tree).map_err(|e| e.to_string())
}
fn verified_object(
    repo: &Repository,
    oid: Oid,
    kind: ObjectType,
    limit: usize,
) -> Result<Vec<u8>, String> {
    let database = repo.odb().map_err(|e| e.to_string())?;
    let (size, actual) = database
        .read_header(oid)
        .map_err(|_| "比較元のGitオブジェクトが見つかりません")?;
    if actual != kind || size > limit {
        return Err("比較元データが大きすぎるか不正です".into());
    }
    let object = database
        .read(oid)
        .map_err(|_| "比較元データを読み取れません")?;
    if object.kind() != kind
        || object.data().len() > limit
        || Oid::hash_object(kind, object.data()).map_err(|e| e.to_string())? != oid
    {
        return Err("比較元データの内容が識別子と一致しません".into());
    }
    Ok(object.data().to_vec())
}
fn base_tree(
    repo: &Repository,
    oid: Oid,
    prefix: &str,
    depth: usize,
    files: &mut BTreeMap<String, Entry>,
    entries: &mut usize,
) -> Result<(), String> {
    if depth > 64 {
        return Err("比較元の階層が深すぎます".into());
    }
    let bytes = verified_object(repo, oid, ObjectType::Tree, 4 * 1024 * 1024)?;
    let mut cursor = 0;
    let mut names = BTreeSet::new();
    while cursor < bytes.len() {
        *entries += 1;
        if *entries > MAX_ENTRIES {
            return Err("比較元の項目数が多すぎます".into());
        }
        let space = bytes[cursor..]
            .iter()
            .position(|b| *b == b' ')
            .map(|n| n + cursor)
            .ok_or("比較元ツリーの形式が不正です")?;
        let mode = std::str::from_utf8(&bytes[cursor..space])
            .ok()
            .and_then(|mode| u32::from_str_radix(mode, 8).ok())
            .ok_or("比較元の属性が不正です")?;
        let end = bytes[space + 1..]
            .iter()
            .position(|b| *b == 0)
            .map(|n| n + space + 1)
            .ok_or("比較元ツリーの名前が不正です")?;
        let name = std::str::from_utf8(&bytes[space + 1..end])
            .map_err(|_| "比較元の名前を読み取れません")?;
        name_valid(name)?;
        if !names.insert(name) {
            return Err("比較元に重複した名前があります".into());
        }
        let next = end
            .checked_add(21)
            .filter(|next| *next <= bytes.len())
            .ok_or("比較元の識別子が不正です")?;
        let child = Oid::from_bytes(&bytes[end + 1..next]).map_err(|e| e.to_string())?;
        cursor = next;
        let path = if prefix.is_empty() {
            name.into()
        } else {
            format!("{prefix}/{name}")
        };
        match mode {
            0o40000 => base_tree(repo, child, &path, depth + 1, files, entries)?,
            0o100644 | 0o100755 => {
                files.insert(path, Entry { oid: child, mode });
            }
            _ => return Err("比較元のリンクやサブモジュールには対応していません".into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture(after: &[u8]) -> (tempfile::TempDir, PathBuf, super::super::Run) {
        let directory = tempfile::tempdir().unwrap();
        let storage = directory.path().canonicalize().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let job = storage.join("development").join(&id);
        fs::create_dir_all(&job).unwrap();
        let repo = Repository::init(job.join("repository")).unwrap();
        let original = repo.blob(b"Before the change\n").unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder.insert("report.txt", original, 0o100644).unwrap();
        let tree = builder.write().unwrap();
        let signature = git2::Signature::now("Fixture", "fixture@example.test").unwrap();
        let commit = repo
            .commit(
                Some("HEAD"),
                &signature,
                &signature,
                "fixture",
                &repo.find_tree(tree).unwrap(),
                &[],
            )
            .unwrap();
        let modified = repo.blob(after).unwrap();
        builder.insert("report.txt", modified, 0o100644).unwrap();
        let verified = builder.write().unwrap();
        let artifact = super::super::artifact::export_verified_tree(
            &job.join("repository"),
            &job,
            &verified.to_string(),
        )
        .unwrap();
        let root = storage.join("original-project");
        let checks = json!([{"command":"fixture verification","exitCode":0}]);
        fs::write(job.join("source.json"),serde_json::to_vec(&json!({"root":root,"baseCommit":commit.to_string(),"baseBranch":"main","branch":"fixture","originUrl":"https://user:secret@example.test/team/project.git?token=secret"})).unwrap()).unwrap();
        fs::write(job.join("result.json"),serde_json::to_vec(&json!({"worktreePath":artifact,"baseCommit":commit.to_string(),"baseBranch":"main","branch":"fixture","verifiedTree":verified.to_string(),"changedPaths":["report.txt"],"checks":checks})).unwrap()).unwrap();
        let run = super::super::Run {
            id,
            started_at: 1,
            finished_at: Some(2),
            status: "completed".into(),
            summary: "Prepared changes".into(),
            reason: "Requested work".into(),
            changed_paths: vec!["report.txt".into()],
            can_undo: false,
            development_path: Some(artifact.to_string_lossy().into_owned()),
            pull_request_url: None,
            branch: Some("fixture".into()),
            validation_summary: None,
            source_root: None,
        };
        (directory, storage, run)
    }
    #[test]
    fn legacy_result_has_original_source_and_complete_verified_before_after() {
        let (_directory, storage, run) = fixture(b"After the change\n");
        let context = load(&storage, &run).unwrap();
        assert_eq!(
            context.source_root,
            storage.join("original-project").to_string_lossy()
        );
        assert_eq!(
            context.changes[0].before.as_deref(),
            Some("Before the change\n")
        );
        assert_eq!(
            context.changes[0].after.as_deref(),
            Some("After the change\n")
        );
        assert_eq!(
            context.origin.as_deref(),
            Some("https://example.test/team/project.git")
        );
        assert_eq!(context.checks.len(), 1);
    }
    #[test]
    fn unavailable_or_tampered_artifacts_fail_without_inventing_context() {
        let (_directory, storage, run) = fixture(b"After\n");
        let artifact = PathBuf::from(run.development_path.as_ref().unwrap());
        fs::write(artifact.join("report.txt"), "Tampered\n").unwrap();
        assert!(load(&storage, &run).unwrap_err().contains("変わっています"));
        fs::remove_file(
            storage
                .join("development")
                .join(&run.id)
                .join("result.json"),
        )
        .unwrap();
        assert!(load(&storage, &run).is_err());
    }
    #[test]
    fn binary_and_oversized_changed_content_are_not_silently_truncated() {
        let (_directory, storage, run) = fixture(b"binary\0payload");
        assert!(load(&storage, &run).is_err());
        let (_directory, storage, run) = fixture(&vec![b'x'; MAX_TEXT + 1]);
        assert!(load(&storage, &run).is_err());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_artifact_and_metadata_are_rejected() {
        use std::os::unix::fs::symlink;
        let (_directory, storage, run) = fixture(b"After\n");
        let artifact = PathBuf::from(run.development_path.as_ref().unwrap());
        fs::remove_file(artifact.join("report.txt")).unwrap();
        symlink("/etc/passwd", artifact.join("report.txt")).unwrap();
        assert!(load(&storage, &run).is_err());
        let source = storage
            .join("development")
            .join(&run.id)
            .join("source.json");
        fs::remove_file(&source).unwrap();
        symlink("/etc/passwd", source).unwrap();
        assert!(load(&storage, &run).is_err());
    }
    #[test]
    fn mismatched_source_and_changed_paths_are_rejected() {
        let (_directory, storage, mut run) = fixture(b"After\n");
        run.source_root = Some("/unrelated-project".into());
        assert!(load(&storage, &run).is_err());
        run.source_root = None;
        run.changed_paths = vec!["unrelated.txt".into()];
        assert!(load(&storage, &run).is_err());
    }
    #[test]
    #[ignore = "read-only verification of a user-selected saved run; requires YORISHIRO_REVIEW_RUN_ID"]
    fn live_saved_artifact_context() {
        let id = std::env::var("YORISHIRO_REVIEW_RUN_ID").expect("explicit saved run ID");
        let storage = dirs::home_dir().unwrap().join(".yorishiro/autonomy");
        let status: super::super::Status =
            serde_json::from_slice(&fs::read(storage.join("state.json")).unwrap()).unwrap();
        let run = status
            .runs
            .iter()
            .find(|run| run.id == id)
            .expect("saved run");
        let context = load(&storage, run).unwrap();
        assert!(!context.source_root.is_empty());
        assert!(!context.changes.is_empty());
        println!(
            "Verified saved context: {} changed text files, {} checks",
            context.changes.len(),
            context.checks.len()
        );
    }
}
