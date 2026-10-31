//! Preserve declarative user restrictions when launching an isolated transport.
//! We never execute policy source to translate it. Unsupported restrictions stop
//! the job; personal executable hooks are not imported or claimed equivalent.
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::{Path, PathBuf};

mod native_commands;
pub(super) use native_commands::NativeCommandPolicy;

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

pub fn codex_home() -> Result<PathBuf, String> {
    Ok(std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(crate::home_dir_or_err()?.join(".codex")))
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

/// Return only restrictive literal rules. Allow rules can authorize unsandboxed
/// execution in native Codex, so they must not enter this limited worker.
pub fn codex_restrictions(root: &Path) -> Result<String, String> {
    codex_restrictions_for_action(root, false)
}

/// Network approval does not override an existing native sandbox network deny.
pub fn codex_restrictions_for_action(root: &Path, network: bool) -> Result<String, String> {
    super::development::check_managed_config()?;
    let mut dirs = BTreeSet::from([codex_home()?]);
    dirs.extend(
        roots(Some(root))?
            .into_iter()
            .map(|path| path.join(".codex")),
    );
    let mut retained = String::new();
    for dir in dirs {
        let config = dir.join("config.toml");
        if let Some(text) = read_optional(&config)? {
            check_codex_action_config(&text, network).map_err(|_| error(&config))?;
        }
        // Named v2 profile files can carry restrictions not represented by the
        // base config. Accept ordinary model-only profiles; stop on unsupported
        // permission policies rather than guessing which profile was selected.
        match std::fs::read_dir(&dir) {
            Ok(entries) => {
                for entry in entries {
                    let path = entry.map_err(|_| error(&dir))?.path();
                    if path
                        .file_name()
                        .is_some_and(|name| name.to_string_lossy().ends_with(".config.toml"))
                    {
                        let text = read_optional(&path)?.ok_or_else(|| error(&path))?;
                        check_codex_action_config(&text, network).map_err(|_| error(&path))?;
                    }
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err(error(&dir)),
        }
        let rules_dir = dir.join("rules");
        let entries = match std::fs::read_dir(&rules_dir) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(error(&rules_dir)),
        };
        let mut paths = Vec::new();
        for entry in entries {
            let path = entry.map_err(|_| error(&rules_dir))?.path();
            if path.extension().is_some_and(|e| e == "rules") {
                paths.push(path);
            }
            if paths.len() > 128 {
                return Err(error(&rules_dir));
            }
        }
        paths.sort();
        for path in paths {
            let text = read_optional(&path)?.ok_or_else(|| error(&path))?;
            retained.push_str(&restrictive_rules(&text).map_err(|_| error(&path))?);
            if retained.len() as u64 > MAX_POLICY {
                return Err(error(&path));
            }
        }
    }
    Ok(retained)
}

fn check_codex_action_config(text: &str, network: bool) -> Result<(), ()> {
    check_codex_config(text)?;
    if !network {
        return Ok(());
    }
    let value: toml::Value = toml::from_str(text).map_err(|_| ())?;
    let sandbox_mode = value.get("sandbox_mode").and_then(toml::Value::as_str);
    let default_permissions = value
        .get("default_permissions")
        .and_then(toml::Value::as_str);
    // Workspace-only settings are dormant under an explicitly unrestricted
    // mode. The approved action still runs with its own scoped permissions.
    if sandbox_mode == Some("danger-full-access")
        || (sandbox_mode.is_none() && default_permissions == Some(":danger-full-access"))
    {
        return Ok(());
    }
    let native_network = value
        .get("sandbox_workspace_write")
        .and_then(|workspace| workspace.get("network_access"));
    let explicit_network = native_network
        .map(|value| value.as_bool().ok_or(()))
        .transpose()?;
    let workspace_default =
        sandbox_mode == Some("workspace-write") || default_permissions == Some(":workspace");
    if explicit_network == Some(false) || (workspace_default && explicit_network != Some(true)) {
        return Err(());
    }
    Ok(())
}

fn check_codex_config(text: &str) -> Result<(), ()> {
    let value: toml::Value = toml::from_str(text).map_err(|_| ())?;
    let table = value.as_table().ok_or(())?;
    if table
        .get("features")
        .and_then(toml::Value::as_table)
        .and_then(|features| features.get("shell_tool"))
        .is_some_and(|value| value.as_bool() == Some(false))
    {
        return Err(());
    }
    if ["permissions", "profiles", "profile"]
        .iter()
        .any(|key| table.contains_key(*key))
    {
        return Err(());
    }
    if let Some(mode) = table.get("sandbox_mode") {
        if !matches!(
            mode.as_str(),
            Some("workspace-write" | "danger-full-access")
        ) {
            return Err(());
        }
    }
    if let Some(mode) = table.get("default_permissions") {
        if !matches!(mode.as_str(), Some(":workspace" | ":danger-full-access")) {
            return Err(());
        }
    }
    if let Some(policy) = table.get("approval_policy") {
        if !matches!(policy.as_str(), Some("never" | "on-request" | "on-failure")) {
            return Err(());
        }
    }
    if let Some(workspace) = table.get("sandbox_workspace_write") {
        if workspace.as_table().ok_or(())?.keys().any(|key| {
            !matches!(
                key.as_str(),
                "writable_roots"
                    | "network_access"
                    | "exclude_tmpdir_env_var"
                    | "exclude_slash_tmp"
            )
        }) {
            return Err(());
        }
    }
    // Alternate rule/config sources cannot be dropped without examining them.
    if table
        .keys()
        .any(|key| key.contains("rules") || key == "extends")
    {
        return Err(());
    }
    Ok(())
}

#[derive(Debug, PartialEq)]
enum Token {
    Name(String),
    String(String),
    Open,
    Close,
    Array,
    EndArray,
    Equal,
    Comma,
}

fn tokens(text: &str) -> Result<Vec<Token>, ()> {
    let mut chars = text.chars().peekable();
    let mut out = Vec::new();
    while let Some(c) = chars.next() {
        if c.is_whitespace() {
            continue;
        }
        if c == '#' {
            for c in chars.by_ref() {
                if c == '\n' {
                    break;
                }
            }
            continue;
        }
        out.push(match c {
            '(' => Token::Open,
            ')' => Token::Close,
            '[' => Token::Array,
            ']' => Token::EndArray,
            '=' => Token::Equal,
            ',' => Token::Comma,
            '\'' | '"' => {
                let mut string = String::new();
                let mut closed = false;
                while let Some(next) = chars.next() {
                    if next == c {
                        closed = true;
                        break;
                    }
                    if next == '\\' {
                        string.push(match chars.next().ok_or(())? {
                            '\\' => '\\',
                            '\'' => '\'',
                            '"' => '"',
                            'n' => '\n',
                            'r' => '\r',
                            't' => '\t',
                            _ => return Err(()),
                        });
                    } else {
                        string.push(next);
                    }
                }
                if !closed {
                    return Err(());
                }
                Token::String(string)
            }
            c if c.is_ascii_alphabetic() || c == '_' => {
                let mut name = String::from(c);
                while chars
                    .peek()
                    .is_some_and(|c| c.is_ascii_alphanumeric() || *c == '_')
                {
                    name.push(chars.next().unwrap());
                }
                Token::Name(name)
            }
            _ => return Err(()),
        });
    }
    Ok(out)
}

fn literal(tokens: &[Token], pos: &mut usize, depth: usize) -> Result<Value, ()> {
    if depth > 3 {
        return Err(());
    }
    match tokens.get(*pos) {
        Some(Token::String(value)) => {
            *pos += 1;
            Ok(Value::String(value.clone()))
        }
        Some(Token::Array) => {
            *pos += 1;
            let mut values = Vec::new();
            while tokens.get(*pos) != Some(&Token::EndArray) {
                values.push(literal(tokens, pos, depth + 1)?);
                if tokens.get(*pos) == Some(&Token::Comma) {
                    *pos += 1;
                } else if tokens.get(*pos) != Some(&Token::EndArray) {
                    return Err(());
                }
            }
            *pos += 1;
            Ok(Value::Array(values))
        }
        _ => Err(()),
    }
}

fn restrictive_rules(text: &str) -> Result<String, ()> {
    let tokens = tokens(text)?;
    let mut pos = 0;
    let mut output = String::new();
    while pos < tokens.len() {
        if tokens.get(pos) != Some(&Token::Name("prefix_rule".into()))
            || tokens.get(pos + 1) != Some(&Token::Open)
        {
            return Err(());
        }
        pos += 2;
        let mut args = BTreeMap::new();
        while tokens.get(pos) != Some(&Token::Close) {
            let Some(Token::Name(name)) = tokens.get(pos) else {
                return Err(());
            };
            if !matches!(
                name.as_str(),
                "pattern" | "decision" | "justification" | "match" | "not_match"
            ) || tokens.get(pos + 1) != Some(&Token::Equal)
            {
                return Err(());
            }
            pos += 2;
            if args
                .insert(name.clone(), literal(&tokens, &mut pos, 0)?)
                .is_some()
            {
                return Err(());
            }
            if tokens.get(pos) == Some(&Token::Comma) {
                pos += 1;
            } else if tokens.get(pos) != Some(&Token::Close) {
                return Err(());
            }
        }
        pos += 1;
        let pattern = args.get("pattern").and_then(Value::as_array).ok_or(())?;
        if pattern.is_empty()
            || pattern.iter().any(|v| {
                !v.is_string()
                    && !v
                        .as_array()
                        .is_some_and(|a| !a.is_empty() && a.iter().all(Value::is_string))
            })
        {
            return Err(());
        }
        let decision = match args.get("decision") {
            None => "allow",
            Some(v) => v.as_str().ok_or(())?,
        };
        if !matches!(decision, "allow" | "prompt" | "forbidden") {
            return Err(());
        }
        if decision != "allow" {
            output.push_str("prefix_rule(");
            for (name, value) in args {
                output.push_str(&format!("{name}={value},"));
            }
            output.push_str(")\n");
        }
    }
    Ok(output)
}

pub fn write_rules(home: &Path, rules: &str) -> Result<PathBuf, String> {
    let directory = home.join("rules");
    std::fs::create_dir(&directory).map_err(|_| error(&directory))?;
    let path = directory.join("autonomy.rules");
    std::fs::write(&path, rules).map_err(|_| error(&path))?;
    Ok(path)
}

/// Native check output without a matched decision means no restrictive match.
pub fn command_allowed(bytes: &[u8]) -> Result<bool, String> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| "既存の実行制限を検証できません")?;
    let object = value.as_object().ok_or("既存の実行制限を検証できません")?;
    match object.get("decision").and_then(Value::as_str) {
        Some("prompt" | "forbidden") => Ok(false),
        None if object
            .get("matchedRules")
            .and_then(Value::as_array)
            .is_some_and(Vec::is_empty) =>
        {
            Ok(true)
        }
        _ => Err("既存の実行制限を検証できません".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[test]
    fn policy_reads_reject_fifo_and_symlink_without_blocking() {
        use std::os::unix::ffi::OsStrExt;
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("settings.json");
        let raw = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(raw.as_ptr(), 0o600) }, 0);
        assert!(read_optional(&path).is_err());
        let link = directory.path().join("link");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        assert!(read_optional(&link).is_err());
    }
    #[test]
    fn only_literal_restrictive_rules_survive() {
        let value = restrictive_rules("# safe\nprefix_rule(pattern=['rm', ['-r','-rf']], decision='prompt', justification='ask first')\nprefix_rule(pattern=[\"npm\",\"test\"],decision=\"allow\")\nprefix_rule(pattern=['git','clean'],decision='forbidden')").unwrap();
        assert!(value.contains("prompt"));
        assert!(value.contains("forbidden"));
        assert!(!value.contains("npm"));
        for bad in [
            "load('x','f')",
            "prefix_rule(pattern=['rm'],decision=compute())",
            "x='forbidden'",
            "prefix_rule(pattern=['rm'],decision='prompt',decision='allow')",
            "prefix_rule(pattern=['rm'] + ['-rf'],decision='prompt')",
        ] {
            assert!(restrictive_rules(bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn file_restrictions_cannot_be_evaded_by_host_broker() {
        assert!(check_claude(
            r#"{"permissions":{"deny":["Bash(rm:*)"],"ask":["Bash(git push:*)"]}}"#
        )
        .is_ok());
        for text in [
            r#"{"permissions":{"deny":["Read(./private/**)"]}}"#,
            r#"{"permissions":{"ask":["Edit"]}}"#,
            r#"{"permissions":{"defaultMode":"plan"}}"#,
            r#"{"sandbox":{"filesystem":{"denyRead":["private"]}}}"#,
            "[]",
        ] {
            assert!(check_claude(text).is_err());
        }
    }
    #[test]
    fn approved_network_action_preserves_native_network_restrictions() {
        for config in [
            "sandbox_mode='workspace-write'\n[sandbox_workspace_write]\nnetwork_access=false",
            "sandbox_mode='workspace-write'",
            "default_permissions=':workspace'",
            "[sandbox_workspace_write]\nnetwork_access='false'",
            "[permissions.custom.network]\nenabled=false",
        ] {
            assert!(check_codex_action_config(config, true).is_err(), "{config}");
        }
        assert!(check_codex_action_config(
            "sandbox_mode='workspace-write'\n[sandbox_workspace_write]\nnetwork_access=false",
            false
        )
        .is_ok());
        assert!(check_codex_action_config(
            "sandbox_mode='workspace-write'\n[sandbox_workspace_write]\nnetwork_access=true",
            true
        )
        .is_ok());
        assert!(check_codex_action_config("sandbox_mode='danger-full-access'", true).is_ok());
        for config in [
            "sandbox_mode='danger-full-access'\n[sandbox_workspace_write]\nnetwork_access=false",
            "default_permissions=':danger-full-access'\n[sandbox_workspace_write]\nnetwork_access=false",
        ] {
            assert!(check_codex_action_config(config, true).is_ok(), "{config}");
        }
        // The older sandbox mode wins when both formats are present.
        assert!(check_codex_action_config(
            "sandbox_mode='workspace-write'\ndefault_permissions=':danger-full-access'",
            true
        )
        .is_err());
    }
    #[test]
    fn restrictive_or_unsupported_codex_profiles_fail_closed() {
        assert!(check_codex_config("sandbox_mode='danger-full-access'\napproval_policy='never'\n[sandbox_workspace_write]\nnetwork_access=false").is_ok());
        for text in [
            "sandbox_mode='read-only'",
            "default_permissions='custom'",
            "[permissions.custom.filesystem]\n':root'='read'",
            "profile='work'",
            "[profiles.work]\nsandbox_mode='read-only'",
            "approval_policy='untrusted'",
            "[features]\nshell_tool=false",
        ] {
            assert!(check_codex_config(text).is_err(), "{text}");
        }
    }
    #[test]
    fn host_checks_require_verified_native_decision() {
        assert!(command_allowed(br#"{"matchedRules":[]}"#).unwrap());
        for decision in ["prompt", "forbidden"] {
            assert!(!command_allowed(
                format!(r#"{{"decision":"{decision}","matchedRules":[]}}"#).as_bytes()
            )
            .unwrap());
        }
        assert!(command_allowed(br#"{"decision":"allow","matchedRules":[]}"#).is_err());
        assert!(command_allowed(b"{}").is_err());
    }
}
