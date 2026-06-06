//! ~/.charminal/.charminal-snapshots/ の git2 snapshot store。
//! git dir は work tree から分離し、ユーザーの system git には依存しない。

use git2::build::CheckoutBuilder;
use git2::{
    Commit, ErrorCode, Index, ObjectType, Oid, Repository, RepositoryInitOptions, Signature, Tree,
};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::ffi::OsStr;
use std::path::Component;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const SNAPSHOT_GIT_DIR: &str = ".charminal-snapshots";
const STARTUP_CLEAN_NOTES_REF: &str = "refs/notes/startup-clean";
const GITIGNORE_CONTENT: &str = "\
journal/
.history/
.charminal-snapshots/
sdk.d.ts
last-startup.json
.staging/
tmp/
.DS_Store
";

/// snapshot に含める ~/.charminal 相対パス。
const SNAPSHOT_INCLUDES: &[&str] = &["packs", "config.json", "init.js"];

/// 一覧に返す snapshot の既定件数。git commit 自体は prune しない。
pub(crate) const DEFAULT_KEEP: usize = 50;

/// git index / commit / checkout / notes 操作をプロセス内で直列化する。
static SNAPSHOT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct SnapshotEntry {
    pub seq: u64,
    pub ts_ms: u64,
    pub trigger: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 直前 startup が clean だったかの advisory ラベル。startup-baseline にだけ付く。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_clean: Option<bool>,
    /// この snapshot で変わった pack/ファイルの帰属。pack id か "init.js"。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changed: Option<Vec<String>>,
}

#[derive(Default)]
struct ParsedCommit {
    seq: Option<u64>,
    trigger: Option<String>,
    label: Option<String>,
    changed: Option<Vec<String>>,
}

fn charminal_dir(home_root: &Path) -> PathBuf {
    home_root.join(".charminal")
}

fn snapshot_git_dir(home_root: &Path) -> PathBuf {
    charminal_dir(home_root).join(SNAPSHOT_GIT_DIR)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn git_err(context: &str, err: git2::Error) -> String {
    format!("{}: {}", context, err)
}

fn io_err(context: &str, err: std::io::Error) -> String {
    format!("{}: {}", context, err)
}

fn is_unborn_or_not_found(err: &git2::Error) -> bool {
    matches!(err.code(), ErrorCode::UnbornBranch | ErrorCode::NotFound)
}

fn signature() -> Result<Signature<'static>, String> {
    Signature::now("charminal", "noreply@charminal.app").map_err(|e| git_err("signature", e))
}

fn ensure_gitignore(charminal_home: &Path) -> Result<(), String> {
    let path = charminal_home.join(".gitignore");
    if path.exists() {
        return Ok(());
    }
    std::fs::write(&path, GITIGNORE_CONTENT).map_err(|e| io_err("write .gitignore", e))
}

fn remove_snapshot_gitlink(charminal_home: &Path, git_dir: &Path) -> Result<(), String> {
    let gitlink = charminal_home.join(".git");
    let Ok(meta) = std::fs::symlink_metadata(&gitlink) else {
        return Ok(());
    };
    if meta.file_type().is_dir() && !meta.file_type().is_symlink() {
        return Err("~/.charminal/.git is a directory; refusing to modify it".to_string());
    }
    let content = std::fs::read_to_string(&gitlink).map_err(|e| io_err("read .git gitlink", e))?;
    let Some(target) = content.trim().strip_prefix("gitdir:") else {
        return Err("~/.charminal/.git exists but is not a snapshot gitlink".to_string());
    };
    let target = Path::new(target.trim());
    let target = if target.is_absolute() {
        target.to_path_buf()
    } else {
        charminal_home.join(target)
    };
    let canonical_target = std::fs::canonicalize(&target).unwrap_or(target);
    let canonical_git_dir =
        std::fs::canonicalize(git_dir).unwrap_or_else(|_| git_dir.to_path_buf());
    if canonical_target != canonical_git_dir {
        return Err("~/.charminal/.git points outside snapshot storage".to_string());
    }
    std::fs::remove_file(&gitlink).map_err(|e| io_err("remove .git gitlink", e))
}

fn open_or_init_repo(home_root: &Path) -> Result<Repository, String> {
    let charminal_home = charminal_dir(home_root);
    std::fs::create_dir_all(charminal_home.join("packs"))
        .map_err(|e| io_err("mkdir ~/.charminal/packs", e))?;
    ensure_gitignore(&charminal_home)?;

    let git_dir = snapshot_git_dir(home_root);
    let repo = if git_dir.exists() {
        Repository::open(&git_dir).map_err(|e| git_err("open snapshot repo", e))?
    } else {
        let mut opts = RepositoryInitOptions::new();
        opts.no_dotgit_dir(true)
            .external_template(false)
            .workdir_path(&charminal_home)
            .initial_head("main");
        Repository::init_opts(&git_dir, &opts).map_err(|e| git_err("init snapshot repo", e))?
    };
    remove_snapshot_gitlink(&charminal_home, &git_dir)?;
    repo.set_workdir(&charminal_home, false)
        .map_err(|e| git_err("set snapshot workdir", e))?;
    Ok(repo)
}

/// `ensure_charminal_dirs` から呼ぶ repo 初期化。baseline commit は既存の起動時
/// snapshot 経路が作るため、ここでは git dir と .gitignore だけ保証する。
pub(crate) fn ensure_snapshot_repo_impl(home_root: &Path) -> Result<(), String> {
    let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    open_or_init_repo(home_root).map(|_| ())
}

fn head_commit(repo: &Repository) -> Result<Option<Commit<'_>>, String> {
    match repo.head() {
        Ok(head) => head
            .peel_to_commit()
            .map(Some)
            .map_err(|e| git_err("peel HEAD commit", e)),
        Err(e) if is_unborn_or_not_found(&e) => Ok(None),
        Err(e) => Err(git_err("read HEAD", e)),
    }
}

fn head_tree_oid(repo: &Repository) -> Result<Option<Oid>, String> {
    let Some(commit) = head_commit(repo)? else {
        return Ok(None);
    };
    commit
        .tree()
        .map(|tree| Some(tree.id()))
        .map_err(|e| git_err("read HEAD tree", e))
}

fn revwalk_oids(repo: &Repository) -> Result<Vec<Oid>, String> {
    if head_commit(repo)?.is_none() {
        return Ok(Vec::new());
    }
    let mut walk = repo.revwalk().map_err(|e| git_err("revwalk", e))?;
    if let Err(e) = walk.push_head() {
        if is_unborn_or_not_found(&e) {
            return Ok(Vec::new());
        }
        return Err(git_err("revwalk HEAD", e));
    }
    let mut oids = Vec::new();
    for oid in walk {
        oids.push(oid.map_err(|e| git_err("revwalk oid", e))?);
    }
    Ok(oids)
}

fn parse_commit_message(message: &str) -> ParsedCommit {
    let mut parsed = ParsedCommit::default();
    for line in message.lines() {
        if let Some(value) = line.strip_prefix("Seq: ") {
            parsed.seq = value.trim().parse::<u64>().ok();
        } else if let Some(value) = line.strip_prefix("Trigger: ") {
            parsed.trigger = Some(value.trim().to_string());
        } else if let Some(value) = line.strip_prefix("Label: ") {
            let label = value.trim();
            if !label.is_empty() {
                parsed.label = Some(label.to_string());
            }
        } else if let Some(value) = line.strip_prefix("Changed: ") {
            parsed.changed = serde_json::from_str::<Vec<String>>(value.trim()).ok();
        }
    }
    parsed
}

fn parsed_commit(repo: &Repository, oid: Oid) -> Result<Option<(SnapshotEntry, Oid)>, String> {
    let commit = repo
        .find_commit(oid)
        .map_err(|e| git_err("find commit", e))?;
    let parsed = parse_commit_message(commit.message().unwrap_or(""));
    let Some(seq) = parsed.seq else {
        return Ok(None);
    };
    let Some(trigger) = parsed.trigger else {
        return Ok(None);
    };
    if !is_allowed_trigger(&trigger) {
        return Ok(None);
    }

    let ts_ms = commit.time().seconds().max(0) as u64 * 1000;
    Ok(Some((
        SnapshotEntry {
            seq,
            ts_ms,
            trigger,
            label: parsed.label,
            startup_clean: read_startup_clean_note(repo, oid)?,
            changed: parsed.changed,
        },
        oid,
    )))
}

fn is_allowed_trigger(trigger: &str) -> bool {
    matches!(
        trigger,
        "watcher-settled" | "startup-baseline" | "pre-restore" | "mcp:snapshot" | "sdk:snapshot"
    )
}

fn sanitize_label(label: Option<&str>) -> Option<String> {
    let label = label?.replace(['\n', '\r'], " ");
    let trimmed = label.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn next_seq(repo: &Repository) -> Result<u64, String> {
    let mut max_seq = 0u64;
    for oid in revwalk_oids(repo)? {
        let commit = repo
            .find_commit(oid)
            .map_err(|e| git_err("find commit for seq", e))?;
        if let Some(seq) = parse_commit_message(commit.message().unwrap_or("")).seq {
            max_seq = max_seq.max(seq);
        }
    }
    Ok(max_seq + 1)
}

fn resolve_seq_to_oid(repo: &Repository, seq: u64) -> Result<Oid, String> {
    for oid in revwalk_oids(repo)? {
        let commit = repo
            .find_commit(oid)
            .map_err(|e| git_err("find commit for seq", e))?;
        if parse_commit_message(commit.message().unwrap_or("")).seq == Some(seq) {
            return Ok(oid);
        }
    }
    Err(format!("snapshot seq {} not found", seq))
}

fn build_commit_message(
    seq: u64,
    trigger: &str,
    label: Option<&str>,
    changed: Option<Vec<String>>,
) -> Result<String, String> {
    if !is_allowed_trigger(trigger) {
        return Err(format!("snapshot trigger not allowed: {}", trigger));
    }
    let mut message = String::from("snapshot\n\n");
    message.push_str(&format!("Seq: {}\n", seq));
    message.push_str(&format!("Trigger: {}\n", trigger));
    if let Some(label) = sanitize_label(label) {
        message.push_str(&format!("Label: {}\n", label));
    }
    if let Some(changed) = changed {
        let encoded =
            serde_json::to_string(&changed).map_err(|e| format!("changed serialize: {}", e))?;
        message.push_str(&format!("Changed: {}\n", encoded));
    }
    Ok(message)
}

fn status_should_ignore(repo: &Repository, rel: &Path) -> Result<bool, String> {
    repo.status_should_ignore(rel)
        .map_err(|e| git_err("status_should_ignore", e))
}

/// index を live の work tree 状態に完全同期する。
/// 既存 entries を削除してから再追加することで、live 側の削除も次 commit に反映する。
fn sync_index_to_live(repo: &Repository, index: &mut Index) -> Result<(), String> {
    let workdir = repo.workdir().ok_or("snapshot repo has no workdir")?;
    let removals: Vec<String> = index
        .iter()
        .filter_map(|entry| {
            let path = std::str::from_utf8(&entry.path).ok()?;
            if path.starts_with("packs/") || path == "init.js" || path == "config.json" {
                Some(path.to_string())
            } else {
                None
            }
        })
        .collect();
    for path in &removals {
        index
            .remove_path(Path::new(path))
            .map_err(|e| git_err("index remove path", e))?;
    }

    let packs = workdir.join("packs");
    if packs.is_dir() {
        add_dir_to_index(repo, index, &packs)?;
    }
    for top_level in ["init.js", "config.json"] {
        let full = workdir.join(top_level);
        if full.is_file() {
            index
                .add_path(Path::new(top_level))
                .map_err(|e| git_err("index add top-level file", e))?;
        } else if full.is_dir() {
            return Err(format!("{} is a directory, expected a file", top_level));
        }
    }
    Ok(())
}

fn add_dir_to_index(repo: &Repository, index: &mut Index, dir: &Path) -> Result<(), String> {
    let workdir = repo.workdir().ok_or("snapshot repo has no workdir")?;
    for entry in std::fs::read_dir(dir).map_err(|e| io_err("read snapshot dir", e))? {
        let entry = entry.map_err(|e| io_err("read snapshot entry", e))?;
        let name = entry.file_name();
        if name == ".git" || name == ".DS_Store" {
            continue;
        }
        if name.to_string_lossy().ends_with(".resttmp") {
            continue;
        }
        let path = entry.path();
        let rel = path
            .strip_prefix(workdir)
            .map_err(|e| format!("strip workdir: {}", e))?;
        if status_should_ignore(repo, rel)? {
            continue;
        }
        let ty = entry
            .file_type()
            .map_err(|e| io_err("snapshot entry type", e))?;
        if ty.is_dir() {
            add_dir_to_index(repo, index, &path)?;
        } else {
            index
                .add_path(rel)
                .map_err(|e| git_err("index add path", e))?;
        }
    }
    Ok(())
}

fn snapshot_create_locked(
    repo: &Repository,
    trigger: &str,
    label: Option<&str>,
    changed: Option<Vec<String>>,
) -> Result<u64, String> {
    let seq = next_seq(repo)?;
    let mut index = repo.index().map_err(|e| git_err("open index", e))?;
    sync_index_to_live(repo, &mut index)?;
    let tree_oid = index.write_tree().map_err(|e| git_err("write tree", e))?;
    let tree = repo
        .find_tree(tree_oid)
        .map_err(|e| git_err("find written tree", e))?;
    let parent = head_commit(repo)?;
    let parents: Vec<&Commit<'_>> = parent
        .as_ref()
        .map(|commit| vec![commit])
        .unwrap_or_default();
    let sig = signature()?;
    let message = build_commit_message(seq, trigger, label, changed)?;
    repo.commit(Some("HEAD"), &sig, &sig, &message, &tree, &parents)
        .map_err(|e| git_err("commit snapshot", e))?;
    Ok(seq)
}

pub(crate) fn snapshot_create_impl(
    home_root: &Path,
    trigger: &str,
    label: Option<&str>,
) -> Result<u64, String> {
    snapshot_create_with_changed_impl(home_root, trigger, label, None)
}

pub(crate) fn snapshot_create_with_changed_impl(
    home_root: &Path,
    trigger: &str,
    label: Option<&str>,
    changed: Option<Vec<String>>,
) -> Result<u64, String> {
    let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = open_or_init_repo(home_root)?;
    snapshot_create_locked(&repo, trigger, label, changed)
}

pub(crate) fn snapshot_list_impl(home_root: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let repo = open_or_init_repo(home_root)?;
    let mut entries = Vec::new();
    for oid in revwalk_oids(&repo)? {
        if let Some((entry, _oid)) = parsed_commit(&repo, oid)? {
            entries.push(entry);
        }
    }
    entries.sort_by(|a, b| b.seq.cmp(&a.seq));
    entries.truncate(DEFAULT_KEEP);
    Ok(entries)
}

fn read_startup_clean_note(repo: &Repository, oid: Oid) -> Result<Option<bool>, String> {
    match repo.find_note(Some(STARTUP_CLEAN_NOTES_REF), oid) {
        Ok(note) => Ok(note.message().and_then(|message| match message.trim() {
            "true" => Some(true),
            "false" => Some(false),
            _ => None,
        })),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(git_err("read startup_clean note", e)),
    }
}

fn remove_path(p: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(p) {
        Ok(meta) if meta.file_type().is_dir() && !meta.file_type().is_symlink() => {
            std::fs::remove_dir_all(p).map_err(|e| io_err(&format!("rmdir {}", p.display()), e))
        }
        Ok(_) => std::fs::remove_file(p).map_err(|e| io_err(&format!("rm {}", p.display()), e)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(io_err(&format!("metadata {}", p.display()), e)),
    }
}

fn path_is_file_like(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|meta| !meta.file_type().is_dir() || meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn path_is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|meta| meta.file_type().is_dir() && !meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn is_git_component(seg: &OsStr) -> bool {
    seg == ".git"
}

fn path_has_git_component(path: &Path) -> bool {
    path.components()
        .any(|component| matches!(component, Component::Normal(seg) if is_git_component(seg)))
}

fn collect_live_files(
    workdir: &Path,
    rel: &Path,
    out: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    let abs = workdir.join(rel);
    let Ok(meta) = std::fs::symlink_metadata(&abs) else {
        return Ok(());
    };
    if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
        out.insert(rel.to_path_buf());
        return Ok(());
    }
    for entry in std::fs::read_dir(&abs).map_err(|e| io_err("read live dir", e))? {
        let entry = entry.map_err(|e| io_err("read live entry", e))?;
        let name = entry.file_name();
        if is_git_component(&name) {
            continue;
        }
        collect_live_files(workdir, &rel.join(name), out)?;
    }
    Ok(())
}

fn remove_empty_dirs_preserving_git(dir: &Path, preserve_root: bool) -> Result<(), String> {
    if !path_is_real_dir(dir) {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir).map_err(|e| io_err("read live dir for cleanup", e))? {
        let entry = entry.map_err(|e| io_err("read live cleanup entry", e))?;
        if is_git_component(&entry.file_name()) {
            continue;
        }
        let path = entry.path();
        if path_is_real_dir(&path) {
            remove_empty_dirs_preserving_git(&path, false)?;
        }
    }
    if !preserve_root
        && std::fs::read_dir(dir)
            .map(|mut entries| entries.next().is_none())
            .unwrap_or(false)
    {
        let _ = std::fs::remove_dir(dir);
    }
    Ok(())
}

fn remove_path_preserving_git(path: &Path, preserve_root: bool) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if !meta.file_type().is_dir() || meta.file_type().is_symlink() {
        return remove_path(path);
    }
    for entry in std::fs::read_dir(path).map_err(|e| io_err("read dir for remove", e))? {
        let entry = entry.map_err(|e| io_err("read remove entry", e))?;
        if is_git_component(&entry.file_name()) {
            continue;
        }
        remove_path(&entry.path())?;
    }
    remove_empty_dirs_preserving_git(path, preserve_root)
}

fn collect_tree_files(
    repo: &Repository,
    tree: &Tree<'_>,
    base: &Path,
    out: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    for entry in tree.iter() {
        let Some(name) = entry.name() else {
            continue;
        };
        let rel = base.join(name);
        match entry.kind() {
            Some(ObjectType::Blob) => {
                out.insert(rel);
            }
            Some(ObjectType::Tree) => {
                let child = entry
                    .to_object(repo)
                    .map_err(|e| git_err("tree entry object", e))?
                    .peel_to_tree()
                    .map_err(|e| git_err("peel tree entry", e))?;
                collect_tree_files(repo, &child, &rel, out)?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn collect_tree_dirs_and_files(
    repo: &Repository,
    tree: &Tree<'_>,
    base: &Path,
    dirs: &mut BTreeSet<PathBuf>,
    files: &mut BTreeSet<PathBuf>,
) -> Result<(), String> {
    for entry in tree.iter() {
        let Some(name) = entry.name() else {
            continue;
        };
        let rel = base.join(name);
        match entry.kind() {
            Some(ObjectType::Blob) => {
                files.insert(rel);
            }
            Some(ObjectType::Tree) => {
                dirs.insert(rel.clone());
                let child = entry
                    .to_object(repo)
                    .map_err(|e| git_err("tree entry object", e))?
                    .peel_to_tree()
                    .map_err(|e| git_err("peel tree entry", e))?;
                collect_tree_dirs_and_files(repo, &child, &rel, dirs, files)?;
            }
            _ => {}
        }
    }
    Ok(())
}

fn target_files_for_prefix(
    repo: &Repository,
    tree: &Tree<'_>,
    prefix: &Path,
) -> Result<BTreeSet<PathBuf>, String> {
    let mut files = BTreeSet::new();
    match tree.get_path(prefix) {
        Ok(entry) => match entry.kind() {
            Some(ObjectType::Blob) => {
                files.insert(prefix.to_path_buf());
            }
            Some(ObjectType::Tree) => {
                let subtree = entry
                    .to_object(repo)
                    .map_err(|e| git_err("tree entry object", e))?
                    .peel_to_tree()
                    .map_err(|e| git_err("peel tree entry", e))?;
                collect_tree_files(repo, &subtree, prefix, &mut files)?;
            }
            _ => {}
        },
        Err(e) if e.code() == ErrorCode::NotFound => {}
        Err(e) => return Err(git_err("read target tree path", e)),
    }
    Ok(files)
}

fn target_kind(tree: &Tree<'_>, rel: &Path) -> Result<Option<ObjectType>, String> {
    match tree.get_path(rel) {
        Ok(entry) => Ok(entry.kind()),
        Err(e) if e.code() == ErrorCode::NotFound => Ok(None),
        Err(e) => Err(git_err("read target tree path", e)),
    }
}

fn clear_checkout_conflicts_for_scope(
    repo: &Repository,
    tree: &Tree<'_>,
    workdir: &Path,
    rel: &Path,
) -> Result<(), String> {
    let mut dirs = BTreeSet::new();
    let mut files = BTreeSet::new();
    match tree.get_path(rel) {
        Ok(entry) => match entry.kind() {
            Some(ObjectType::Blob) => {
                files.insert(rel.to_path_buf());
            }
            Some(ObjectType::Tree) => {
                dirs.insert(rel.to_path_buf());
                let subtree = entry
                    .to_object(repo)
                    .map_err(|e| git_err("tree entry object", e))?
                    .peel_to_tree()
                    .map_err(|e| git_err("peel tree entry", e))?;
                collect_tree_dirs_and_files(repo, &subtree, rel, &mut dirs, &mut files)?;
            }
            _ => {}
        },
        Err(e) if e.code() == ErrorCode::NotFound => return Ok(()),
        Err(e) => return Err(git_err("read target tree path", e)),
    }

    for dir in dirs {
        let abs = workdir.join(&dir);
        if path_is_file_like(&abs) {
            remove_path(&abs)?;
        }
    }
    for file in files {
        let abs = workdir.join(&file);
        if path_is_real_dir(&abs) {
            remove_path(&abs)?;
        }
    }
    Ok(())
}

fn checkout_scope(repo: &Repository, tree: &Tree<'_>, scope: &[String]) -> Result<(), String> {
    let workdir = repo.workdir().ok_or("snapshot repo has no workdir")?;
    for rel in scope {
        clear_checkout_conflicts_for_scope(repo, tree, workdir, Path::new(rel))?;
    }

    let mut checkout = CheckoutBuilder::new();
    checkout.force();
    for rel in scope {
        checkout.path(rel);
    }
    repo.checkout_tree(tree.as_object(), Some(&mut checkout))
        .map_err(|e| git_err("checkout target tree", e))
}

fn mirror_tree_scope(repo: &Repository, tree: &Tree<'_>, rel: &Path) -> Result<(), String> {
    let workdir = repo.workdir().ok_or("snapshot repo has no workdir")?;
    let target_files = target_files_for_prefix(repo, tree, rel)?;
    let mut live_files = BTreeSet::new();
    collect_live_files(workdir, rel, &mut live_files)?;
    let mut extras: Vec<PathBuf> = live_files.difference(&target_files).cloned().collect();
    extras.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for extra in extras {
        if path_has_git_component(&extra) {
            continue;
        }
        remove_path(&workdir.join(extra))?;
    }
    remove_empty_dirs_preserving_git(&workdir.join(rel), rel == Path::new("packs"))
}

fn mirror_scope(repo: &Repository, tree: &Tree<'_>, rel: &str) -> Result<(), String> {
    let workdir = repo.workdir().ok_or("snapshot repo has no workdir")?;
    let rel_path = Path::new(rel);
    if rel == "packs" {
        return mirror_tree_scope(repo, tree, rel_path);
    }
    if rel_path.starts_with("packs/") {
        match target_kind(tree, rel_path)? {
            Some(ObjectType::Tree) => mirror_tree_scope(repo, tree, rel_path),
            Some(ObjectType::Blob) => Ok(()),
            None => remove_path_preserving_git(&workdir.join(rel_path), false),
            _ => Ok(()),
        }
    } else if target_kind(tree, rel_path)?.is_none() {
        remove_path(&workdir.join(rel_path))
    } else {
        Ok(())
    }
}

fn is_restorable_rel(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return false;
    }
    let comps: Vec<_> = path.components().collect();
    if comps.is_empty()
        || comps
            .iter()
            .any(|comp| !matches!(comp, Component::Normal(_)))
    {
        return false;
    }
    if comps
        .iter()
        .any(|comp| matches!(comp, Component::Normal(seg) if is_git_component(seg)))
    {
        return false;
    }

    match comps[0] {
        Component::Normal(seg) if seg == "config.json" || seg == "init.js" => comps.len() == 1,
        Component::Normal(seg) if seg == "packs" => true,
        _ => false,
    }
}

pub(crate) fn snapshot_restore_impl(
    home_root: &Path,
    seq: u64,
    paths: Option<Vec<String>>,
) -> Result<(), String> {
    let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = open_or_init_repo(home_root)?;
    let target_oid = resolve_seq_to_oid(&repo, seq)?;
    let target_commit = repo
        .find_commit(target_oid)
        .map_err(|e| git_err("find target commit", e))?;
    let target_tree = target_commit
        .tree()
        .map_err(|e| git_err("read target tree", e))?;
    let scope: Vec<String> = match paths {
        Some(paths) if !paths.is_empty() => paths,
        _ => SNAPSHOT_INCLUDES.iter().map(|s| s.to_string()).collect(),
    };

    for rel in &scope {
        if !is_restorable_rel(rel) {
            return Err(format!("restore path not allowed: {}", rel));
        }
    }

    snapshot_create_locked(&repo, "pre-restore", None, None)?;
    checkout_scope(&repo, &target_tree, &scope)?;
    for rel in &scope {
        mirror_scope(&repo, &target_tree, rel)?;
    }
    Ok(())
}

pub(crate) fn snapshot_prune_impl(_home_root: &Path, _keep_n: usize) -> Result<(), String> {
    Ok(())
}

pub(crate) fn should_skip_baseline(home_root: &Path, _window_ms: u64) -> bool {
    let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let result: Result<bool, String> = (|| {
        let repo = open_or_init_repo(home_root)?;
        let Some(head_tree_oid) = head_tree_oid(&repo)? else {
            return Ok(false);
        };
        let mut index = repo.index().map_err(|e| git_err("open index", e))?;
        sync_index_to_live(&repo, &mut index)?;
        let live_tree_oid = index
            .write_tree()
            .map_err(|e| git_err("write live tree", e))?;
        Ok(live_tree_oid == head_tree_oid)
    })();
    result.unwrap_or(false)
}

pub(crate) fn restore_quiet_period_active(home_root: &Path, window_ms: u64) -> bool {
    let result: Result<bool, String> = (|| {
        let repo = open_or_init_repo(home_root)?;
        let Some(commit) = head_commit(&repo)? else {
            return Ok(false);
        };
        let parsed = parse_commit_message(commit.message().unwrap_or(""));
        let ts_ms = commit.time().seconds().max(0) as u64 * 1000;
        Ok(parsed.trigger.as_deref() == Some("pre-restore")
            && now_ms().saturating_sub(ts_ms) <= window_ms)
    })();
    result.unwrap_or(false)
}

/// 直前 startup が clean だったか（last-startup.json の load error 有無）を返す。
pub(crate) fn is_last_startup_clean(home_root: &Path) -> Option<bool> {
    let text = crate::read_last_startup_report_impl(home_root).ok()?;
    if text.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    let results = parsed.get("loadResults")?.as_array()?;
    let any_failed = results
        .iter()
        .any(|item| item.get("status").and_then(|v| v.as_str()) == Some("failed"));
    Some(!any_failed)
}

pub(crate) fn tag_startup_clean(home_root: &Path, seq: u64, clean: bool) -> Result<(), String> {
    let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let repo = open_or_init_repo(home_root)?;
    let oid = match resolve_seq_to_oid(&repo, seq) {
        Ok(oid) => oid,
        Err(_) => return Ok(()),
    };
    let sig = signature()?;
    repo.note(
        &sig,
        &sig,
        Some(STARTUP_CLEAN_NOTES_REF),
        oid,
        &clean.to_string(),
        true,
    )
    .map_err(|e| git_err("write startup_clean note", e))?;
    Ok(())
}

#[tauri::command]
pub fn snapshot_create(trigger: String, label: Option<String>) -> Result<u64, String> {
    let home = crate::home_dir_or_err()?;
    snapshot_create_impl(&home, &trigger, label.as_deref())
}

#[tauri::command]
pub fn snapshot_list() -> Result<Vec<SnapshotEntry>, String> {
    let home = crate::home_dir_or_err()?;
    snapshot_list_impl(&home)
}

#[tauri::command]
pub fn snapshot_restore(seq: u64, paths: Option<Vec<String>>) -> Result<(), String> {
    let home = crate::home_dir_or_err()?;
    snapshot_restore_impl(&home, seq, paths)
}

#[tauri::command]
pub fn snapshot_prune(keep_n: usize) -> Result<(), String> {
    let home = crate::home_dir_or_err()?;
    snapshot_prune_impl(&home, keep_n)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_home(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-history-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join(".charminal")).expect("mkdir charminal");
        tmp
    }

    fn charminal(home: &Path) -> PathBuf {
        home.join(".charminal")
    }

    fn repo(home: &Path) -> Repository {
        Repository::open(snapshot_git_dir(home)).expect("open repo")
    }

    fn head_tree_contains(home: &Path, rel: &str) -> bool {
        let repo = repo(home);
        let tree = repo.head().unwrap().peel_to_tree().unwrap();
        tree.get_path(Path::new(rel)).is_ok()
    }

    fn seed_pack(home: &Path, id: &str, file: &str, content: &str) {
        let path = charminal(home).join("packs").join(id).join(file);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, content).unwrap();
    }

    #[test]
    fn repo_init_uses_separated_git_dir_and_gitignore() {
        let home = tmp_home("repo-init");
        ensure_snapshot_repo_impl(&home).unwrap();

        assert!(snapshot_git_dir(&home).join("HEAD").exists());
        assert!(!charminal(&home).join(".git").exists());
        let ignore = fs::read_to_string(charminal(&home).join(".gitignore")).unwrap();
        assert!(ignore.contains(".charminal-snapshots/"));
        assert!(head_commit(&repo(&home)).unwrap().is_none());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn snapshot_create_tracks_scope_and_excludes_internal_files() {
        let home = tmp_home("snap-create");
        seed_pack(&home, "foo", "effect.js", "export default {}");
        fs::create_dir_all(charminal(&home).join("packs/foo/.git/objects")).unwrap();
        fs::write(charminal(&home).join("packs/foo/.git/config"), "keep").unwrap();
        fs::write(charminal(&home).join("packs/foo/.DS_Store"), "noise").unwrap();
        fs::write(charminal(&home).join("packs/foo/.effect.js.resttmp"), "tmp").unwrap();
        fs::write(
            charminal(&home).join("config.json"),
            "{\"activeScene\":null}",
        )
        .unwrap();
        fs::write(charminal(&home).join("init.js"), "// init").unwrap();
        fs::create_dir_all(charminal(&home).join("journal/daily")).unwrap();
        fs::write(
            charminal(&home).join("journal/daily/2026-06-02.md"),
            "secret",
        )
        .unwrap();

        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();
        assert_eq!(seq, 1);
        assert!(head_tree_contains(&home, "packs/foo/effect.js"));
        assert!(head_tree_contains(&home, "config.json"));
        assert!(head_tree_contains(&home, "init.js"));
        assert!(!head_tree_contains(&home, "packs/foo/.git/config"));
        assert!(!head_tree_contains(&home, "packs/foo/.DS_Store"));
        assert!(!head_tree_contains(&home, "journal/daily/2026-06-02.md"));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn snapshot_list_returns_desc_with_label_and_changed() {
        let home = tmp_home("snap-list");
        fs::write(charminal(&home).join("config.json"), "{}").unwrap();

        snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();
        snapshot_create_with_changed_impl(
            &home,
            "watcher-settled",
            Some("label\nwith newline"),
            Some(vec!["my-theme".to_string(), "init.js".to_string()]),
        )
        .unwrap();

        let list = snapshot_list_impl(&home).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].seq, 2);
        assert_eq!(list[0].trigger, "watcher-settled");
        assert_eq!(list[0].label.as_deref(), Some("label with newline"));
        assert_eq!(
            list[0].changed,
            Some(vec!["my-theme".to_string(), "init.js".to_string()])
        );
        assert_eq!(list[1].seq, 1);

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn snapshot_list_limits_to_default_keep() {
        let home = tmp_home("list-limit");
        fs::write(charminal(&home).join("config.json"), "{}").unwrap();
        for _ in 0..(DEFAULT_KEEP + 3) {
            snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();
        }

        let list = snapshot_list_impl(&home).unwrap();
        assert_eq!(list.len(), DEFAULT_KEEP);
        assert_eq!(list[0].seq, (DEFAULT_KEEP + 3) as u64);
        assert_eq!(list[DEFAULT_KEEP - 1].seq, 4);

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_quiet_period_is_active_only_after_recent_pre_restore() {
        let home = tmp_home("restore-quiet");
        fs::write(charminal(&home).join("config.json"), "{}").unwrap();
        assert!(!restore_quiet_period_active(&home, 5_000));

        snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();
        assert!(!restore_quiet_period_active(&home, 5_000));

        fs::write(charminal(&home).join("config.json"), "{\"v\":2}").unwrap();
        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();
        snapshot_restore_impl(&home, seq, None).unwrap();
        assert!(restore_quiet_period_active(&home, 5_000));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn should_skip_baseline_compares_live_tree_to_head() {
        let home = tmp_home("skip-baseline");
        seed_pack(&home, "foo", "effect.js", "v1");
        fs::write(charminal(&home).join("config.json"), "{\"v\":1}").unwrap();
        snapshot_create_impl(&home, "startup-baseline", None).unwrap();

        assert!(should_skip_baseline(&home, 60_000));
        fs::write(charminal(&home).join("config.json"), "{\"v\":2}").unwrap();
        assert!(!should_skip_baseline(&home, 60_000));
        fs::create_dir_all(charminal(&home).join("journal")).unwrap();
        fs::write(charminal(&home).join("journal/memo.md"), "ignored").unwrap();
        assert!(!should_skip_baseline(&home, 60_000));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn snapshot_create_with_changed_records_scope() {
        let home = tmp_home("snap-changed");
        fs::write(charminal(&home).join("config.json"), "{}").unwrap();

        let seq = snapshot_create_with_changed_impl(
            &home,
            "watcher-settled",
            None,
            Some(vec!["my-theme".to_string()]),
        )
        .unwrap();
        assert_eq!(seq, 1);

        let snaps = snapshot_list_impl(&home).unwrap();
        assert_eq!(snaps[0].changed, Some(vec!["my-theme".to_string()]));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_takes_pre_restore_snapshot_first_and_can_undo() {
        let home = tmp_home("pre-restore");
        fs::write(charminal(&home).join("config.json"), "{\"v\":1}").unwrap();
        let seq1 = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();

        fs::write(charminal(&home).join("config.json"), "{\"v\":2}").unwrap();
        snapshot_restore_impl(&home, seq1, None).unwrap();

        let snaps = snapshot_list_impl(&home).unwrap();
        let pre_restore_seq = snaps
            .iter()
            .find(|s| s.trigger == "pre-restore")
            .map(|s| s.seq)
            .expect("pre-restore snapshot");
        assert_eq!(
            fs::read_to_string(charminal(&home).join("config.json")).unwrap(),
            "{\"v\":1}"
        );

        snapshot_restore_impl(&home, pre_restore_seq, None).unwrap();
        assert_eq!(
            fs::read_to_string(charminal(&home).join("config.json")).unwrap(),
            "{\"v\":2}"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_full_mirror_removes_extra_pack_and_files() {
        let home = tmp_home("restore-extra");
        seed_pack(&home, "foo", "effect.js", "v1");
        fs::write(charminal(&home).join("config.json"), "{\"a\":1}").unwrap();
        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();

        seed_pack(&home, "foo", "old.js", "old");
        seed_pack(&home, "bad", "effect.js", "boom");
        fs::write(charminal(&home).join("packs/foo/effect.js"), "v2-broken").unwrap();
        fs::write(charminal(&home).join("config.json"), "{\"a\":2}").unwrap();
        snapshot_restore_impl(&home, seq, None).unwrap();

        assert!(!charminal(&home).join("packs/bad").exists());
        assert!(!charminal(&home).join("packs/foo/old.js").exists());
        assert_eq!(
            fs::read_to_string(charminal(&home).join("packs/foo/effect.js")).unwrap(),
            "v1"
        );
        assert_eq!(
            fs::read_to_string(charminal(&home).join("config.json")).unwrap(),
            "{\"a\":1}"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_preserves_pack_git_directory() {
        let home = tmp_home("restore-git");
        seed_pack(&home, "foo", "effect.js", "v1");
        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();

        fs::create_dir_all(charminal(&home).join("packs/foo/.git/objects")).unwrap();
        fs::write(charminal(&home).join("packs/foo/.git/config"), "repo").unwrap();
        seed_pack(&home, "foo", "extra.js", "extra");
        snapshot_restore_impl(&home, seq, Some(vec!["packs/foo".to_string()])).unwrap();

        assert!(charminal(&home).join("packs/foo/.git/config").exists());
        assert!(!charminal(&home).join("packs/foo/extra.js").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_resolves_path_type_conflicts() {
        let home = tmp_home("restore-conflict");
        seed_pack(&home, "foo", "effect.js", "real");
        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();

        fs::remove_file(charminal(&home).join("packs/foo/effect.js")).unwrap();
        fs::create_dir_all(charminal(&home).join("packs/foo/effect.js")).unwrap();
        fs::write(charminal(&home).join("packs/foo/effect.js/inner"), "x").unwrap();
        snapshot_restore_impl(&home, seq, None).unwrap();

        let p = charminal(&home).join("packs/foo/effect.js");
        assert!(p.is_file());
        assert_eq!(fs::read_to_string(&p).unwrap(), "real");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_resolves_nested_ancestor_conflict() {
        let home = tmp_home("restore-nested-conflict");
        seed_pack(&home, "foo", "assets/a.png", "img");
        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();

        fs::remove_dir_all(charminal(&home).join("packs/foo")).unwrap();
        fs::write(charminal(&home).join("packs/foo"), "oops-file").unwrap();
        snapshot_restore_impl(&home, seq, None).unwrap();

        assert!(charminal(&home).join("packs/foo").is_dir());
        assert_eq!(
            fs::read_to_string(charminal(&home).join("packs/foo/assets/a.png")).unwrap(),
            "img"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_partial_scope_only_touches_given_path() {
        let home = tmp_home("restore-partial");
        seed_pack(&home, "foo", "effect.js", "v1");
        fs::write(charminal(&home).join("config.json"), "orig").unwrap();
        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();

        fs::write(charminal(&home).join("packs/foo/effect.js"), "v2").unwrap();
        fs::write(charminal(&home).join("config.json"), "changed").unwrap();
        snapshot_restore_impl(&home, seq, Some(vec!["packs".to_string()])).unwrap();

        assert_eq!(
            fs::read_to_string(charminal(&home).join("packs/foo/effect.js")).unwrap(),
            "v1"
        );
        assert_eq!(
            fs::read_to_string(charminal(&home).join("config.json")).unwrap(),
            "changed"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_deletes_top_level_files_absent_from_target() {
        let home = tmp_home("restore-top-level-delete");
        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();

        fs::write(charminal(&home).join("config.json"), "{}").unwrap();
        fs::write(charminal(&home).join("init.js"), "// init").unwrap();
        snapshot_restore_impl(&home, seq, None).unwrap();

        assert!(!charminal(&home).join("config.json").exists());
        assert!(!charminal(&home).join("init.js").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_rejects_disallowed_paths() {
        let home = tmp_home("restore-guard");
        fs::write(charminal(&home).join("config.json"), "{}").unwrap();
        fs::create_dir_all(charminal(&home).join("journal")).unwrap();
        fs::write(charminal(&home).join("journal/memo.md"), "keep").unwrap();
        let seq = snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();

        for bad in [
            ".history",
            ".staging",
            "tmp",
            "journal",
            "memories.md",
            "sdk.d.ts",
            "last-startup.json",
            "packs/foo/.git/config",
            "..",
            "/etc",
        ] {
            let r = snapshot_restore_impl(&home, seq, Some(vec![bad.to_string()]));
            assert!(r.is_err(), "should reject {}", bad);
        }
        assert!(charminal(&home).join("journal/memo.md").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn prune_is_noop_but_list_limits_results() {
        let home = tmp_home("prune");
        fs::write(charminal(&home).join("config.json"), "{}").unwrap();
        for _ in 0..5 {
            snapshot_create_impl(&home, "sdk:snapshot", None).unwrap();
        }
        snapshot_prune_impl(&home, 2).unwrap();

        let repo = repo(&home);
        assert_eq!(revwalk_oids(&repo).unwrap().len(), 5);
        let list = snapshot_list_impl(&home).unwrap();
        assert_eq!(list.len(), 5);

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn is_last_startup_clean_reflects_load_results() {
        let home = tmp_home("startup-clean");
        assert_eq!(is_last_startup_clean(&home), None);
        fs::write(
            charminal(&home).join("last-startup.json"),
            r#"{"loadResults":[{"id":"a","kind":"effect","status":"loaded"},{"id":"b","kind":"persona","status":"failed"}]}"#,
        )
        .unwrap();
        assert_eq!(is_last_startup_clean(&home), Some(false));
        fs::write(
            charminal(&home).join("last-startup.json"),
            r#"{"loadResults":[{"id":"a","kind":"effect","status":"loaded"}]}"#,
        )
        .unwrap();
        assert_eq!(is_last_startup_clean(&home), Some(true));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn tag_startup_clean_sets_note_on_matching_seq() {
        let home = tmp_home("tag-clean");
        fs::write(charminal(&home).join("config.json"), "{}").unwrap();
        let seq = snapshot_create_impl(&home, "startup-baseline", None).unwrap();
        assert_eq!(snapshot_list_impl(&home).unwrap()[0].startup_clean, None);

        tag_startup_clean(&home, seq, true).unwrap();
        assert_eq!(
            snapshot_list_impl(&home).unwrap()[0].startup_clean,
            Some(true)
        );
        tag_startup_clean(&home, 999, false).unwrap();

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn concurrent_snapshot_creates_get_unique_seqs() {
        let home = std::sync::Arc::new(tmp_home("concurrent"));
        fs::write(charminal(&home).join("config.json"), "{}").unwrap();

        let mut handles = Vec::new();
        for _ in 0..8 {
            let home = home.clone();
            handles.push(std::thread::spawn(move || {
                snapshot_create_impl(&home, "sdk:snapshot", None).unwrap()
            }));
        }
        let mut seqs: Vec<u64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        seqs.sort_unstable();
        let unique = {
            let mut s = seqs.clone();
            s.dedup();
            s.len()
        };
        assert_eq!(unique, 8, "all seqs unique: {:?}", seqs);
        assert_eq!(snapshot_list_impl(&home).unwrap().len(), 8);

        let _ = fs::remove_dir_all(home.as_path());
    }
}
