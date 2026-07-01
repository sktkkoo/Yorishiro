//! Shell wrapper rc + init script の生成。
//!
//! `~/.charminal/shell/` 配下に Charminal 所有の init script と wrapper rc を
//! 書き出す。spawn 時に shell binary に応じた env / args を組み立てて wrapper
//! を経由させ、user の rc → Charminal の OSC 133 emit → user.<shell> 拡張点
//! の順で source される構造を作る。
//!
//! 詳細は `docs/terminal.md` §Shell integration。
//!
//! Internal design-record: 2026-05-05-multi-pane-terminal.md.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// `~/.charminal/shell/init.zsh` — OSC 133 emit を zsh の hook に登録する。
/// PROMPT は触らず、precmd / preexec function array にのみ append する
/// （p10k / oh-my-zsh / prezto との衝突を避ける）。
const INIT_ZSH: &str = include_str!("shell_wrapper/init.zsh");

/// `~/.charminal/shell/init.bash` — preexec 相当を DEBUG trap で代替し、
/// PROMPT_COMMAND chain に precmd を挿入する。
const INIT_BASH: &str = include_str!("shell_wrapper/init.bash");

/// `~/.charminal/shell/init.fish` — fish の native event hook を使う。
const INIT_FISH: &str = include_str!("shell_wrapper/init.fish");

/// `~/.charminal/shell/wrapper-zsh/.zshrc` — ZDOTDIR 経由で読まれ、user の
/// 元 .zshrc → init.zsh → user.zsh の順で chain する。
const WRAPPER_ZSHRC: &str = include_str!("shell_wrapper/wrapper-zsh.zshrc");

/// `~/.charminal/shell/wrapper-bash/init.bash` — bash --rcfile で読まれ、
/// user の .bashrc → init.bash → user.bash の順で chain する。
const WRAPPER_BASH_INIT: &str = include_str!("shell_wrapper/wrapper-bash.init.bash");

/// `~/.charminal/shell/hook-reminder.sh` — Claude Code の UserPromptSubmit
/// hook 用リマインダー。ユーザー管理ファイル：初回のみ seed、既存なら触らない。
const HOOK_REMINDER: &str = include_str!("shell_wrapper/hook-reminder.sh");

/// `~/.charminal/shell/` を初期化。ディレクトリと init / wrapper file を
/// idempotent に書く。既存内容と一致していたら no-op。
///
/// `user.<shell>` には絶対 touch しない（user 拡張点）。
pub fn ensure_shell_files(charminal_home: &Path) -> io::Result<()> {
    let shell_dir = charminal_home.join("shell");
    fs::create_dir_all(&shell_dir)?;

    write_if_different(&shell_dir.join("init.zsh"), INIT_ZSH)?;
    write_if_different(&shell_dir.join("init.bash"), INIT_BASH)?;
    write_if_different(&shell_dir.join("init.fish"), INIT_FISH)?;

    let wrapper_zsh = shell_dir.join("wrapper-zsh");
    fs::create_dir_all(&wrapper_zsh)?;
    write_if_different(&wrapper_zsh.join(".zshrc"), WRAPPER_ZSHRC)?;

    let wrapper_bash = shell_dir.join("wrapper-bash");
    fs::create_dir_all(&wrapper_bash)?;
    write_if_different(&wrapper_bash.join("init.bash"), WRAPPER_BASH_INIT)?;

    write_if_absent(&shell_dir.join("hook-reminder.sh"), HOOK_REMINDER)?;

    Ok(())
}

fn write_if_absent(path: &Path, content: &str) -> io::Result<()> {
    if path.exists() {
        return Ok(());
    }
    fs::write(path, content)
}

fn write_if_different(path: &Path, content: &str) -> io::Result<()> {
    if let Ok(existing) = fs::read_to_string(path) {
        if existing == content {
            return Ok(());
        }
    }
    fs::write(path, content)
}

fn write_executable_if_different(path: &Path, content: &str) -> io::Result<()> {
    write_if_different(path, content)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn sh_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn sanitize_session_component(session_id: &str) -> String {
    let mut out = String::with_capacity(session_id.len());
    for ch in session_id.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out.is_empty() {
        "session".to_string()
    } else {
        out
    }
}

fn path_prepend_unique(prepend: &Path, current: &str) -> String {
    let sep = if cfg!(windows) { ";" } else { ":" };
    let prepend = prepend.to_string_lossy().to_string();
    let mut entries = vec![prepend.clone()];
    for entry in current.split(sep) {
        if entry.is_empty() || entry == prepend {
            continue;
        }
        entries.push(entry.to_string());
    }
    entries.join(sep)
}

fn hook_script(shell_dir: &Path, file_name: &str, endpoint: &str) -> io::Result<PathBuf> {
    let hooks_dir = shell_dir.join("hooks");
    fs::create_dir_all(&hooks_dir)?;
    let path = hooks_dir.join(file_name);
    let script = format!(
        r#"#!/bin/sh
port="${{CHARMINAL_HOOK_PORT:-19001}}"
session="${{CHARMINAL_SESSION_ID:-}}"
agent="${{CHARMINAL_AGENT_KIND:-}}"
body="$(cat 2>/dev/null || true)"
if [ -z "$body" ]; then
  body="{{}}"
fi
url="http://127.0.0.1:${{port}}{endpoint}?sessionId=${{session}}&agent=${{agent}}"
if command -v curl >/dev/null 2>&1; then
  printf '%s' "$body" | curl -s -m 1 -X POST --data-binary @- "$url" >/dev/null 2>&1 || true
fi
printf '{{}}'
"#,
    );
    write_executable_if_different(&path, &script)?;
    Ok(path)
}

fn command_path_for_hook(path: &Path) -> String {
    // Claude Code は command を shell で実行する。space を含む HOME に備え quote する。
    sh_single_quote(&path.to_string_lossy())
}

fn toml_literal_command(path: &Path) -> String {
    // Codex hook は runtime によって shell 経由 / direct exec が揺れるため、
    // cmux と同じく「実行可能 script path だけ」を渡す。通常の macOS HOME では
    // space を含まない前提。path に ''' が入る場合だけ安全側で空にする。
    let raw = path.to_string_lossy();
    if raw.contains("'''") {
        String::new()
    } else {
        raw.into_owned()
    }
}

fn claude_hooks_json(hooks_dir: &HookScripts) -> String {
    serde_json::json!({
        "hooks": {
            "SessionStart": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.session_start) }]
            }],
            "UserPromptSubmit": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.prompt) }]
            }],
            "PreToolUse": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.pre_tool_use) }]
            }],
            "PostToolUse": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.post_tool_use) }]
            }],
            "PostToolUseFailure": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.post_tool_failure) }]
            }],
            "PostToolBatch": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.post_tool_batch) }]
            }],
            "Stop": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.stop) }]
            }],
            "StopFailure": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.stop_failure) }]
            }],
            "Notification": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.notification) }]
            }],
            "PermissionRequest": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.permission_request) }]
            }],
            "PermissionDenied": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.permission_denied) }]
            }],
            "SubagentStart": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.subagent_start) }]
            }],
            "SubagentStop": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.subagent_stop) }]
            }],
            "TaskCreated": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.task_created) }]
            }],
            "TaskCompleted": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.task_completed) }]
            }],
            "PreCompact": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.pre_compact) }]
            }],
            "PostCompact": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.post_compact) }]
            }],
            "Elicitation": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.elicitation) }]
            }],
            "ElicitationResult": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.elicitation_result) }]
            }],
            "SessionEnd": [{
                "matcher": "",
                "hooks": [{ "type": "command", "command": command_path_for_hook(&hooks_dir.session_end) }]
            }]
        }
    })
    .to_string()
}

struct HookScripts {
    prompt: PathBuf,
    stop: PathBuf,
    pre_tool_use: PathBuf,
    post_tool_use: PathBuf,
    post_tool_failure: PathBuf,
    post_tool_batch: PathBuf,
    notification: PathBuf,
    session_start: PathBuf,
    session_end: PathBuf,
    permission_request: PathBuf,
    permission_denied: PathBuf,
    subagent_start: PathBuf,
    subagent_stop: PathBuf,
    task_created: PathBuf,
    task_completed: PathBuf,
    stop_failure: PathBuf,
    pre_compact: PathBuf,
    post_compact: PathBuf,
    elicitation: PathBuf,
    elicitation_result: PathBuf,
}

fn ensure_hook_scripts(shell_dir: &Path) -> io::Result<HookScripts> {
    Ok(HookScripts {
        prompt: hook_script(shell_dir, "hook-prompt.sh", "/hook/prompt")?,
        stop: hook_script(shell_dir, "hook-stop.sh", "/hook/stop")?,
        pre_tool_use: hook_script(shell_dir, "hook-pre-tool-use.sh", "/hook/pre-tool-use")?,
        post_tool_use: hook_script(shell_dir, "hook-post-tool-use.sh", "/hook/post-tool-use")?,
        post_tool_failure: hook_script(
            shell_dir,
            "hook-post-tool-failure.sh",
            "/hook/post-tool-failure",
        )?,
        post_tool_batch: hook_script(
            shell_dir,
            "hook-post-tool-batch.sh",
            "/hook/post-tool-batch",
        )?,
        notification: hook_script(shell_dir, "hook-notification.sh", "/hook/notification")?,
        session_start: hook_script(shell_dir, "hook-session-start.sh", "/hook/session-start")?,
        session_end: hook_script(shell_dir, "hook-session-end.sh", "/hook/session-end")?,
        permission_request: hook_script(
            shell_dir,
            "hook-permission-request.sh",
            "/hook/permission-request",
        )?,
        permission_denied: hook_script(
            shell_dir,
            "hook-permission-denied.sh",
            "/hook/permission-denied",
        )?,
        subagent_start: hook_script(shell_dir, "hook-subagent-start.sh", "/hook/subagent-start")?,
        subagent_stop: hook_script(shell_dir, "hook-subagent-stop.sh", "/hook/subagent-stop")?,
        task_created: hook_script(shell_dir, "hook-task-created.sh", "/hook/task-created")?,
        task_completed: hook_script(shell_dir, "hook-task-completed.sh", "/hook/task-completed")?,
        stop_failure: hook_script(shell_dir, "hook-stop-failure.sh", "/hook/stop-failure")?,
        pre_compact: hook_script(shell_dir, "hook-pre-compact.sh", "/hook/pre-compact")?,
        post_compact: hook_script(shell_dir, "hook-post-compact.sh", "/hook/post-compact")?,
        elicitation: hook_script(shell_dir, "hook-elicitation.sh", "/hook/elicitation")?,
        elicitation_result: hook_script(
            shell_dir,
            "hook-elicitation-result.sh",
            "/hook/elicitation-result",
        )?,
    })
}

fn claude_shim_script(settings_path: &Path) -> String {
    let settings = sh_single_quote(&settings_path.to_string_lossy());
    r#"#!/bin/sh
if [ "${CHARMINAL_AGENT_SHIMS_DISABLED:-}" = "1" ] || [ -z "${CHARMINAL_SESSION_ID:-}" ]; then
  exec_real=1
else
  exec_real=0
fi
self_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
find_real() {
  old_ifs="$IFS"
  IFS=:
  for d in ${PATH:-}; do
    [ "$d" = "$self_dir" ] && continue
    candidate="$d/claude"
    [ -x "$candidate" ] || continue
    [ "$candidate" = "$0" ] && continue
    printf '%s' "$candidate"
    IFS="$old_ifs"
    return 0
  done
  IFS="$old_ifs"
  return 1
}
real="$(find_real)" || { echo "Error: claude not found in PATH" >&2; exit 127; }
if [ "$exec_real" = "1" ]; then
  exec "$real" "$@"
fi
export CHARMINAL_AGENT_KIND=claude
exec "$real" --settings __SETTINGS__ "$@"
"#
    .replace("__SETTINGS__", &settings)
}

fn codex_hook_arg(event: &str, path: &Path, timeout_ms: u32) -> String {
    let command = toml_literal_command(path);
    format!(
        "hooks.{event}=[{{hooks=[{{type=\"command\",command='''{command}''',timeout={timeout_ms}}}]}}]"
    )
}

fn codex_shim_script(hooks: &HookScripts) -> String {
    let args = [
        codex_hook_arg("SessionStart", &hooks.session_start, 10000),
        codex_hook_arg("UserPromptSubmit", &hooks.prompt, 10000),
        codex_hook_arg("Stop", &hooks.stop, 10000),
        codex_hook_arg("PreToolUse", &hooks.pre_tool_use, 120000),
        codex_hook_arg("PostToolUse", &hooks.post_tool_use, 10000),
        codex_hook_arg("PermissionRequest", &hooks.permission_request, 120000),
        codex_hook_arg("PreCompact", &hooks.pre_compact, 10000),
        codex_hook_arg("PostCompact", &hooks.post_compact, 10000),
        codex_hook_arg("SubagentStart", &hooks.subagent_start, 10000),
        codex_hook_arg("SubagentStop", &hooks.subagent_stop, 10000),
    ];
    let mut injection = String::new();
    for arg in args {
        injection.push_str("  -c ");
        injection.push_str(&sh_single_quote(&arg));
        injection.push_str(" \\\n");
    }

    format!(
        r#"#!/bin/sh
self_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
find_real() {{
  old_ifs="$IFS"
  IFS=:
  for d in ${{PATH:-}}; do
    [ "$d" = "$self_dir" ] && continue
    candidate="$d/codex"
    [ -x "$candidate" ] || continue
    [ "$candidate" = "$0" ] && continue
    printf '%s' "$candidate"
    IFS="$old_ifs"
    return 0
  done
  IFS="$old_ifs"
  return 1
}}
should_inject() {{
  [ "$#" -eq 0 ] && return 0
  skip=0
  for arg in "$@"; do
    if [ "$skip" = "1" ]; then skip=0; continue; fi
    case "$arg" in
      -c|--config|-m|--model|-p|--profile|-C|--cd|--remote|-a|--ask-for-approval|-s|--sandbox|--output-last-message|--enable|--disable)
        skip=1; continue ;;
      --help|-h|-V|--version)
        return 1 ;;
      --)
        return 0 ;;
      -*)
        continue ;;
      exec|e|resume)
        return 0 ;;
      review|login|logout|mcp|plugin|mcp-server|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|a|archive|delete|unarchive|fork|cloud|exec-server|features|help)
        return 1 ;;
      *)
        return 0 ;;
    esac
  done
  return 0
}}
real="$(find_real)" || {{ echo "Error: codex not found in PATH" >&2; exit 127; }}
if [ "${{CHARMINAL_AGENT_SHIMS_DISABLED:-}}" = "1" ] || [ -z "${{CHARMINAL_SESSION_ID:-}}" ] || ! should_inject "$@"; then
  exec "$real" "$@"
fi
export CHARMINAL_AGENT_KIND=codex
exec "$real" \
  --enable hooks \
  --dangerously-bypass-hook-trust \
{injection}  "$@"
"#
    )
}

/// shell session 内で手動起動された `claude` / `codex` を Charminal に紐づける
/// per-session PATH shim を用意する。cmux と同じく、Charminal 内の shell にだけ
/// env + PATH を注入し、wrapper 失敗時は real binary へ pass-through する。
pub fn prepare_agent_command_shims(charminal_home: &Path, session_id: &str) -> io::Result<PathBuf> {
    let shell_dir = charminal_home.join("shell");
    let hooks = ensure_hook_scripts(&shell_dir)?;
    let shim_dir = shell_dir
        .join("session-shims")
        .join(sanitize_session_component(session_id));
    fs::create_dir_all(&shim_dir)?;

    let claude_settings_path = shim_dir.join("claude-hooks.json");
    write_if_different(&claude_settings_path, &claude_hooks_json(&hooks))?;
    write_executable_if_different(
        &shim_dir.join("claude"),
        &claude_shim_script(&claude_settings_path),
    )?;
    write_executable_if_different(&shim_dir.join("codex"), &codex_shim_script(&hooks))?;

    // port は env で渡すので file 内容は session 間で共有できるが、session ごとの
    // shim dir にしておくと self-skip / cleanup / debug が分かりやすい。
    Ok(shim_dir)
}

pub fn apply_agent_shim_env(
    cmd: &mut portable_pty::CommandBuilder,
    charminal_home: &Path,
    session_id: &str,
    hook_port: u16,
) {
    match prepare_agent_command_shims(charminal_home, session_id) {
        Ok(shim_dir) => {
            cmd.env("CHARMINAL_SESSION_ID", session_id);
            cmd.env("CHARMINAL_HOOK_PORT", hook_port.to_string());
            cmd.env("CHARMINAL_AGENT_SHIM_ROOT", &shim_dir);
            cmd.env(
                "PATH",
                path_prepend_unique(&shim_dir, &crate::build_path_env()),
            );
        }
        Err(err) => {
            eprintln!(
                "[shell-wrapper] failed to prepare agent command shims for {}: {}",
                session_id, err
            );
        }
    }
}

/// shell binary path から basename を抽出して、known な shell 名（zsh / bash /
/// fish）のいずれかなら Some で返す。それ以外は None（integration を skip）。
pub fn detect_shell_kind(shell_path: &str) -> Option<KnownShell> {
    let basename = Path::new(shell_path).file_name().and_then(|s| s.to_str())?;
    match basename {
        "zsh" | "-zsh" => Some(KnownShell::Zsh),
        "bash" | "-bash" => Some(KnownShell::Bash),
        "fish" | "-fish" => Some(KnownShell::Fish),
        _ => None,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KnownShell {
    Zsh,
    Bash,
    Fish,
}

/// Charminal-owned wrapper を経由するように `Command` を構成する。`integration`
/// が false のとき、または shell が known でないときは何もしない（caller は
/// raw shell 起動にフォールバックする）。
///
/// 副作用: zsh は env、bash は arg、fish も arg を追加する。caller は事前に
/// binary path を CommandBuilder にセットしておく前提。
pub fn apply_integration(
    cmd: &mut portable_pty::CommandBuilder,
    shell_path: &str,
    charminal_home: &Path,
) {
    let Some(kind) = detect_shell_kind(shell_path) else {
        return;
    };
    let shell_dir = charminal_home.join("shell");
    match kind {
        KnownShell::Zsh => {
            // 元 ZDOTDIR を CHARMINAL_USER_ZDOTDIR で保存し、wrapper-zsh を ZDOTDIR にする。
            // wrapper の .zshrc が CHARMINAL_USER_ZDOTDIR を ZDOTDIR に戻して user の .zshrc を chain する。
            if let Some(orig) = std::env::var_os("ZDOTDIR") {
                cmd.env("CHARMINAL_USER_ZDOTDIR", orig);
            }
            cmd.env("ZDOTDIR", shell_dir.join("wrapper-zsh"));
        }
        KnownShell::Bash => {
            cmd.arg("--rcfile");
            cmd.arg(shell_dir.join("wrapper-bash").join("init.bash"));
            cmd.arg("-i");
        }
        KnownShell::Fish => {
            // fish は config.fish が先に走る。-C で init.fish と user.fish を後段で source。
            let init_path = shell_dir.join("init.fish");
            let user_path = shell_dir.join("user.fish");
            // shell-escape 対策で path 内の single-quote を `\'` 化する。
            let init_escaped = init_path.to_string_lossy().replace('\'', "'\\''");
            let user_escaped = user_path.to_string_lossy().replace('\'', "'\\''");
            cmd.arg("-C");
            cmd.arg(format!(
                "source '{}'; if test -f '{}'; source '{}'; end",
                init_escaped, user_escaped, user_escaped,
            ));
        }
    }
}

/// 副作用なしの helper — `apply_integration` の `cmd.arg` / `cmd.env` 呼び出しを
/// test 用に dry-run できるようにする。返り値は `(env_pairs, args)`。
#[cfg(test)]
pub fn dry_run_integration(
    shell_path: &str,
    charminal_home: &Path,
    orig_zdotdir: Option<&str>,
) -> (Vec<(String, String)>, Vec<String>) {
    let kind = match detect_shell_kind(shell_path) {
        Some(k) => k,
        None => return (Vec::new(), Vec::new()),
    };
    let shell_dir = charminal_home.join("shell");
    let mut envs = Vec::new();
    let mut args = Vec::new();
    match kind {
        KnownShell::Zsh => {
            if let Some(orig) = orig_zdotdir {
                envs.push(("CHARMINAL_USER_ZDOTDIR".to_string(), orig.to_string()));
            }
            envs.push((
                "ZDOTDIR".to_string(),
                shell_dir.join("wrapper-zsh").to_string_lossy().into_owned(),
            ));
        }
        KnownShell::Bash => {
            args.push("--rcfile".to_string());
            args.push(
                shell_dir
                    .join("wrapper-bash")
                    .join("init.bash")
                    .to_string_lossy()
                    .into_owned(),
            );
            args.push("-i".to_string());
        }
        KnownShell::Fish => {
            let init_path = shell_dir.join("init.fish");
            let user_path = shell_dir.join("user.fish");
            args.push("-C".to_string());
            args.push(format!(
                "source '{}'; if test -f '{}'; source '{}'; end",
                init_path.to_string_lossy(),
                user_path.to_string_lossy(),
                user_path.to_string_lossy(),
            ));
        }
    }
    (envs, args)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_temp_root(label: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!(
            "charminal-shell-wrapper-test-{}-{}-{}",
            label,
            std::process::id(),
            nanos
        ));
        fs::create_dir_all(&p).expect("create test root");
        p
    }

    #[test]
    fn ensure_creates_init_files() {
        let root = fresh_temp_root("creates");
        ensure_shell_files(&root).expect("ensure_shell_files");
        let shell = root.join("shell");
        assert!(shell.join("init.zsh").is_file());
        assert!(shell.join("init.bash").is_file());
        assert!(shell.join("init.fish").is_file());
        assert!(shell.join("wrapper-zsh").join(".zshrc").is_file());
        assert!(shell.join("wrapper-bash").join("init.bash").is_file());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn init_scripts_install_agent_shim_functions_after_user_rc() {
        let root = fresh_temp_root("agent-shim-init");
        ensure_shell_files(&root).expect("ensure_shell_files");
        let shell = root.join("shell");

        let zsh = fs::read_to_string(shell.join("init.zsh")).unwrap();
        assert!(zsh.contains("__charminal_install_agent_shims"));
        assert!(zsh.contains("claude()"));
        assert!(zsh.contains("codex()"));

        let bash = fs::read_to_string(shell.join("init.bash")).unwrap();
        assert!(bash.contains("__charminal_install_agent_shims"));
        assert!(bash.contains("claude()"));
        assert!(bash.contains("codex()"));

        let fish = fs::read_to_string(shell.join("init.fish")).unwrap();
        assert!(fish.contains("function __charminal_install_agent_shims"));
        assert!(fish.contains("function claude"));
        assert!(fish.contains("function codex"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_does_not_touch_user_files() {
        let root = fresh_temp_root("user-files");
        let shell = root.join("shell");
        fs::create_dir_all(&shell).unwrap();
        let user_zsh = shell.join("user.zsh");
        fs::write(&user_zsh, "# user content").unwrap();

        ensure_shell_files(&root).expect("ensure_shell_files");

        let after = fs::read_to_string(&user_zsh).unwrap();
        assert_eq!(after, "# user content");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_overwrites_init_when_content_drifts() {
        let root = fresh_temp_root("drift");
        ensure_shell_files(&root).expect("first ensure");
        let init_zsh = root.join("shell").join("init.zsh");
        fs::write(&init_zsh, "# user attempted edit").unwrap();

        ensure_shell_files(&root).expect("second ensure");

        let after = fs::read_to_string(&init_zsh).unwrap();
        assert_eq!(after, INIT_ZSH);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn detect_shell_kind_handles_known_shells() {
        assert_eq!(detect_shell_kind("/bin/zsh"), Some(KnownShell::Zsh));
        assert_eq!(detect_shell_kind("/bin/bash"), Some(KnownShell::Bash));
        assert_eq!(
            detect_shell_kind("/opt/homebrew/bin/fish"),
            Some(KnownShell::Fish)
        );
        // login shell 表記
        assert_eq!(detect_shell_kind("-zsh"), Some(KnownShell::Zsh));
    }

    #[test]
    fn detect_shell_kind_returns_none_for_unknown() {
        assert_eq!(detect_shell_kind("/bin/sh"), None);
        assert_eq!(detect_shell_kind("/bin/dash"), None);
    }

    #[test]
    fn dry_run_zsh_sets_zdotdir_envs() {
        let root = fresh_temp_root("zsh-dry");
        let (envs, args) = dry_run_integration("/bin/zsh", &root, Some("/orig/zdotdir"));
        assert!(args.is_empty());
        assert_eq!(
            envs[0],
            (
                "CHARMINAL_USER_ZDOTDIR".to_string(),
                "/orig/zdotdir".to_string()
            )
        );
        assert_eq!(envs[1].0, "ZDOTDIR");
        assert!(envs[1].1.ends_with("shell/wrapper-zsh"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dry_run_bash_uses_rcfile_arg() {
        let root = fresh_temp_root("bash-dry");
        let (envs, args) = dry_run_integration("/bin/bash", &root, None);
        assert!(envs.is_empty());
        assert_eq!(args[0], "--rcfile");
        assert!(args[1].ends_with("shell/wrapper-bash/init.bash"));
        assert_eq!(args[2], "-i");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn dry_run_fish_uses_minus_c_arg() {
        let root = fresh_temp_root("fish-dry");
        let (envs, args) = dry_run_integration("/usr/local/bin/fish", &root, None);
        assert!(envs.is_empty());
        assert_eq!(args[0], "-C");
        assert!(args[1].contains("source '"));
        assert!(args[1].contains("init.fish"));
        assert!(args[1].contains("user.fish"));
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_seeds_hook_reminder_if_absent() {
        let root = fresh_temp_root("hook-seed");
        ensure_shell_files(&root).expect("ensure_shell_files");
        let hook = root.join("shell").join("hook-reminder.sh");
        assert!(hook.is_file());
        assert_eq!(fs::read_to_string(&hook).unwrap(), HOOK_REMINDER);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ensure_does_not_overwrite_existing_hook_reminder() {
        let root = fresh_temp_root("hook-keep");
        ensure_shell_files(&root).expect("first ensure");
        let hook = root.join("shell").join("hook-reminder.sh");
        fs::write(&hook, "# user customized").unwrap();

        ensure_shell_files(&root).expect("second ensure");

        let after = fs::read_to_string(&hook).unwrap();
        assert_eq!(after, "# user customized");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn prepare_agent_command_shims_writes_claude_and_codex_wrappers() {
        let root = fresh_temp_root("agent-shims");
        ensure_shell_files(&root).expect("ensure_shell_files");

        let shim_dir =
            prepare_agent_command_shims(&root, "shell:1").expect("prepare_agent_command_shims");

        assert!(shim_dir.ends_with("shell_1"));
        let claude = shim_dir.join("claude");
        let codex = shim_dir.join("codex");
        let settings = shim_dir.join("claude-hooks.json");
        assert!(claude.is_file());
        assert!(codex.is_file());
        assert!(settings.is_file());

        let claude_script = fs::read_to_string(&claude).unwrap();
        assert!(claude_script.contains("--settings"));
        assert!(claude_script.contains("CHARMINAL_AGENT_KIND=claude"));

        let codex_script = fs::read_to_string(&codex).unwrap();
        assert!(codex_script.contains("--enable hooks"));
        assert!(codex_script.contains("hooks.PermissionRequest"));
        assert!(codex_script.contains("hooks.PreCompact"));
        assert!(codex_script.contains("hooks.SubagentStop"));
        assert!(codex_script.contains("CHARMINAL_AGENT_KIND=codex"));

        let parsed: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert!(parsed["hooks"]["Notification"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("hook-notification.sh"));
        assert!(
            parsed["hooks"]["PermissionRequest"][0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains("hook-permission-request.sh")
        );
        assert!(parsed["hooks"]["TaskCompleted"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("hook-task-completed.sh"));
        assert!(parsed["hooks"]["StopFailure"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .contains("hook-stop-failure.sh"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn path_prepend_unique_moves_shim_to_front_once() {
        let shim = Path::new("/tmp/charminal-shim");
        let path = path_prepend_unique(shim, "/usr/bin:/tmp/charminal-shim:/bin");
        assert_eq!(path, "/tmp/charminal-shim:/usr/bin:/bin");
    }

    #[test]
    fn dry_run_unknown_shell_returns_empty() {
        let root = fresh_temp_root("unknown-dry");
        let (envs, args) = dry_run_integration("/bin/sh", &root, None);
        assert!(envs.is_empty());
        assert!(args.is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
