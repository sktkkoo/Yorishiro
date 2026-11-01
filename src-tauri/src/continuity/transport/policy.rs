//! Preserve declarative user restrictions when launching an isolated transport.
//! We never execute policy source to translate it. Unsupported restrictions stop
//! the job; personal executable hooks are not imported or claimed equivalent.
use serde_json::Value;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_POLICY: u64 = 1024 * 1024;

fn error(path: &Path) -> String {
    format!(
        "既存の制限を安全に引き継げないため停止しました: {}",
        path.display()
    )
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        // Nonblocking plus fstat also closes the regular-file -> FIFO race.
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(error(path)),
    };
    if !file.metadata().map_err(|_| error(path))?.is_file() {
        return Err(error(path));
    }
    let mut text = String::new();
    file.take(MAX_POLICY + 1)
        .read_to_string(&mut text)
        .map_err(|_| error(path))?;
    if text.len() as u64 > MAX_POLICY {
        return Err(error(path));
    }
    Ok(Some(text))
}

fn roots(root: Option<&Path>) -> Result<BTreeSet<PathBuf>, String> {
    let mut roots = BTreeSet::new();
    if let Some(root) = root {
        roots.extend(root.ancestors().map(Path::to_path_buf));
        if let Ok(repo) = git2::Repository::discover(root) {
            // Linked worktrees share the main checkout's local configuration.
            let common = repo.path().join("commondir");
            if let Some(text) = read_optional(&common)? {
                let path = repo
                    .path()
                    .join(text.trim())
                    .canonicalize()
                    .map_err(|_| error(&common))?;
                if let Some(parent) = path.parent() {
                    roots.extend(parent.ancestors().map(Path::to_path_buf));
                }
            }
        }
    }
    Ok(roots)
}

/// File-tool restrictions cannot be silently evaded by the host's file broker.
/// Bash and other absent tools remain unavailable in the reasoning transport.
pub fn claude_preflight(root: Option<&Path>) -> Result<(), String> {
    // Managed restrictions must also be checked before the host reads files,
    // not only later when launching the reasoning CLI.
    super::worker::check_managed_settings()?;
    let home = crate::home_dir_or_err()?;
    let mut dirs = BTreeSet::from([home.join(".claude")]);
    if let Some(path) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        dirs.insert(PathBuf::from(path));
    }
    dirs.extend(roots(root)?.into_iter().map(|path| path.join(".claude")));
    for dir in dirs {
        for name in ["settings.json", "settings.local.json"] {
            let path = dir.join(name);
            if let Some(text) = read_optional(&path)? {
                check_claude(&text).map_err(|_| error(&path))?;
            }
        }
    }
    Ok(())
}

fn check_claude(text: &str) -> Result<(), ()> {
    let value: Value = serde_json::from_str(text).map_err(|_| ())?;
    let object = value.as_object().ok_or(())?;
    if let Some(sandbox) = object.get("sandbox") {
        let sandbox = sandbox.as_object().ok_or(())?;
        // Filesystem/network deny policies are a second native policy surface,
        // separate from tool permission rules; never discard them silently.
        if sandbox.keys().any(|key| {
            !matches!(
                key.as_str(),
                "enabled"
                    | "autoAllowBashIfSandboxed"
                    | "allowUnsandboxedCommands"
                    | "excludedCommands"
            )
        }) {
            return Err(());
        }
    }
    let Some(permissions) = value.get("permissions") else {
        return Ok(());
    };
    let permissions = permissions.as_object().ok_or(())?;
    if permissions
        .get("defaultMode")
        .is_some_and(|v| v.as_str() == Some("plan"))
    {
        return Err(());
    }
    for key in ["deny", "ask"] {
        if let Some(rules) = permissions.get(key) {
            for rule in rules.as_array().ok_or(())? {
                let text = rule.as_str().ok_or(())?;
                let name = text.split('(').next().ok_or(())?;
                if !matches!(name, "Bash" | "WebFetch" | "WebSearch" | "Task" | "Agent")
                    && !name.starts_with("mcp__")
                {
                    return Err(());
                }
            }
        }
    }
    Ok(())
}
