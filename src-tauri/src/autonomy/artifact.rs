//! Publish a stable review copy from verified Git objects, never mutable worktree
//! files. The destination is outside the coding sandbox's writable repository.
use git2::{ObjectType, Oid, Repository};
use std::collections::BTreeSet;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

const MAX_FILES: usize = 20_000;
const MAX_ENTRIES: usize = 40_000;
const MAX_BYTES: usize = 256 * 1024 * 1024;
const MAX_BLOB_BYTES: usize = 32 * 1024 * 1024;
const MAX_TREE_BYTES: usize = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 64;

struct ArtifactFile {
    path: PathBuf,
    bytes: Vec<u8>,
    executable: bool,
}

#[derive(Default)]
struct Export {
    files: Vec<ArtifactFile>,
    directories: Vec<PathBuf>,
    bytes: usize,
    entries: usize,
}

/// Export the exact verified tree into `job/review-artifact` without replacing
/// any existing destination. A failed export never exposes a partial artifact.
pub fn export_verified_tree(
    repository: &Path,
    job: &Path,
    verified_tree: &str,
) -> Result<PathBuf, String> {
    let repository = checked_directory(repository)?;
    let job = checked_directory(job)?;
    if job.starts_with(&repository) {
        return Err("レビュー用の成果物は作業コピーの外に保存する必要があります".into());
    }
    let destination = job.join("review-artifact");
    if fs::symlink_metadata(&destination).is_ok() {
        return Err("レビュー用の成果物はすでに存在します。上書きしません".into());
    }
    let repo = Repository::open(&repository).map_err(|e| format!("作業コピーを開けません: {e}"))?;
    if repo
        .workdir()
        .and_then(|path| path.canonicalize().ok())
        .as_ref()
        != Some(&repository)
    {
        return Err("作業コピーのGitルートが一致しません".into());
    }
    let oid = Oid::from_str(verified_tree).map_err(|_| "検証済みツリーの識別子が不正です")?;
    let mut export = Export::default();
    collect_tree(&repo, oid, Path::new(""), 0, &mut export)?;

    // Build only after the complete object graph has passed validation. This
    // private staging directory is also outside the model's writable scope.
    let staged = tempfile::Builder::new()
        .prefix(".review-artifact-")
        .tempdir_in(&job)
        .map_err(|e| format!("成果物の保存先を作れません: {e}"))?;
    let mut directories = BTreeSet::new();
    directories.insert(staged.path().to_path_buf());
    for directory in export.directories {
        let path = staged.path().join(directory);
        fs::create_dir_all(&path).map_err(|e| format!("成果物のフォルダを作れません: {e}"))?;
        directories.insert(path);
    }
    for entry in export.files {
        let path = staged.path().join(entry.path);
        let parent = path.parent().ok_or("成果物のパスが不正です")?;
        fs::create_dir_all(parent).map_err(|e| format!("成果物のフォルダを作れません: {e}"))?;
        let mut ancestor = parent;
        while ancestor.starts_with(staged.path()) {
            directories.insert(ancestor.to_path_buf());
            let Some(next) = ancestor.parent() else { break };
            ancestor = next;
        }
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(if entry.executable { 0o755 } else { 0o644 });
            options.custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options
            .open(path)
            .map_err(|e| format!("成果物を作れません: {e}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(if entry.executable {
                0o755
            } else {
                0o644
            }))
            .map_err(|e| format!("成果物の属性を保存できません: {e}"))?;
        }
        file.write_all(&entry.bytes)
            .map_err(|e| format!("成果物を書き込めません: {e}"))?;
        file.sync_all()
            .map_err(|e| format!("成果物を保存できません: {e}"))?;
    }
    for directory in directories.iter().rev() {
        File::open(directory)
            .and_then(|file| file.sync_all())
            .map_err(|e| format!("成果物のフォルダを保存できません: {e}"))?;
    }
    publish_without_replace(staged.path(), &destination)?;
    // The successful rename moved all completed files at once. TempDir cleanup
    // now sees an absent staging path and cannot delete the published artifact.
    File::open(&job)
        .and_then(|file| file.sync_all())
        .map_err(|e| format!("成果物は作成しましたが保存先の同期に失敗しました: {e}"))?;
    Ok(destination)
}

fn checked_directory(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("成果物の保存先は絶対パスで指定してください".into());
    }
    let mut cursor = PathBuf::new();
    for component in path.components() {
        match component {
            Component::RootDir | Component::Normal(_) => cursor.push(component),
            _ => return Err("成果物の保存先に相対参照は使用できません".into()),
        }
        let metadata =
            fs::symlink_metadata(&cursor).map_err(|e| format!("保存先を確認できません: {e}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("成果物の保存先にリンクは使用できません".into());
        }
    }
    path.canonicalize()
        .map_err(|e| format!("保存先を確認できません: {e}"))
}

fn collect_tree(
    repo: &Repository,
    oid: Oid,
    prefix: &Path,
    depth: usize,
    export: &mut Export,
) -> Result<(), String> {
    if depth > MAX_DEPTH {
        return Err("成果物のフォルダ階層が深すぎます".into());
    }
    // Parse the verified bytes themselves: rereading the tree by OID after the
    // hash check would reopen a race with a corrupted/mutating object database.
    let tree = verified_object(repo, oid, ObjectType::Tree, MAX_TREE_BYTES)?;
    let mut names = BTreeSet::new();
    let mut cursor = 0;
    while cursor < tree.len() {
        let mode_end = tree[cursor..]
            .iter()
            .position(|byte| *byte == b' ')
            .map(|offset| cursor + offset)
            .ok_or("Gitツリーの形式が不正です")?;
        let mode = std::str::from_utf8(&tree[cursor..mode_end])
            .ok()
            .and_then(|mode| u32::from_str_radix(mode, 8).ok())
            .ok_or("Gitツリーの形式が不正です")?;
        let name_start = mode_end + 1;
        let name_end = tree[name_start..]
            .iter()
            .position(|byte| *byte == 0)
            .map(|offset| name_start + offset)
            .ok_or("Gitツリーの形式が不正です")?;
        let oid_start = name_end + 1;
        let oid_end = oid_start
            .checked_add(20)
            .filter(|end| *end <= tree.len())
            .ok_or("Gitツリーの識別子が不正です")?;
        let entry_oid = Oid::from_bytes(&tree[oid_start..oid_end]).map_err(|e| e.to_string())?;
        cursor = oid_end;
        export.entries += 1;
        if export.entries > MAX_ENTRIES {
            return Err("成果物の項目数が上限を超えています".into());
        }
        let name = std::str::from_utf8(&tree[name_start..name_end])
            .map_err(|_| "成果物の名前を読み取れません")?;
        validate_name(name)?;
        if !names.insert(name.to_owned()) {
            return Err("成果物に重複する名前があります".into());
        }
        let relative = prefix.join(name);
        match mode {
            0o040000 => {
                export.directories.push(relative.clone());
                collect_tree(repo, entry_oid, &relative, depth + 1, export)?;
            }
            mode @ (0o100644 | 0o100755) => {
                if export.files.len() >= MAX_FILES {
                    return Err("成果物のファイル数が上限を超えています".into());
                }
                let remaining = MAX_BYTES.saturating_sub(export.bytes);
                let bytes = verified_object(
                    repo,
                    entry_oid,
                    ObjectType::Blob,
                    remaining.min(MAX_BLOB_BYTES),
                )?;
                export.bytes += bytes.len();
                export.files.push(ArtifactFile {
                    path: relative,
                    bytes,
                    executable: mode == 0o100755,
                });
            }
            _ => {
                return Err(
                    "成果物にリンク・サブモジュール・未対応のファイルが含まれています".into(),
                )
            }
        }
    }
    Ok(())
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty()
        || name == "."
        || name == ".."
        || name.eq_ignore_ascii_case(".git")
        || name
            .chars()
            .any(|ch| ch.is_control() || ch == '/' || ch == '\\')
    {
        return Err("成果物に安全に保存できない名前が含まれています".into());
    }
    Ok(())
}

fn verified_object(
    repo: &Repository,
    oid: Oid,
    kind: ObjectType,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    let database = repo.odb().map_err(|e| e.to_string())?;
    let (size, actual_kind) = database
        .read_header(oid)
        .map_err(|e| format!("Gitオブジェクトを確認できません: {e}"))?;
    if actual_kind != kind || size > maximum {
        return Err("成果物のサイズまたはGitオブジェクトの形式が上限を超えています".into());
    }
    let object = database
        .read(oid)
        .map_err(|e| format!("Gitオブジェクトを読み取れません: {e}"))?;
    if object.kind() != kind
        || object.data().len() > maximum
        || Oid::hash_object(kind, object.data()).map_err(|e| e.to_string())? != oid
    {
        return Err("検証済みGitオブジェクトの内容が一致しません".into());
    }
    Ok(object.data().to_vec())
}

fn publish_without_replace(source: &Path, destination: &Path) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let source = CString::new(source.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        let destination =
            CString::new(destination.as_os_str().as_bytes()).map_err(|e| e.to_string())?;
        #[cfg(target_os = "macos")]
        let result = unsafe {
            libc::renameatx_np(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_EXCL,
            )
        };
        #[cfg(target_os = "linux")]
        let result = unsafe {
            libc::renameat2(
                libc::AT_FDCWD,
                source.as_ptr(),
                libc::AT_FDCWD,
                destination.as_ptr(),
                libc::RENAME_NOREPLACE,
            )
        };
        if result != 0 {
            return Err(format!(
                "既存の成果物は置き換えず、保存を停止しました: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        let _ = (source, destination);
        Err("この環境では成果物を安全に確定できません".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (tempfile::TempDir, Repository, PathBuf, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let base = directory.path().canonicalize().unwrap();
        let repository = base.join("repository");
        let job = base.join("job");
        fs::create_dir(&job).unwrap();
        let repo = Repository::init(&repository).unwrap();
        (directory, repo, repository, job)
    }

    fn tree(repo: &Repository, name: &str, contents: &[u8], mode: i32) -> Oid {
        let blob = repo.blob(contents).unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder.insert(name, blob, mode).unwrap();
        builder.write().unwrap()
    }

    #[test]
    fn artifact_uses_recorded_tree_even_when_worktree_changes_before_and_after_export() {
        let (_directory, repo, source, job) = fixture();
        let verified = tree(&repo, "note.md", b"verified contents\n", 0o100644);
        fs::write(source.join("note.md"), "unverified edit before export").unwrap();
        let artifact = export_verified_tree(&source, &job, &verified.to_string()).unwrap();
        fs::write(
            source.join("note.md"),
            "detached child edited after verification",
        )
        .unwrap();
        assert_eq!(
            fs::read(artifact.join("note.md")).unwrap(),
            b"verified contents\n"
        );
        assert_eq!(
            fs::read_to_string(source.join("note.md")).unwrap(),
            "detached child edited after verification"
        );
        assert!(!artifact.join(".git").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_ne!(
                fs::metadata(source.join("note.md")).unwrap().ino(),
                fs::metadata(artifact.join("note.md")).unwrap().ino()
            );
        }
    }

    #[test]
    fn links_and_gitlinks_are_rejected_without_partial_artifact() {
        let (_directory, repo, source, job) = fixture();
        let link = tree(&repo, "outside", b"/outside/secret", 0o120000);
        assert!(export_verified_tree(&source, &job, &link.to_string()).is_err());
        let empty = repo.treebuilder(None).unwrap().write().unwrap();
        let signature = git2::Signature::now("Test", "test@example.invalid").unwrap();
        let commit = repo
            .commit(
                None,
                &signature,
                &signature,
                "fixture",
                &repo.find_tree(empty).unwrap(),
                &[],
            )
            .unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder.insert("module", commit, 0o160000).unwrap();
        let gitlink = builder.write().unwrap();
        assert!(export_verified_tree(&source, &job, &gitlink.to_string()).is_err());
        assert_eq!(fs::read_dir(&job).unwrap().count(), 0);
    }

    #[test]
    fn no_overwrite_or_partial_success_and_nested_regular_files_are_supported() {
        let (_directory, repo, source, job) = fixture();
        let child = tree(&repo, "check.sh", b"#!/bin/sh\nexit 0\n", 0o100755);
        let mut builder = repo.treebuilder(None).unwrap();
        builder.insert("scripts", child, 0o040000).unwrap();
        let root = builder.write().unwrap();
        let artifact = export_verified_tree(&source, &job, &root.to_string()).unwrap();
        assert!(artifact.join("scripts/check.sh").is_file());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_ne!(
                fs::metadata(artifact.join("scripts/check.sh"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o111,
                0
            );
        }
        fs::write(artifact.join("marker"), "keep").unwrap();
        assert!(export_verified_tree(&source, &job, &root.to_string()).is_err());
        assert_eq!(fs::read_to_string(artifact.join("marker")).unwrap(), "keep");
        assert_eq!(fs::read_dir(&job).unwrap().count(), 1);
    }

    #[test]
    fn names_object_bounds_and_nested_destination_are_rejected() {
        let (_directory, repo, source, job) = fixture();
        for name in ["", ".", "..", ".git", ".GIT", "a/b", "a\\b", "line\nbreak"] {
            assert!(validate_name(name).is_err());
        }
        let blob = repo.blob(b"12345").unwrap();
        assert!(verified_object(&repo, blob, ObjectType::Blob, 4).is_err());
        assert!(verified_object(&repo, blob, ObjectType::Tree, 10).is_err());
        assert!(export_verified_tree(&source, &job, "not an oid").is_err());
        let verified = tree(&repo, "note.md", b"text", 0o100644);
        let inside = source.join("output");
        fs::create_dir(&inside).unwrap();
        assert!(export_verified_tree(&source, &inside, &verified.to_string()).is_err());
        assert_eq!(fs::read_dir(&job).unwrap().count(), 0);
        assert_eq!(fs::read_dir(inside).unwrap().count(), 0);
    }

    #[test]
    fn no_replace_publish_rejects_destination_created_after_preflight() {
        let (_directory, _repo, _source, job) = fixture();
        let staged = tempfile::tempdir_in(&job).unwrap();
        fs::write(staged.path().join("new"), "new").unwrap();
        let destination = job.join("review-artifact");
        fs::create_dir(&destination).unwrap();
        assert!(publish_without_replace(staged.path(), &destination).is_err());
        assert_eq!(fs::read_dir(&destination).unwrap().count(), 0);
        assert_eq!(
            fs::read_to_string(staged.path().join("new")).unwrap(),
            "new"
        );
    }

    #[test]
    fn failed_file_creation_removes_staging_and_never_exposes_partial_artifact() {
        let (_directory, repo, source, job) = fixture();
        let blob = repo.blob(b"data").unwrap();
        let mut builder = repo.treebuilder(None).unwrap();
        builder.insert("a.md", blob, 0o100644).unwrap();
        builder.insert("z".repeat(300), blob, 0o100644).unwrap();
        let tree = builder.write().unwrap();
        assert!(export_verified_tree(&source, &job, &tree.to_string()).is_err());
        assert_eq!(fs::read_dir(&job).unwrap().count(), 0);
        assert!(!source.join("a.md").exists());
    }
}
