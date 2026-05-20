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
use std::path::Path;
#[cfg(test)]
use std::path::PathBuf;

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
    fn dry_run_unknown_shell_returns_empty() {
        let root = fresh_temp_root("unknown-dry");
        let (envs, args) = dry_run_integration("/bin/sh", &root, None);
        assert!(envs.is_empty());
        assert!(args.is_empty());
        let _ = fs::remove_dir_all(&root);
    }
}
