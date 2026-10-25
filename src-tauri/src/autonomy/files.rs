//! Bounded document workspace and durable, conflict-aware undo for autonomous work.
//!
//! The worker never receives filesystem access. This broker accepts only document
//! operations in one explicitly chosen directory. A journal is flushed before any
//! mutation. Unix directory descriptors and no-follow opens prevent path/symlink
//! escapes; replacing a file atomically exchanges it with a staging file so even
//! an edit racing the final comparison is retained rather than overwritten.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, File};
#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Mutex;

const MAX_FILES: usize = 64;
const MAX_FILE_BYTES: usize = 64 * 1024;
const MAX_TOTAL_BYTES: usize = 256 * 1024;
const MAX_OPERATIONS: usize = 32;
const MAX_ENTRIES: usize = 4096;
const MAX_DEPTH: usize = 12;
const MAX_JOURNAL_BYTES: u64 = 2 * 1024 * 1024;
static MUTATIONS: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FileEntry {
    pub path: String,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSnapshot {
    pub files: Vec<FileEntry>,
    /// Excluded entries; an excluded directory counts once, not once per child.
    pub omitted: usize,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Write { path: String, content: String },
    Move { path: String, destination: String },
    Trash { path: String },
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Image {
    content: String,
    mode: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct Change {
    path: String,
    before: Option<Image>,
    after: Option<Image>,
    /// Original metadata source for the new live file. A move carries the
    /// source's restrictions to its destination, including inherited ACLs.
    metadata_source: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Prepared,
    Applied,
    Undoing,
    Undone,
    Conflict,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u32,
    root: PathBuf,
    device: u64,
    inode: u64,
    operations: Vec<Operation>,
    changes: Vec<Change>,
    phase: Phase,
}

fn error(context: &str, error: impl std::fmt::Display) -> String {
    format!("{context}: {error}")
}

fn valid_document(path: &str) -> bool {
    let p = Path::new(path);
    if path.is_empty()
        || path.contains('\\')
        || path.contains('\0')
        || path.chars().any(char::is_control)
        || path.len() > 1024
        || !p.components().all(|c| match c {
            Component::Normal(s) => s
                .to_str()
                .is_some_and(|s| !s.starts_with('.') && !excluded_directory(s) && s.len() <= 240),
            _ => false,
        })
    {
        return false;
    }
    let name = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if matches!(
        name.to_ascii_lowercase().as_str(),
        "agents.md" | "claude.md" | "gemini.md" | "copilot-instructions.md" | "skill.md"
    ) {
        return false;
    }
    matches!(
        p.extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "txt" | "md" | "markdown" | "rst" | "csv" | "tsv" | "log"
    )
}

fn excluded_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        "node_modules" | "target" | "vendor" | "build" | "dist" | "__pycache__"
    )
}

fn valid_content(content: &str) -> bool {
    content.len() <= MAX_FILE_BYTES
        && !content.contains('\0')
        && !content
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
}

/// Resolve the selected directory once. Root/home and Yorishiro's own state are
/// never valid autonomous workspaces. Symlink selections are not followed.
pub fn validate_root(root: &str) -> Result<PathBuf, String> {
    if root.is_empty() {
        return Err("Choose a document folder first".into());
    }
    let path = Path::new(root);
    if !path.is_absolute() {
        return Err("The document folder must be an absolute path".into());
    }
    let meta = fs::symlink_metadata(path).map_err(|e| error("Open document folder", e))?;
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return Err("The document folder must be a real directory, not a symbolic link".into());
    }
    let selected = secure::Directory::open_without_links(path)?;
    let canonical = path
        .canonicalize()
        .map_err(|e| error("Resolve document folder", e))?;
    if selected.identity()? != secure::Directory::open_without_links(&canonical)?.identity()? {
        return Err("The selected document folder changed while it was being opened".into());
    }
    if canonical.parent().is_none() {
        return Err("The filesystem root cannot be an autonomous workspace".into());
    }
    if let Some(home) = dirs::home_dir() {
        let home = home.canonicalize().unwrap_or(home);
        let state = home.join(".yorishiro");
        if canonical == home || canonical.starts_with(&state) || state.starts_with(&canonical) {
            return Err("Choose a specific document folder outside Yorishiro's own state".into());
        }
    }
    // This first version deliberately requires the atomic/no-follow operations
    // implemented below. Never silently downgrade to path-based writes.
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    return Err("Autonomous document operations require macOS or Linux".into());
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    Ok(canonical)
}

pub fn snapshot(root: &Path) -> Result<WorkspaceSnapshot, String> {
    let canonical = validate_root(root.to_str().ok_or("Invalid document folder")?)?;
    let dir = secure::Directory::open_without_links(&canonical)?;
    let mut result = WorkspaceSnapshot {
        files: Vec::new(),
        omitted: 0,
    };
    let mut total = 0;
    let mut visited = 0;
    collect(&dir, "", 0, &mut visited, &mut total, &mut result)?;
    Ok(result)
}

fn collect(
    dir: &secure::Directory,
    prefix: &str,
    depth: usize,
    visited: &mut usize,
    total: &mut usize,
    out: &mut WorkspaceSnapshot,
) -> Result<(), String> {
    for name in dir.entries()? {
        *visited += 1;
        if *visited > MAX_ENTRIES {
            return Err(
                "This folder has too many entries; choose a smaller document folder".into(),
            );
        }
        let Some(name) = name.to_str() else {
            out.omitted += 1;
            continue;
        };
        if name.starts_with('.') || excluded_directory(name) {
            out.omitted += 1;
            continue;
        }
        let path = if prefix.is_empty() {
            name.to_owned()
        } else {
            format!("{prefix}/{name}")
        };
        if let Ok(child) = dir.child(name) {
            if depth >= MAX_DEPTH {
                out.omitted += 1;
            } else {
                collect(&child, &path, depth + 1, visited, total, out)?;
            }
            continue;
        }
        if !valid_document(&path) {
            out.omitted += 1;
            continue;
        }
        match dir.read(name) {
            Ok(Some(file))
                if out.files.len() < MAX_FILES
                    && *total + file.content.len() <= MAX_TOTAL_BYTES =>
            {
                *total += file.content.len();
                out.files.push(FileEntry {
                    path,
                    content: file.content,
                });
            }
            _ => out.omitted += 1,
        }
    }
    Ok(())
}

fn valid_run_id(run_id: &str) -> Result<(), String> {
    if uuid::Uuid::parse_str(run_id).is_err() {
        return Err("Invalid autonomous run ID".into());
    }
    Ok(())
}

fn store_directory(store: &Path, root: Option<&Path>) -> Result<secure::Directory, String> {
    if !store.is_absolute() {
        return Err("Recovery storage must use an absolute path".into());
    }
    if root.is_some_and(|root| store.starts_with(root) || root.starts_with(store)) {
        return Err("Recovery storage must be separate from the document folder".into());
    }
    let directory = secure::Directory::ensure_without_links(store)?;
    let canonical = store
        .canonicalize()
        .map_err(|e| error("Resolve recovery storage", e))?;
    if let Some(root) = root {
        if canonical.starts_with(root) || root.starts_with(&canonical) {
            return Err("Recovery storage must be separate from the document folder".into());
        }
    }
    // Follow no symlinks through the supplied store path, including ancestors.
    // Canonical paths produced by the host (e.g. /private/var on macOS) work too.
    Ok(directory)
}

fn journal_name(run_id: &str) -> String {
    format!("{run_id}.json")
}

fn recovery_name(run_id: &str, index: usize) -> String {
    format!(".yorishiro-recovery-{run_id}-{index}")
}

fn read_journal(store: &secure::Directory, run_id: &str) -> Result<Option<Journal>, String> {
    let Some(bytes) = store.read_bytes(&journal_name(run_id), MAX_JOURNAL_BYTES)? else {
        return Ok(None);
    };
    let journal: Journal =
        serde_json::from_slice(&bytes).map_err(|e| error("Read recovery journal", e))?;
    if journal.version != 1 || journal.changes.len() > MAX_OPERATIONS * 2 {
        return Err("Unsupported recovery journal".into());
    }
    for change in &journal.changes {
        if !valid_document(&change.path)
            || change
                .metadata_source
                .as_ref()
                .is_some_and(|path| !valid_document(path))
            || change
                .before
                .as_ref()
                .is_some_and(|i| !valid_content(&i.content) || i.mode & !0o666 != 0)
            || change
                .after
                .as_ref()
                .is_some_and(|i| !valid_content(&i.content) || i.mode & !0o666 != 0)
        {
            return Err("Invalid recovery journal content".into());
        }
    }
    Ok(Some(journal))
}

fn write_journal(
    store: &secure::Directory,
    run_id: &str,
    journal: &Journal,
    create: bool,
) -> Result<(), String> {
    let data = serde_json::to_vec(journal).map_err(|e| error("Encode recovery journal", e))?;
    if data.len() as u64 > MAX_JOURNAL_BYTES {
        return Err("Recovery journal exceeds the size limit".into());
    }
    store.write_atomic(&journal_name(run_id), &data, 0o600, create)
}

fn root_matches(root: &secure::Directory, journal: &Journal) -> Result<(), String> {
    if root.identity()? != (journal.device, journal.inode) {
        return Err(
            "The original document folder has been replaced; recovery was not applied".into(),
        );
    }
    Ok(())
}

/// Whether this run has an ordinary restore path. A conflict journal needs
/// manual review of retained versions and is intentionally not advertised as a
/// one-click undo. This query never creates a recovery directory.
pub fn can_undo(store: &Path, run_id: &str) -> bool {
    if valid_run_id(run_id).is_err() {
        return false;
    }
    secure::Directory::open_without_links(store)
        .and_then(|store| read_journal(&store, run_id))
        .ok()
        .flatten()
        .is_some_and(|j| matches!(j.phase, Phase::Prepared | Phase::Applied | Phase::Undoing))
}

fn current(root: &secure::Directory, path: &str) -> Result<Option<Image>, String> {
    let (parent, name) = root.parent(path)?;
    parent.read(&name)
}

fn require_state(
    root: &secure::Directory,
    changes: &[Change],
    allow_before: bool,
) -> Result<(), String> {
    for change in changes {
        let now = current(root, &change.path)?;
        if now != change.after && !(allow_before && now == change.before) {
            return Err(format!(
                "{} has changed since this run; your newer content was preserved",
                change.path
            ));
        }
    }
    Ok(())
}

/// Apply only host-approved operations. An interrupted batch is left recoverable
/// through `undo`; it is never silently replayed or called successful.
pub fn apply(
    root: &Path,
    store: &Path,
    run_id: &str,
    before: &WorkspaceSnapshot,
    operations: &[Operation],
    allowed: &[String],
) -> Result<(), String> {
    let _lock = MUTATIONS
        .lock()
        .map_err(|_| "Document recovery is unavailable")?;
    valid_run_id(run_id)?;
    if operations.is_empty() || operations.len() > MAX_OPERATIONS {
        return Err("A document run must contain between 1 and 32 operations".into());
    }
    let canonical = validate_root(root.to_str().ok_or("Invalid document folder")?)?;
    let root = secure::Directory::open_without_links(&canonical)?;
    let store = store_directory(store, Some(&canonical))?;
    if let Some(journal) = read_journal(&store, run_id)? {
        root_matches(&root, &journal)?;
        if journal.root != canonical || journal.operations != operations {
            return Err("This run ID already belongs to a different operation".into());
        }
        return match journal.phase {
            Phase::Applied => require_state(&root, &journal.changes, false),
            _ => {
                Err("This run already exists; inspect or restore it instead of repeating it".into())
            }
        };
    }
    if before.files.len() > MAX_FILES
        || before.files.iter().map(|f| f.content.len()).sum::<usize>() > MAX_TOTAL_BYTES
    {
        return Err("Invalid document snapshot size".into());
    }
    let mut captured = BTreeMap::new();
    for entry in &before.files {
        if !valid_document(&entry.path)
            || !valid_content(&entry.content)
            || captured
                .insert(entry.path.as_str(), entry.content.as_str())
                .is_some()
        {
            return Err("Invalid document snapshot".into());
        }
    }
    let mut paths = BTreeSet::new();
    let mut changes = Vec::new();
    let mut bytes = 0;
    for operation in operations {
        let (kind, source) = match operation {
            Operation::Write { path, .. } => ("write", path),
            Operation::Move { path, .. } => ("move", path),
            Operation::Trash { path } => ("trash", path),
        };
        if !allowed.iter().any(|a| a == kind) {
            return Err(format!("{kind} is outside the agreed work scope"));
        }
        let image = prepare_path(&root, source, &captured, &mut paths)?;
        match operation {
            Operation::Write { content, .. } => {
                if !valid_content(content) {
                    return Err("Generated content is not a supported bounded text document".into());
                }
                let mode = image.as_ref().map_or(0o600, |i| i.mode);
                let metadata_source = image.as_ref().map(|_| source.clone());
                changes.push(Change {
                    path: source.clone(),
                    before: image,
                    after: Some(Image {
                        content: content.clone(),
                        mode,
                    }),
                    metadata_source,
                });
                bytes += content.len();
            }
            Operation::Move { destination, .. } => {
                let source_image =
                    image.ok_or_else(|| format!("{source} is not in the captured documents"))?;
                let destination_image = prepare_path(&root, destination, &captured, &mut paths)?;
                // Destination creation precedes source retirement. Both are in
                // the durable journal before either mutation occurs.
                changes.push(Change {
                    path: destination.clone(),
                    before: destination_image,
                    after: Some(source_image.clone()),
                    metadata_source: Some(source.clone()),
                });
                changes.push(Change {
                    path: source.clone(),
                    before: Some(source_image),
                    after: None,
                    metadata_source: None,
                });
            }
            Operation::Trash { .. } => {
                if image.is_none() {
                    return Err(format!("{source} is not in the captured documents"));
                }
                changes.push(Change {
                    path: source.clone(),
                    before: image,
                    after: None,
                    metadata_source: None,
                });
            }
        }
    }
    if bytes > MAX_TOTAL_BYTES {
        return Err("This run generates too much content; split it into smaller steps".into());
    }
    let (device, inode) = root.identity()?;
    let mut journal = Journal {
        version: 1,
        root: canonical,
        device,
        inode,
        operations: operations.to_vec(),
        changes,
        phase: Phase::Prepared,
    };
    write_journal(&store, run_id, &journal, true)?;
    for (index, change) in journal.changes.iter().enumerate() {
        if let Err(e) = mutate(
            &root,
            &change.path,
            &change.before,
            &change.after,
            &recovery_name(run_id, index),
            change.metadata_source.as_deref(),
        ) {
            if e.contains("concurrent change") {
                journal.phase = Phase::Conflict;
                let _ = write_journal(&store, run_id, &journal, false);
            }
            return Err(format!("{e}. Run {run_id} retains its recovery journal"));
        }
    }
    require_state(&root, &journal.changes, false)?;
    journal.phase = Phase::Applied;
    write_journal(&store, run_id, &journal, false)
}

fn prepare_path(
    root: &secure::Directory,
    path: &str,
    captured: &BTreeMap<&str, &str>,
    paths: &mut BTreeSet<String>,
) -> Result<Option<Image>, String> {
    if !valid_document(path) {
        return Err(format!("Unsupported document path: {path}"));
    }
    if !paths.insert(path.to_lowercase()) {
        return Err("A run cannot change the same document twice".into());
    }
    let image = current(root, path)?;
    if image.as_ref().map(|i| i.content.as_str()) != captured.get(path).copied() {
        return Err(format!(
            "{path} changed after it was read, or was not included in the snapshot"
        ));
    }
    Ok(image)
}

/// Restore an applied or interrupted run. Preflight the entire set before any
/// restore, and retain the journal indefinitely. Repeated successful undo is safe.
pub fn undo(store: &Path, run_id: &str) -> Result<(), String> {
    let _lock = MUTATIONS
        .lock()
        .map_err(|_| "Document recovery is unavailable")?;
    valid_run_id(run_id)?;
    let store = store_directory(store, None)?;
    let mut journal = read_journal(&store, run_id)?.ok_or("Recovery journal not found")?;
    if journal.phase == Phase::Undone {
        return Ok(());
    }
    if journal.phase == Phase::Conflict {
        return Err(
            "This run preserved a concurrent edit in a recovery file; review it before restoring"
                .into(),
        );
    }
    let canonical = validate_root(journal.root.to_str().ok_or("Invalid recovery folder")?)?;
    let root = secure::Directory::open_without_links(&canonical)?;
    root_matches(&root, &journal)?;
    let interrupted = matches!(journal.phase, Phase::Prepared | Phase::Undoing);
    require_state(&root, &journal.changes, interrupted)?;
    // Check every retained original before restoring any of them. An editor
    // may have saved through an open descriptor after the original was moved;
    // that newer version must remain available for an explicit review.
    for (index, change) in journal.changes.iter().enumerate() {
        if current(&root, &change.path)? == change.before {
            continue;
        }
        if let Some(before) = &change.before {
            let (parent, _) = root.parent(&change.path)?;
            let backup = recovery_name(run_id, index);
            if parent.read(&backup)?.as_ref() != Some(before) {
                return Err(format!("The retained original for {} has changed or is unavailable; review {backup} before restoring", change.path));
            }
        }
    }
    journal.phase = Phase::Undoing;
    write_journal(&store, run_id, &journal, false)?;
    for (index, change) in journal.changes.iter().enumerate().rev() {
        let now = current(&root, &change.path)?;
        if now == change.before {
            continue;
        }
        let (parent, name) = root.parent(&change.path)?;
        if let Err(e) = parent.restore_checked(
            &name,
            &change.after,
            &change.before,
            &recovery_name(run_id, index),
        ) {
            if e.contains("concurrent change") {
                journal.phase = Phase::Conflict;
                let _ = write_journal(&store, run_id, &journal, false);
            }
            return Err(e);
        }
    }
    journal.phase = Phase::Undone;
    write_journal(&store, run_id, &journal, false)
}

fn mutate(
    root: &secure::Directory,
    path: &str,
    expected: &Option<Image>,
    desired: &Option<Image>,
    recovery: &str,
    metadata_source: Option<&str>,
) -> Result<(), String> {
    let (parent, name) = root.parent(path)?;
    if parent.read(&name)? != *expected {
        return Err(format!("{path} changed while this run was being applied"));
    }
    if expected == desired {
        return Ok(());
    }
    let metadata = metadata_source
        .map(|source| {
            let (parent, name) = root.parent(source)?;
            parent.metadata_file(&name)
        })
        .transpose()?;
    parent.replace_checked(&name, expected, desired, recovery, metadata.as_ref())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
mod secure {
    use super::*;
    use std::ffi::{CStr, CString, OsString};
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::{OsStrExt, OsStringExt};
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    pub(super) struct Directory(File);

    fn name(value: &str) -> Result<CString, String> {
        CString::new(value).map_err(|_| "Invalid path component".into())
    }

    #[cfg(target_os = "macos")]
    fn prepare_metadata(file: &File, source: Option<&File>, mode: u32) -> Result<(), String> {
        // libc does not expose Darwin's ACL functions; these signatures are
        // from the SDK's sys/acl.h. The empty ACL clears inherited grants before
        // data is written. fcopyfile then restores the source ACL and xattrs.
        unsafe extern "C" {
            fn acl_init(count: libc::c_int) -> *mut libc::c_void;
            fn acl_set_fd(fd: libc::c_int, acl: *mut libc::c_void) -> libc::c_int;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        }
        let acl = unsafe { acl_init(0) };
        if acl.is_null() {
            return Err(error(
                "Prepare private document ACL",
                std::io::Error::last_os_error(),
            ));
        }
        let result = unsafe { acl_set_fd(file.as_raw_fd(), acl) };
        let acl_error = std::io::Error::last_os_error();
        unsafe {
            acl_free(acl);
        }
        if result != 0 {
            return Err(error("Prepare private document ACL", acl_error));
        }
        let result = if let Some(source) = source {
            // SAFETY: descriptors remain owned for the duration, null state asks
            // copyfile to manage its own state. DATA is deliberately excluded.
            unsafe {
                libc::fcopyfile(
                    source.as_raw_fd(),
                    file.as_raw_fd(),
                    std::ptr::null_mut(),
                    libc::COPYFILE_METADATA,
                )
            }
        } else {
            unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) }
        };
        if result != 0 {
            return Err(error(
                "Preserve original document metadata",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn prepare_metadata(file: &File, source: Option<&File>, mode: u32) -> Result<(), String> {
        let acl_name = CString::new("system.posix_acl_access").expect("literal");
        let result = unsafe { libc::fremovexattr(file.as_raw_fd(), acl_name.as_ptr()) };
        if result != 0 {
            let e = std::io::Error::last_os_error();
            if !matches!(e.raw_os_error(), Some(libc::ENODATA | libc::ENOTSUP)) {
                return Err(error("Prepare private document ACL", e));
            }
        }
        if let Some(source) = source {
            let meta = source
                .metadata()
                .map_err(|e| error("Read document metadata", e))?;
            let attributes =
                unsafe { libc::flistxattr(source.as_raw_fd(), std::ptr::null_mut(), 0) };
            // Linux metadata copying is not part of the initial implementation.
            // Reject extended metadata/ownership rather than weakening it.
            if attributes != 0
                || meta.uid() != unsafe { libc::geteuid() }
                || meta.gid() != unsafe { libc::getegid() }
            {
                return Err(
                    "This document has metadata that this platform cannot preserve safely".into(),
                );
            }
        }
        if unsafe { libc::fchmod(file.as_raw_fd(), mode as libc::mode_t) } != 0 {
            return Err(error(
                "Preserve document permissions",
                std::io::Error::last_os_error(),
            ));
        }
        Ok(())
    }

    impl Directory {
        pub fn open(path: &Path) -> Result<Self, String> {
            let file = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(path)
                .map_err(|e| error("Open directory", e))?;
            Ok(Self(file))
        }

        pub fn open_without_links(path: &Path) -> Result<Self, String> {
            let mut dir = Self::open(Path::new("/"))?;
            for component in path.components() {
                match component {
                    Component::RootDir => (),
                    Component::Normal(part) => {
                        dir = dir.child(part.to_str().ok_or("Invalid recovery storage path")?)?
                    }
                    _ => return Err("Invalid recovery storage path".into()),
                }
            }
            Ok(dir)
        }

        pub fn ensure_without_links(path: &Path) -> Result<Self, String> {
            let mut dir = Self::open(Path::new("/"))?;
            for component in path.components() {
                match component {
                    Component::RootDir => (),
                    Component::Normal(part) => {
                        let part = part.to_str().ok_or("Invalid recovery storage path")?;
                        if dir.child(part).is_err() {
                            let part_c = name(part)?;
                            // SAFETY: creation is relative to an owned descriptor;
                            // an existing symlink is never followed by child().
                            let result =
                                unsafe { libc::mkdirat(dir.0.as_raw_fd(), part_c.as_ptr(), 0o700) };
                            if result != 0
                                && std::io::Error::last_os_error().kind()
                                    != std::io::ErrorKind::AlreadyExists
                            {
                                return Err(error(
                                    "Create recovery storage",
                                    std::io::Error::last_os_error(),
                                ));
                            }
                            dir.sync()?;
                        }
                        dir = dir.child(part)?;
                    }
                    _ => return Err("Invalid recovery storage path".into()),
                }
            }
            Ok(dir)
        }

        pub fn identity(&self) -> Result<(u64, u64), String> {
            let meta = self
                .0
                .metadata()
                .map_err(|e| error("Read folder identity", e))?;
            Ok((meta.dev(), meta.ino()))
        }

        fn open_file(
            &self,
            component: &str,
            flags: i32,
            mode: u32,
        ) -> Result<File, std::io::Error> {
            let component = CString::new(component).map_err(|_| {
                std::io::Error::new(std::io::ErrorKind::InvalidInput, "Invalid file name")
            })?;
            // SAFETY: owned directory descriptor; CString lives through the call.
            let fd = unsafe {
                libc::openat(
                    self.0.as_raw_fd(),
                    component.as_ptr(),
                    flags | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK,
                    mode as libc::c_uint,
                )
            };
            if fd == -1 {
                return Err(std::io::Error::last_os_error());
            }
            // SAFETY: openat returned a newly owned descriptor.
            Ok(unsafe { File::from_raw_fd(fd) })
        }

        pub fn child(&self, component: &str) -> Result<Self, String> {
            self.open_file(component, libc::O_RDONLY | libc::O_DIRECTORY, 0)
                .map(Self)
                .map_err(|e| error("Open document subfolder", e))
        }

        pub fn parent(&self, path: &str) -> Result<(Self, String), String> {
            let mut parts = path.split('/').collect::<Vec<_>>();
            let file = parts.pop().ok_or("Invalid document path")?;
            let mut parent = Self(
                self.0
                    .try_clone()
                    .map_err(|e| error("Open document parent", e))?,
            );
            for part in parts {
                parent = parent.child(part)?;
            }
            Ok((parent, file.to_owned()))
        }

        pub fn entries(&self) -> Result<Vec<OsString>, String> {
            // Open '.' rather than dup: readdir consumes a shared offset on dup.
            let owned = self
                .open_file(".", libc::O_RDONLY | libc::O_DIRECTORY, 0)
                .map_err(|e| error("List documents", e))?;
            use std::os::fd::IntoRawFd;
            let fd = owned.into_raw_fd();
            // SAFETY: fd is transferred to fdopendir (and closed on failure).
            let stream = unsafe { libc::fdopendir(fd) };
            if stream.is_null() {
                unsafe {
                    libc::close(fd);
                }
                return Err(error("List documents", std::io::Error::last_os_error()));
            }
            struct Stream(*mut libc::DIR);
            impl Drop for Stream {
                fn drop(&mut self) {
                    unsafe {
                        libc::closedir(self.0);
                    }
                }
            }
            let stream = Stream(stream);
            let mut entries = Vec::new();
            loop {
                // SAFETY: stream remains alive, returned name is copied before next call.
                let entry = unsafe { libc::readdir(stream.0) };
                if entry.is_null() {
                    break;
                }
                let bytes = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();
                if bytes == b"." || bytes == b".." {
                    continue;
                }
                entries.push(OsString::from_vec(bytes.to_vec()));
                if entries.len() > MAX_ENTRIES {
                    return Err("Document folder contains too many entries".into());
                }
            }
            entries.sort_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
            Ok(entries)
        }

        pub fn read_bytes(&self, component: &str, limit: u64) -> Result<Option<Vec<u8>>, String> {
            let file = match self.open_file(component, libc::O_RDONLY, 0) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(error("Read document", e)),
            };
            let meta = file.metadata().map_err(|e| error("Inspect document", e))?;
            if !meta.is_file() || meta.nlink() != 1 || meta.len() > limit {
                return Err("Only bounded regular files without hard links are supported".into());
            }
            let mut content = Vec::new();
            file.take(limit + 1)
                .read_to_end(&mut content)
                .map_err(|e| error("Read document", e))?;
            if content.len() as u64 > limit {
                return Err("Document exceeds the size limit".into());
            }
            Ok(Some(content))
        }

        pub fn read(&self, component: &str) -> Result<Option<Image>, String> {
            let file = match self.open_file(component, libc::O_RDONLY, 0) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(error("Read document", e)),
            };
            let meta = file.metadata().map_err(|e| error("Inspect document", e))?;
            if !meta.is_file()
                || meta.nlink() != 1
                || meta.len() > MAX_FILE_BYTES as u64
                || meta.mode() & 0o7111 != 0
            {
                return Err("Only bounded, non-executable regular text documents without hard links are supported".into());
            }
            let mut bytes = Vec::new();
            file.take(MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| error("Read document", e))?;
            let content = String::from_utf8(bytes).map_err(|_| "Document is not UTF-8 text")?;
            if !valid_content(&content) {
                return Err("Document is not supported bounded text".into());
            }
            Ok(Some(Image {
                content,
                mode: meta.mode() & 0o666,
            }))
        }

        pub fn metadata_file(&self, component: &str) -> Result<File, String> {
            let file = self
                .open_file(component, libc::O_RDONLY, 0)
                .map_err(|e| error("Open original metadata", e))?;
            let meta = file
                .metadata()
                .map_err(|e| error("Read original metadata", e))?;
            if !meta.is_file() || meta.nlink() != 1 || meta.mode() & 0o7111 != 0 {
                return Err("Original metadata is not from a supported document".into());
            }
            Ok(file)
        }

        fn sync(&self) -> Result<(), String> {
            self.0.sync_all().map_err(|e| error("Flush directory", e))
        }

        fn temporary(&self, bytes: &[u8], mode: u32) -> Result<String, String> {
            let name = format!(".yorishiro-recovery-{}", uuid::Uuid::new_v4());
            self.stage(&name, bytes, mode, None)?;
            Ok(name)
        }

        fn stage(
            &self,
            name: &str,
            bytes: &[u8],
            mode: u32,
            metadata: Option<&File>,
        ) -> Result<(), String> {
            let mut file = self
                .open_file(name, libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL, 0o600)
                .map_err(|e| error("Prepare document", e))?;
            if let Err(e) = (|| {
                // Establish the original access restrictions while this file is
                // still empty, before any document text becomes observable.
                prepare_metadata(&file, metadata, mode)?;
                file.write_all(bytes)
                    .map_err(|e| error("Prepare document", e))?;
                file.sync_all().map_err(|e| error("Flush document", e))?;
                self.sync()
            })() {
                let _ = self.remove(name);
                return Err(e);
            }
            Ok(())
        }

        fn remove(&self, component: &str) -> Result<(), String> {
            let component = name(component)?;
            // SAFETY: unlinkat affects only the directory entry, never follows a link.
            if unsafe { libc::unlinkat(self.0.as_raw_fd(), component.as_ptr(), 0) } != 0 {
                return Err(error(
                    "Remove staging entry",
                    std::io::Error::last_os_error(),
                ));
            }
            self.sync()
        }

        fn rename(&self, from: &str, to: &str, exchange: bool) -> Result<(), String> {
            let from = name(from)?;
            let to = name(to)?;
            #[cfg(target_os = "macos")]
            let result = unsafe {
                libc::renameatx_np(
                    self.0.as_raw_fd(),
                    from.as_ptr(),
                    self.0.as_raw_fd(),
                    to.as_ptr(),
                    if exchange {
                        libc::RENAME_SWAP
                    } else {
                        libc::RENAME_EXCL
                    },
                )
            };
            #[cfg(target_os = "linux")]
            let result = unsafe {
                libc::renameat2(
                    self.0.as_raw_fd(),
                    from.as_ptr(),
                    self.0.as_raw_fd(),
                    to.as_ptr(),
                    if exchange {
                        libc::RENAME_EXCHANGE
                    } else {
                        libc::RENAME_NOREPLACE
                    },
                )
            };
            if result != 0 {
                return Err(error(
                    "Commit document entry",
                    std::io::Error::last_os_error(),
                ));
            }
            self.sync()
        }

        pub fn write_atomic(
            &self,
            component: &str,
            bytes: &[u8],
            mode: u32,
            create: bool,
        ) -> Result<(), String> {
            let temporary = self.temporary(bytes, mode)?;
            let result = self.rename(&temporary, component, !create);
            if result.is_ok() && !create {
                self.remove(&temporary)?;
            }
            if result.is_err() {
                let _ = self.remove(&temporary);
            }
            result
        }

        pub fn replace_checked(
            &self,
            component: &str,
            expected: &Option<Image>,
            desired: &Option<Image>,
            recovery: &str,
            metadata: Option<&File>,
        ) -> Result<(), String> {
            match (expected, desired) {
                (None, Some(desired)) => {
                    let temporary = format!(".yorishiro-recovery-{}", uuid::Uuid::new_v4());
                    self.stage(
                        &temporary,
                        desired.content.as_bytes(),
                        desired.mode,
                        metadata,
                    )?;
                    let result = self.rename(&temporary, component, false);
                    if result.is_err() {
                        let _ = self.remove(&temporary);
                    }
                    result
                }
                (Some(expected), Some(desired)) => {
                    self.stage(recovery, desired.content.as_bytes(), desired.mode, metadata)?;
                    if let Err(e) = self.rename(recovery, component, true) {
                        // If rename succeeded but fsync failed the entry may be
                        // the displaced original. Never delete it on an error.
                        return Err(format!("{e}; staging content retained at {recovery}"));
                    }
                    if self.read(recovery).ok().flatten().as_ref() != Some(expected) {
                        // Both versions still exist. Do not guess which is the
                        // user's latest edit or overwrite either version again.
                        return Err(format!("A concurrent change was preserved at {recovery}; review both versions of {component}"));
                    }
                    // Retain the original inode, including xattrs/ACLs and any
                    // future saves by an editor that still holds it open.
                    Ok(())
                }
                (Some(expected), None) => {
                    self.rename(component, recovery, false)?;
                    if self.read(recovery).ok().flatten().as_ref() != Some(expected) {
                        // Try restoring the newly discovered version without
                        // replacing a file created concurrently at its old name.
                        let _ = self.rename(recovery, component, false);
                        return Err(format!("A concurrent change was preserved at {component} or {recovery}; review before continuing"));
                    }
                    Ok(())
                }
                (None, None) => Ok(()),
            }
        }

        pub fn restore_checked(
            &self,
            component: &str,
            expected: &Option<Image>,
            original: &Option<Image>,
            recovery: &str,
        ) -> Result<(), String> {
            if self.read(component)? != *expected {
                return Err(format!(
                    "{component} changed while the run was being restored"
                ));
            }
            if original.is_some() && self.read(recovery)? != *original {
                return Err(format!(
                    "The retained original at {recovery} has changed; review it before restoring"
                ));
            }
            match (expected, original) {
                (Some(expected), Some(_)) => {
                    self.rename(recovery, component, true)?;
                    if self.read(recovery).ok().flatten().as_ref() != Some(expected) {
                        return Err(format!("A concurrent change was preserved at {recovery}; review both versions of {component}"));
                    }
                    // The displaced live inode is retained too: an editor may
                    // still write to it after undo has completed.
                    Ok(())
                }
                (None, Some(_)) => self.rename(recovery, component, false),
                (Some(expected), None) => {
                    self.rename(component, recovery, false)?;
                    if self.read(recovery).ok().flatten().as_ref() != Some(expected) {
                        return Err(format!("A concurrent change was preserved at {recovery}; review before continuing"));
                    }
                    Ok(())
                }
                (None, None) => Ok(()),
            }
        }
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
mod secure {
    use super::*;
    use std::ffi::OsString;
    pub(super) struct Directory;
    impl Directory {
        pub fn open(_: &Path) -> Result<Self, String> {
            Err("Document recovery is unsupported on this platform".into())
        }
        pub fn open_without_links(path: &Path) -> Result<Self, String> {
            Self::open(path)
        }
        pub fn ensure_without_links(path: &Path) -> Result<Self, String> {
            Self::open(path)
        }
        pub fn identity(&self) -> Result<(u64, u64), String> {
            Err("Unsupported platform".into())
        }
        pub fn child(&self, _: &str) -> Result<Self, String> {
            Err("Unsupported platform".into())
        }
        pub fn parent(&self, _: &str) -> Result<(Self, String), String> {
            Err("Unsupported platform".into())
        }
        pub fn entries(&self) -> Result<Vec<OsString>, String> {
            Err("Unsupported platform".into())
        }
        pub fn read(&self, _: &str) -> Result<Option<Image>, String> {
            Err("Unsupported platform".into())
        }
        pub fn metadata_file(&self, _: &str) -> Result<File, String> {
            Err("Unsupported platform".into())
        }
        pub fn read_bytes(&self, _: &str, _: u64) -> Result<Option<Vec<u8>>, String> {
            Err("Unsupported platform".into())
        }
        pub fn write_atomic(&self, _: &str, _: &[u8], _: u32, _: bool) -> Result<(), String> {
            Err("Unsupported platform".into())
        }
        pub fn replace_checked(
            &self,
            _: &str,
            _: &Option<Image>,
            _: &Option<Image>,
            _: &str,
            _: Option<&File>,
        ) -> Result<(), String> {
            Err("Unsupported platform".into())
        }
        pub fn restore_checked(
            &self,
            _: &str,
            _: &Option<Image>,
            _: &Option<Image>,
            _: &str,
        ) -> Result<(), String> {
            Err("Unsupported platform".into())
        }
    }
}

#[cfg(all(test, any(target_os = "macos", target_os = "linux")))]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    struct Fixture {
        _temp: tempfile::TempDir,
        root: PathBuf,
        store: PathBuf,
        id: String,
    }
    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let base = temp.path().canonicalize().unwrap();
            let root = base.join("documents");
            fs::create_dir(&root).unwrap();
            Self {
                _temp: temp,
                root,
                store: base.join("recovery"),
                id: uuid::Uuid::new_v4().to_string(),
            }
        }
        fn write(&self, path: &str, content: &str) {
            fs::write(self.root.join(path), content).unwrap();
        }
        fn read(&self, path: &str) -> String {
            fs::read_to_string(self.root.join(path)).unwrap()
        }
        fn apply(
            &self,
            snapshot: &WorkspaceSnapshot,
            operations: &[Operation],
        ) -> Result<(), String> {
            apply(
                &self.root,
                &self.store,
                &self.id,
                snapshot,
                operations,
                &["write".into(), "move".into(), "trash".into()],
            )
        }
    }
    fn write(path: &str, content: &str) -> Operation {
        Operation::Write {
            path: path.into(),
            content: content.into(),
        }
    }

    #[test]
    fn edits_new_files_moves_and_trash_restore_together() {
        let f = Fixture::new();
        f.write("edit.md", "old");
        f.write("move.txt", "moved");
        f.write("trash.txt", "retired");
        let before = snapshot(&f.root).unwrap();
        f.apply(
            &before,
            &[
                write("edit.md", "new"),
                write("new.md", "created"),
                Operation::Move {
                    path: "move.txt".into(),
                    destination: "destination.txt".into(),
                },
                Operation::Trash {
                    path: "trash.txt".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(f.read("edit.md"), "new");
        assert_eq!(f.read("destination.txt"), "moved");
        assert!(!f.root.join("move.txt").exists());
        assert!(!f.root.join("trash.txt").exists());
        undo(&f.store, &f.id).unwrap();
        undo(&f.store, &f.id).unwrap();
        assert_eq!(f.read("edit.md"), "old");
        assert_eq!(f.read("move.txt"), "moved");
        assert_eq!(f.read("trash.txt"), "retired");
        assert!(!f.root.join("new.md").exists());
        assert!(!f.root.join("destination.txt").exists());
    }

    #[test]
    fn undo_preflights_every_document_and_preserves_user_edits() {
        let f = Fixture::new();
        f.write("a.txt", "a");
        f.write("b.txt", "b");
        f.apply(
            &snapshot(&f.root).unwrap(),
            &[write("a.txt", "A"), write("b.txt", "B")],
        )
        .unwrap();
        f.write("b.txt", "user edit");
        assert!(undo(&f.store, &f.id).unwrap_err().contains("newer content"));
        assert_eq!(f.read("a.txt"), "A");
        assert_eq!(f.read("b.txt"), "user edit");
    }

    #[test]
    fn stale_snapshot_and_omitted_existing_file_cannot_be_overwritten() {
        let f = Fixture::new();
        f.write("a.txt", "before");
        let before = snapshot(&f.root).unwrap();
        f.write("a.txt", "user edit");
        assert!(f.apply(&before, &[write("a.txt", "replace")]).is_err());
        assert_eq!(f.read("a.txt"), "user edit");
        assert!(f
            .apply(
                &WorkspaceSnapshot {
                    files: vec![],
                    omitted: 1
                },
                &[write("a.txt", "replace")]
            )
            .is_err());
    }

    #[test]
    fn backup_failure_leaves_original_unchanged() {
        let f = Fixture::new();
        f.write("a.txt", "before");
        fs::write(&f.store, "not a directory").unwrap();
        assert!(f
            .apply(&snapshot(&f.root).unwrap(), &[write("a.txt", "after")])
            .is_err());
        assert_eq!(f.read("a.txt"), "before");
    }

    #[test]
    fn scope_denial_and_duplicate_paths_leave_all_files_unchanged() {
        let f = Fixture::new();
        f.write("a.txt", "before");
        let before = snapshot(&f.root).unwrap();
        assert!(apply(
            &f.root,
            &f.store,
            &f.id,
            &before,
            &[write("a.txt", "after")],
            &[]
        )
        .is_err());
        assert!(f
            .apply(&before, &[write("a.txt", "after"), write("a.txt", "again")])
            .is_err());
        assert_eq!(f.read("a.txt"), "before");
    }

    #[test]
    fn symlink_hardlink_and_path_escapes_are_rejected() {
        let f = Fixture::new();
        let outside = f._temp.path().join("outside.txt");
        fs::write(&outside, "private").unwrap();
        symlink(&outside, f.root.join("link.txt")).unwrap();
        fs::hard_link(&outside, f.root.join("hard.txt")).unwrap();
        symlink(f._temp.path(), f.root.join("escape")).unwrap();
        let before = snapshot(&f.root).unwrap();
        assert!(before.files.is_empty());
        assert_eq!(before.omitted, 3);
        for path in [
            "link.txt",
            "hard.txt",
            "../outside.txt",
            "escape/outside.txt",
            "/tmp/outside.txt",
        ] {
            assert!(f.apply(&before, &[write(path, "bad")]).is_err(), "{path}");
        }
        assert_eq!(fs::read_to_string(outside).unwrap(), "private");
    }

    #[test]
    fn executable_config_and_agent_instruction_files_are_not_work_documents() {
        let f = Fixture::new();
        for path in [
            "AGENTS.md",
            "CLAUDE.md",
            "SKILL.md",
            ".env",
            "script.sh",
            "package.json",
            "script.txt",
        ] {
            f.write(path, "secret");
        }
        fs::set_permissions(f.root.join("script.txt"), fs::Permissions::from_mode(0o700)).unwrap();
        let before = snapshot(&f.root).unwrap();
        assert!(before.files.is_empty());
        assert_eq!(before.omitted, 7);
        for path in [
            "AGENTS.md",
            "CLAUDE.md",
            "SKILL.md",
            ".env",
            "script.sh",
            "package.json",
            "script.txt",
        ] {
            assert!(f.apply(&before, &[write(path, "bad")]).is_err(), "{path}");
        }
    }

    #[test]
    fn new_nested_documents_require_existing_non_link_directory() {
        let f = Fixture::new();
        fs::create_dir(f.root.join("notes")).unwrap();
        f.apply(
            &snapshot(&f.root).unwrap(),
            &[write("notes/今日.md", "こんにちは")],
        )
        .unwrap();
        assert_eq!(f.read("notes/今日.md"), "こんにちは");
        undo(&f.store, &f.id).unwrap();
        assert!(f.root.join("notes").exists());
        let f = Fixture::new();
        assert!(f
            .apply(&snapshot(&f.root).unwrap(), &[write("newdir/a.txt", "no")])
            .is_err());
    }

    #[test]
    fn successful_run_is_idempotent_but_cannot_be_repurposed() {
        let f = Fixture::new();
        f.write("a.txt", "before");
        let before = snapshot(&f.root).unwrap();
        let operations = [write("a.txt", "after")];
        f.apply(&before, &operations).unwrap();
        f.apply(&before, &operations).unwrap();
        assert!(f.apply(&before, &[write("a.txt", "different")]).is_err());
        undo(&f.store, &f.id).unwrap();
        assert!(f.apply(&before, &operations).is_err());
    }

    #[test]
    fn interrupted_apply_and_interrupted_undo_are_recoverable() {
        for phase in [Phase::Prepared, Phase::Undoing] {
            let f = Fixture::new();
            f.write("a.txt", "a");
            f.write("b.txt", "b");
            f.apply(
                &snapshot(&f.root).unwrap(),
                &[write("a.txt", "A"), write("b.txt", "B")],
            )
            .unwrap();
            let dir = store_directory(&f.store, None).unwrap();
            let mut journal = read_journal(&dir, &f.id).unwrap().unwrap();
            journal.phase = phase;
            write_journal(&dir, &f.id, &journal, false).unwrap();
            f.write("a.txt", "a"); // Simulates one write not applied, or already undone.
            undo(&f.store, &f.id).unwrap();
            assert_eq!(f.read("a.txt"), "a");
            assert_eq!(f.read("b.txt"), "b");
        }
    }

    #[test]
    fn replacing_workspace_directory_does_not_restore_into_new_folder() {
        let f = Fixture::new();
        f.write("a.txt", "before");
        f.apply(&snapshot(&f.root).unwrap(), &[write("a.txt", "after")])
            .unwrap();
        fs::rename(&f.root, f.root.with_extension("moved")).unwrap();
        fs::create_dir(&f.root).unwrap();
        f.write("a.txt", "after");
        assert!(undo(&f.store, &f.id).unwrap_err().contains("replaced"));
        assert_eq!(f.read("a.txt"), "after");
    }

    #[test]
    fn snapshot_is_bounded_and_reports_omissions() {
        let f = Fixture::new();
        for i in 0..MAX_FILES + 2 {
            f.write(&format!("{i:03}.txt"), "x");
        }
        f.write("large.txt", &"x".repeat(MAX_FILE_BYTES + 1));
        let before = snapshot(&f.root).unwrap();
        assert_eq!(before.files.len(), MAX_FILES);
        assert_eq!(before.omitted, 3);
    }

    #[test]
    fn original_permissions_are_preserved() {
        let f = Fixture::new();
        f.write("a.txt", "before");
        fs::set_permissions(f.root.join("a.txt"), fs::Permissions::from_mode(0o640)).unwrap();
        f.apply(&snapshot(&f.root).unwrap(), &[write("a.txt", "after")])
            .unwrap();
        undo(&f.store, &f.id).unwrap();
        assert_eq!(
            fs::metadata(f.root.join("a.txt"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o640
        );
    }

    #[test]
    fn store_inside_workspace_or_symlink_store_is_rejected() {
        let f = Fixture::new();
        f.write("a.txt", "before");
        let before = snapshot(&f.root).unwrap();
        assert!(apply(
            &f.root,
            &f.root.join("recovery"),
            &f.id,
            &before,
            &[write("a.txt", "after")],
            &["write".into()]
        )
        .is_err());
        let real = f._temp.path().join("real");
        fs::create_dir(&real).unwrap();
        symlink(real, &f.store).unwrap();
        assert!(f.apply(&before, &[write("a.txt", "after")]).is_err());
        assert_eq!(f.read("a.txt"), "before");
    }

    #[test]
    fn editor_with_open_original_descriptor_cannot_lose_a_late_save() {
        let f = Fixture::new();
        f.write("a.txt", "before");
        let mut editor = fs::OpenOptions::new()
            .write(true)
            .open(f.root.join("a.txt"))
            .unwrap();
        f.apply(&snapshot(&f.root).unwrap(), &[write("a.txt", "after")])
            .unwrap();
        editor.set_len(0).unwrap();
        editor.write_all(b"late user save").unwrap();
        editor.sync_all().unwrap();
        assert_eq!(f.read("a.txt"), "after");
        assert_eq!(f.read(&recovery_name(&f.id, 0)), "late user save");
        assert!(undo(&f.store, &f.id)
            .unwrap_err()
            .contains("retained original"));
        assert_eq!(f.read("a.txt"), "after");
    }

    #[test]
    fn undo_retains_replaced_live_inode_and_restores_original_inode() {
        use std::os::unix::fs::MetadataExt;
        let f = Fixture::new();
        f.write("a.txt", "before");
        let original_inode = fs::metadata(f.root.join("a.txt")).unwrap().ino();
        f.apply(&snapshot(&f.root).unwrap(), &[write("a.txt", "after")])
            .unwrap();
        let mut editor = fs::OpenOptions::new()
            .write(true)
            .open(f.root.join("a.txt"))
            .unwrap();
        undo(&f.store, &f.id).unwrap();
        assert_eq!(
            fs::metadata(f.root.join("a.txt")).unwrap().ino(),
            original_inode
        );
        editor.set_len(0).unwrap();
        editor.write_all(b"saved after undo").unwrap();
        editor.sync_all().unwrap();
        assert_eq!(f.read("a.txt"), "before");
        assert_eq!(f.read(&recovery_name(&f.id, 0)), "saved after undo");
    }

    #[test]
    fn selected_root_and_recovery_store_cannot_traverse_symlink_ancestors() {
        let f = Fixture::new();
        let alias = f._temp.path().join("alias");
        symlink(&f.root, &alias).unwrap();
        fs::create_dir(f.root.join("nested")).unwrap();
        assert!(validate_root(alias.join("nested").to_str().unwrap()).is_err());
        let recovery_path = alias.join("new-recovery");
        assert!(store_directory(&recovery_path, None).is_err());
        assert!(!f.root.join("new-recovery").exists());
    }

    #[test]
    fn undo_availability_is_read_only_and_tracks_journal_phase() {
        let f = Fixture::new();
        assert!(!can_undo(&f.store, &f.id));
        assert!(!f.store.exists());
        f.write("a.txt", "before");
        f.apply(&snapshot(&f.root).unwrap(), &[write("a.txt", "after")])
            .unwrap();
        assert!(can_undo(&f.store, &f.id));
        undo(&f.store, &f.id).unwrap();
        assert!(!can_undo(&f.store, &f.id));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_live_replacement_move_and_undo_preserve_acl_and_xattrs() {
        use std::ffi::{CStr, CString};
        use std::os::fd::AsRawFd;
        unsafe extern "C" {
            fn acl_get_fd(fd: libc::c_int) -> *mut libc::c_void;
            fn acl_to_text(acl: *mut libc::c_void, len: *mut libc::ssize_t) -> *mut libc::c_char;
            fn acl_free(acl: *mut libc::c_void) -> libc::c_int;
        }
        fn acl(path: &Path) -> String {
            let file = File::open(path).unwrap();
            let value = unsafe { acl_get_fd(file.as_raw_fd()) };
            assert!(!value.is_null());
            let text = unsafe { acl_to_text(value, std::ptr::null_mut()) };
            assert!(!text.is_null());
            let result = unsafe { CStr::from_ptr(text) }.to_str().unwrap().to_owned();
            unsafe {
                acl_free(text.cast());
                acl_free(value);
            }
            result
        }
        fn attribute(path: &Path) -> Vec<u8> {
            let file = File::open(path).unwrap();
            let name = CString::new("com.yorishiro.autonomy-test").unwrap();
            let mut bytes = vec![0u8; 128];
            let length = unsafe {
                libc::fgetxattr(
                    file.as_raw_fd(),
                    name.as_ptr(),
                    bytes.as_mut_ptr().cast(),
                    bytes.len(),
                    0,
                    0,
                )
            };
            assert!(length >= 0);
            bytes.truncate(length as usize);
            bytes
        }
        for operation in [
            write("a.txt", "after"),
            Operation::Move {
                path: "a.txt".into(),
                destination: "moved.txt".into(),
            },
        ] {
            let f = Fixture::new();
            f.write("a.txt", "before");
            let source = f.root.join("a.txt");
            let fd = File::open(&source).unwrap();
            let name = CString::new("com.yorishiro.autonomy-test").unwrap();
            let value = b"original metadata";
            assert_eq!(
                unsafe {
                    libc::fsetxattr(
                        fd.as_raw_fd(),
                        name.as_ptr(),
                        value.as_ptr().cast(),
                        value.len(),
                        0,
                        0,
                    )
                },
                0
            );
            assert!(std::process::Command::new("/bin/chmod")
                .args(["+a", "everyone deny execute"])
                .arg(&source)
                .status()
                .unwrap()
                .success());
            let original_acl = acl(&source);
            let destination = match &operation {
                Operation::Move { destination, .. } => f.root.join(destination),
                _ => source.clone(),
            };
            f.apply(&snapshot(&f.root).unwrap(), &[operation]).unwrap();
            assert_eq!(attribute(&destination), value);
            assert_eq!(acl(&destination), original_acl);
            undo(&f.store, &f.id).unwrap();
            assert_eq!(attribute(&source), value);
            assert_eq!(acl(&source), original_acl);
        }
    }
}
