//! New autonomous repository writes belong to a registered linked worktree.
//! This only inspects Git metadata; it never creates branches or changes files.
use git2::{ErrorCode, Repository};
use std::io::Read;
use std::path::{Path, PathBuf};

pub(super) const WORKTREE_REQUIRED: &str = "worktree_required";

fn invalid<T>() -> Result<T, String> {
    Err(WORKTREE_REQUIRED.into())
}

fn canonical(path: &Path) -> Result<PathBuf, String> {
    path.canonicalize().map_err(|_| WORKTREE_REQUIRED.into())
}

fn metadata_text(path: &Path) -> Result<String, String> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| WORKTREE_REQUIRED)?;
    if !metadata.file_type().is_file() || metadata.len() > 4096 {
        return invalid();
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| WORKTREE_REQUIRED)?;
    if !file.metadata().map_err(|_| WORKTREE_REQUIRED)?.is_file() {
        return invalid();
    }
    let mut text = String::new();
    file.take(4097)
        .read_to_string(&mut text)
        .map_err(|_| WORKTREE_REQUIRED)?;
    if text.len() > 4096 || text.contains('\0') || text.trim().is_empty() {
        return invalid();
    }
    Ok(text)
}

fn has_git_marker(cwd: &Path) -> Result<bool, String> {
    for parent in cwd.ancestors() {
        match std::fs::symlink_metadata(parent.join(".git")) {
            Ok(_) => return Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return invalid(),
        }
    }
    Ok(false)
}

pub(super) fn validate_write_scope(cwd: &Path, write: bool) -> Result<(), String> {
    if !write {
        return Ok(());
    }
    let cwd = canonical(cwd)?;
    let repo = match Repository::discover(&cwd) {
        Ok(repo) => repo,
        Err(error) if error.code() == ErrorCode::NotFound && !has_git_marker(&cwd)? => {
            // Explicitly granted ordinary notes folders remain usable.
            return Ok(());
        }
        Err(_) => return invalid(),
    };
    if !repo.is_worktree() || repo.is_bare() {
        return invalid();
    }
    let workdir = canonical(repo.workdir().ok_or(WORKTREE_REQUIRED)?)?;
    if !cwd.starts_with(&workdir) {
        return invalid();
    }
    let gitdir = canonical(repo.path())?;
    let common_text = metadata_text(&gitdir.join("commondir"))?;
    let common = canonical(&gitdir.join(common_text.trim()))?;
    let name = gitdir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(WORKTREE_REQUIRED)?;
    let registration = common.join("worktrees").join(name);
    if registration != gitdir || canonical(&registration)? != gitdir {
        return invalid();
    }
    let names = repo.worktrees().map_err(|_| WORKTREE_REQUIRED)?;
    if !names.iter().any(|registered| registered == Some(name)) {
        return invalid();
    }
    let registered = repo.find_worktree(name).map_err(|_| WORKTREE_REQUIRED)?;
    registered.validate().map_err(|_| WORKTREE_REQUIRED)?;
    if canonical(registered.path())? != workdir {
        return invalid();
    }
    // Check both directions: a copied .git pointer must not authorize a sibling
    // directory, and a stale registration must not redirect a legitimate tree.
    let gitlink = workdir.join(".git");
    let link = metadata_text(&gitlink)?;
    let target = link
        .trim()
        .strip_prefix("gitdir:")
        .ok_or(WORKTREE_REQUIRED)?;
    if canonical(&workdir.join(target.trim()))? != gitdir {
        return invalid();
    }
    let backlink = metadata_text(&gitdir.join("gitdir"))?;
    if canonical(&gitdir.join(backlink.trim()))? != canonical(&gitlink)? {
        return invalid();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repository(path: &Path) -> Repository {
        let repo = Repository::init(path).unwrap();
        let tree_id = repo.index().unwrap().write_tree().unwrap();
        let signature = git2::Signature::now("fixture", "fixture@example.invalid").unwrap();
        {
            let tree = repo.find_tree(tree_id).unwrap();
            repo.commit(Some("HEAD"), &signature, &signature, "initial", &tree, &[])
                .unwrap();
        }
        repo
    }

    #[test]
    fn primary_checkout_and_subdirectory_are_read_only_but_notes_remain_writable() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("Primary Repo");
        let _repo = repository(&root);
        let nested = root.join("src");
        std::fs::create_dir(&nested).unwrap();
        for path in [&root, &nested] {
            assert_eq!(
                validate_write_scope(path, true).unwrap_err(),
                WORKTREE_REQUIRED
            );
            assert!(validate_write_scope(path, false).is_ok());
        }
        let notes = temp.path().join("Notes");
        std::fs::create_dir(&notes).unwrap();
        assert!(validate_write_scope(&notes, true).is_ok());
    }

    #[test]
    fn registered_linked_worktree_and_its_subdirectory_accept_explicit_write_grants() {
        let temp = tempfile::tempdir().unwrap();
        let repo = repository(&temp.path().join("Primary Repo"));
        let linked = temp.path().join("Linked Tree With Spaces");
        repo.worktree("fixture", &linked, None).unwrap();
        let nested = linked.join("src");
        std::fs::create_dir(&nested).unwrap();
        assert!(validate_write_scope(&linked, true).is_ok());
        assert!(validate_write_scope(&nested, true).is_ok());
        assert!(validate_write_scope(&linked, false).is_ok());
    }

    #[test]
    fn copied_pointer_and_broken_registration_fail_closed_without_changing_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let repo = repository(&temp.path().join("Primary"));
        let linked = temp.path().join("Linked");
        repo.worktree("fixture", &linked, None).unwrap();
        let pointer = std::fs::read(linked.join(".git")).unwrap();
        let spoof = temp.path().join("Spoof");
        std::fs::create_dir(&spoof).unwrap();
        std::fs::write(spoof.join(".git"), &pointer).unwrap();
        assert!(validate_write_scope(&spoof, true).is_err());
        let backlink = repo.path().join("worktrees/fixture/gitdir");
        std::fs::write(&backlink, spoof.join(".git").to_str().unwrap()).unwrap();
        let before = std::fs::read(&backlink).unwrap();
        assert!(validate_write_scope(&linked, true).is_err());
        assert_eq!(std::fs::read(&backlink).unwrap(), before);
        assert_eq!(std::fs::read(linked.join(".git")).unwrap(), pointer);
    }

    #[test]
    fn malformed_git_marker_and_separate_primary_git_directory_are_not_notes_folders() {
        let temp = tempfile::tempdir().unwrap();
        let broken = temp.path().join("Broken");
        std::fs::create_dir(&broken).unwrap();
        std::fs::write(broken.join(".git"), "gitdir: missing\n").unwrap();
        assert!(validate_write_scope(&broken, true).is_err());
        assert!(validate_write_scope(&broken, false).is_ok());
        let root = temp.path().join("Separate Primary");
        let repo = repository(&root);
        let gitdir = repo.path().to_path_buf();
        drop(repo);
        let separate = temp.path().join("metadata.git");
        std::fs::rename(&gitdir, &separate).unwrap();
        std::fs::write(
            root.join(".git"),
            format!("gitdir: {}\n", separate.display()),
        )
        .unwrap();
        assert!(validate_write_scope(&root, true).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_git_pointer_is_not_an_accepted_registration() {
        let temp = tempfile::tempdir().unwrap();
        let repo = repository(&temp.path().join("Primary"));
        let linked = temp.path().join("Linked");
        repo.worktree("fixture", &linked, None).unwrap();
        let saved = temp.path().join("pointer");
        std::fs::rename(linked.join(".git"), &saved).unwrap();
        std::os::unix::fs::symlink(&saved, linked.join(".git")).unwrap();
        assert!(validate_write_scope(&linked, true).is_err());
    }
}
