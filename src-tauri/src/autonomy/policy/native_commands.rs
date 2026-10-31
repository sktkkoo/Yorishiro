//! Evaluate the fixed host delivery commands against retained command rules.
//! No credentials or model execution are needed by the native rule evaluator.
use std::path::{Path, PathBuf};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;

pub(in crate::autonomy) struct NativeCommandPolicy {
    binary: Option<PathBuf>,
    home: tempfile::TempDir,
    root: PathBuf,
    rules: PathBuf,
}

impl NativeCommandPolicy {
    pub(in crate::autonomy) fn new(root: &Path, restrictions: &str) -> Result<Self, String> {
        let home = tempfile::Builder::new()
            .prefix("yorishiro-native-policy-")
            .tempdir()
            .map_err(|_| "公開操作の制限確認を準備できません")?;
        // Reuse the same literal-only, restrictive subset as the worker. Allow
        // rules cannot grant authority to this capability or override a deny.
        let restrictions = super::restrictive_rules(restrictions)
            .map_err(|_| "公開操作に適用する既存の制限を読み取れません")?;
        let rules = super::write_rules(home.path(), &restrictions)?;
        let binary = if restrictions.trim().is_empty() {
            None
        } else {
            Some(
                crate::resolve_command_path_impl("codex")
                    .map(PathBuf::from)
                    .ok_or("既存の実行制限の確認にはCodex CLIが必要です")?,
            )
        };
        Ok(Self {
            binary,
            home,
            root: root.to_owned(),
            rules,
        })
    }

    pub(in crate::autonomy) async fn check_tokens(
        &self,
        args: &[String],
        step: &str,
        cancel: CancellationToken,
    ) -> Result<(), String> {
        if cancel.is_cancelled() {
            return Err("公開操作を停止しました".into());
        }
        if args.is_empty() || args[0].is_empty() {
            return Err("公開操作のコマンドを確認できません".into());
        }
        let Some(binary) = &self.binary else {
            return Ok(());
        };
        if !crate::autonomy::development::policy_allows(
            binary,
            self.home.path(),
            &self.root,
            &self.rules,
            args,
            cancel,
        )
        .await?
        {
            return Err(format!(
                "{step}は既存のコマンド制限で禁止または個別確認の対象です。制限は変更せず、公開処理を停止しました"
            ));
        }
        Ok(())
    }

    /// Check literal argv, its basename spelling, and a fixed semantic spelling
    /// where host-owned global flags would otherwise hide `git push` from rules.
    pub(in crate::autonomy) async fn check(
        &self,
        command: &Command,
        semantic: Option<&[String]>,
        step: &str,
        cancel: CancellationToken,
    ) -> Result<(), String> {
        for args in command_variants(command, semantic)? {
            self.check_tokens(&args, step, cancel.clone()).await?;
        }
        Ok(())
    }
}

fn command_variants(
    command: &Command,
    semantic: Option<&[String]>,
) -> Result<Vec<Vec<String>>, String> {
    let command = command.as_std();
    let actual = std::iter::once(command.get_program())
        .chain(command.get_args())
        .map(|arg| {
            arg.to_str()
                .map(str::to_owned)
                .ok_or_else(|| "公開操作のコマンドを確認できません".to_owned())
        })
        .collect::<Result<Vec<_>, _>>()?;
    let name = Path::new(&actual[0])
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or("公開操作の実行ファイルを確認できません")?;
    let mut basename = actual.clone();
    basename[0] = name.to_owned();
    let mut variants = vec![actual.clone()];
    if basename != actual {
        variants.push(basename);
    }
    if let Some(semantic) = semantic {
        if semantic.first().map(String::as_str) != Some(name) {
            return Err("公開操作の実行ファイルと制限確認の対象が一致しません".into());
        }
        if !variants.iter().any(|args| args == semantic) {
            variants.push(semantic.to_vec());
        }
        let mut absolute_semantic = semantic.to_vec();
        absolute_semantic[0] = actual[0].clone();
        if !variants.iter().any(|args| args == &absolute_semantic) {
            variants.push(absolute_semantic);
        }
    }
    Ok(variants)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absolute_tools_and_global_git_flags_do_not_hide_restricted_operations() {
        let mut command = Command::new("/usr/bin/git");
        command.args([
            "-c",
            "core.hooksPath=/dev/null",
            "push",
            "https://github.com/o/r.git",
        ]);
        let semantic = vec![
            "git".into(),
            "push".into(),
            "https://github.com/o/r.git".into(),
        ];
        let variants = command_variants(&command, Some(&semantic)).unwrap();
        assert_eq!(variants[0][0], "/usr/bin/git");
        assert_eq!(variants[1][0], "git");
        assert_eq!(variants[2], semantic);
        assert_eq!(&variants[3][..2], &["/usr/bin/git", "push"]);
        assert!(command_variants(&command, Some(&["gh".into(), "pr".into()])).is_err());
    }

    #[tokio::test]
    async fn empty_policy_still_observes_cancellation_and_invalid_commands() {
        let root = tempfile::tempdir().unwrap();
        let policy = NativeCommandPolicy::new(root.path(), "").unwrap();
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        assert!(policy
            .check_tokens(&["git".into()], "test", cancelled)
            .await
            .is_err());
        assert!(policy
            .check_tokens(&[], "test", CancellationToken::new())
            .await
            .is_err());
    }

    #[tokio::test]
    #[ignore = "requires the installed Codex rule evaluator; no model or network call"]
    async fn native_delivery_rules_use_real_evaluator_for_each_operation() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path().canonicalize().unwrap();
        let mut push = Command::new("/usr/bin/git");
        push.args([
            "-c",
            "http.sslVerify=true",
            "push",
            "https://github.com/o/r.git",
        ]);
        let semantic = vec![
            "git".into(),
            "push".into(),
            "https://github.com/o/r.git".into(),
        ];
        let unrelated = NativeCommandPolicy::new(&root,
            "prefix_rule(pattern=['rm'], decision='prompt')\nprefix_rule(pattern=['git','clean'], decision='forbidden')").unwrap();
        unrelated
            .check(&push, Some(&semantic), "push", CancellationToken::new())
            .await
            .unwrap();
        for rule in [
            "prefix_rule(pattern=['git','push'], decision='forbidden')",
            "prefix_rule(pattern=['/usr/bin/git'], decision='forbidden')",
            "prefix_rule(pattern=['/usr/bin/git','push'], decision='forbidden')",
        ] {
            let policy = NativeCommandPolicy::new(&root, rule).unwrap();
            assert!(policy
                .check(&push, Some(&semantic), "push", CancellationToken::new())
                .await
                .is_err());
        }
        let policy = NativeCommandPolicy::new(&root,
            "prefix_rule(pattern=['git','commit'], decision='prompt')\nprefix_rule(pattern=['gh','pr','create'], decision='forbidden')").unwrap();
        let mut commit = Command::new("/usr/bin/git");
        commit.args(["commit", "-m", "Reviewed change"]);
        assert!(policy
            .check(&commit, None, "commit", CancellationToken::new())
            .await
            .is_err());
        let mut create = Command::new("/opt/homebrew/bin/gh");
        create.args(["pr", "create", "--repo", "o/r"]);
        assert!(policy
            .check(&create, None, "PR", CancellationToken::new())
            .await
            .is_err());
    }
}
