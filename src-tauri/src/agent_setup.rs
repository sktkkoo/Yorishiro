//! ユーザーが選択した CLI の公式インストーラーを実行する IO 境界。
//! コマンド・配布元は固定し、認証や既存のエージェント設定には触れない。

use serde::Serialize;
use std::collections::HashSet;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::Emitter;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::{Child, Command};

const OUTPUT_EVENT: &str = "agent-install-output";
const MAX_OUTPUT_BYTES: usize = 256 * 1024;
const MAX_SCRIPT_BYTES: u64 = 1024 * 1024;
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(130);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(600);
const VERSION_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum InstallableAgent {
    Claude,
    Codex,
}

impl InstallableAgent {
    fn parse(agent: &str) -> Result<Self, String> {
        match agent {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err("Only Claude Code and Codex can be installed here.".to_string()),
        }
    }

    fn command(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    fn installer_url(self) -> &'static str {
        match self {
            Self::Claude => "https://claude.ai/install.sh",
            Self::Codex => "https://chatgpt.com/codex/install.sh",
        }
    }

    fn shell(self) -> &'static str {
        match self {
            Self::Claude => "/bin/bash",
            Self::Codex => "/bin/sh",
        }
    }
}

#[derive(Serialize)]
pub struct InstalledAgent {
    agent: InstallableAgent,
    path: String,
}

#[derive(Clone, Serialize)]
struct InstallOutput<'a> {
    agent: InstallableAgent,
    stream: &'static str,
    text: &'a str,
}

#[derive(Default)]
struct ActiveInstalls(Mutex<HashSet<InstallableAgent>>);

impl ActiveInstalls {
    fn acquire(&self, agent: InstallableAgent) -> Result<InstallGuard<'_>, String> {
        let mut active = self
            .0
            .lock()
            .map_err(|_| "Unable to read installation state.".to_string())?;
        if !active.insert(agent) {
            return Err(format!(
                "{} installation is already running.",
                agent.command()
            ));
        }
        Ok(InstallGuard {
            active: self,
            agent,
        })
    }
}

struct InstallGuard<'a> {
    active: &'a ActiveInstalls,
    agent: InstallableAgent,
}

impl Drop for InstallGuard<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.active.0.lock() {
            active.remove(&self.agent);
        }
    }
}

/// 改行のない出力も固定サイズで読み、ログをメモリに蓄積しない。
async fn forward_output<R: AsyncRead + Unpin>(
    mut reader: R,
    stream: &'static str,
    emit: &impl Fn(&'static str, &str),
) -> std::io::Result<()> {
    let mut buffer = [0_u8; 4096];
    let mut pending = 0;
    loop {
        let length = reader.read(&mut buffer[pending..]).await?;
        if length == 0 {
            if pending > 0 {
                emit(stream, &String::from_utf8_lossy(&buffer[..pending]));
            }
            return Ok(());
        }
        let total = pending + length;
        let mut remaining = &buffer[..total];
        let mut complete = total;
        // 不正な byte は置換するが、読取境界で分割された最大 3 byte の末尾は残す。
        while let Err(error) = std::str::from_utf8(remaining) {
            if let Some(invalid_length) = error.error_len() {
                remaining = &remaining[error.valid_up_to() + invalid_length..];
            } else {
                complete = total - remaining.len() + error.valid_up_to();
                break;
            }
        }
        if complete > 0 {
            emit(stream, &String::from_utf8_lossy(&buffer[..complete]));
        }
        buffer.copy_within(complete..total, 0);
        pending = total - complete;
    }
}

/// キャンセルやエラーでもシェルの子孫を残さない。
struct InstallerProcess {
    child: Child,
    #[cfg(unix)]
    process_group: Option<u32>,
}

impl InstallerProcess {
    fn terminate(&mut self) {
        #[cfg(unix)]
        if let Some(id) = self.process_group.take() {
            // spawn 時に独立した process group を割り当てている。
            unsafe {
                libc::kill(-(id as i32), libc::SIGKILL);
            }
        }
        let _ = self.child.start_kill();
    }
}

impl Drop for InstallerProcess {
    fn drop(&mut self) {
        self.terminate();
    }
}

async fn run_process(
    mut command: Command,
    stage: &str,
    timeout: Duration,
    emit: &impl Fn(&'static str, &str),
) -> Result<(), String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);

    let child = command
        .spawn()
        .map_err(|error| format!("{stage} could not start: {error}"))?;
    let mut process = InstallerProcess {
        #[cfg(unix)]
        process_group: child.id(),
        child,
    };
    let stdout = process
        .child
        .stdout
        .take()
        .ok_or("Missing installer stdout.")?;
    let stderr = process
        .child
        .stderr
        .take()
        .ok_or("Missing installer stderr.")?;
    let result = tokio::time::timeout(timeout, async {
        let (status, (), ()) = tokio::try_join!(
            process.child.wait(),
            forward_output(stdout, "stdout", emit),
            forward_output(stderr, "stderr", emit),
        )?;
        Ok::<_, std::io::Error>(status)
    })
    .await;

    let result = match result {
        Ok(Ok(status)) if status.success() => Ok(()),
        Ok(Ok(status)) => Err(format!(
            "{stage} failed ({status}). See the installation output."
        )),
        Ok(Err(error)) => Err(format!("{stage} failed: {error}")),
        Err(_) => Err(format!(
            "{stage} timed out after {} seconds.",
            timeout.as_secs()
        )),
    };
    // wait 自体が失敗した場合も kill 後に回収を試みる。
    process.terminate();
    let _ = process.child.wait().await;
    result
}

fn installed_path(agent: InstallableAgent) -> Option<String> {
    crate::resolve_command_path_impl(agent.command())
}

fn installer_command(agent: InstallableAgent, script: &Path) -> Command {
    let mut command = Command::new(agent.shell());
    command
        .arg(script)
        .env("PATH", crate::build_path_env())
        .env_remove("BASH_ENV")
        .env_remove("ENV");
    if agent == InstallableAgent::Codex {
        // 公式スクリプトの既定 ~/.local/bin を使い、導入後の起動・削除の対話は行わない。
        command
            .env_remove("CODEX_INSTALL_DIR")
            .env("CODEX_NON_INTERACTIVE", "true");
    }
    command
}

async fn install_agent(
    agent: InstallableAgent,
    emit: &impl Fn(&'static str, &str),
) -> Result<InstalledAgent, String> {
    if !cfg!(unix) {
        return Err("In-app installation is available on macOS and Linux. Use the official installation guide on this platform.".to_string());
    }
    #[cfg(unix)]
    if unsafe { libc::geteuid() } == 0 {
        return Err(
            "Run Yorishiro as your normal user to install an agent without sudo.".to_string(),
        );
    }
    if let Some(path) = installed_path(agent) {
        // 再描画や古い検出結果から再要求されても、既存の導入は変更しない。
        return Ok(InstalledAgent { agent, path });
    }

    let home = dirs::home_dir().ok_or("Unable to find your home directory.")?;
    let script = tempfile::Builder::new()
        .prefix("yorishiro-agent-install-")
        .suffix(".sh")
        .tempfile()
        .map_err(|error| format!("Unable to create installer temporary file: {error}"))?;

    emit("status", "Downloading the official installer…\n");
    let mut download = Command::new("/usr/bin/curl");
    download
        .args([
            "--disable",
            "--fail",
            "--silent",
            "--show-error",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--connect-timeout",
            "15",
            "--max-time",
            "120",
            "--max-filesize",
            "1048576",
            "--output",
        ])
        .arg(script.path())
        .arg(agent.installer_url())
        .current_dir(&home);
    // パイプではなく終了コードを確認してから実行し、失敗した取得を成功扱いにしない。
    run_process(download, "Installer download", DOWNLOAD_TIMEOUT, emit).await?;
    let script_length = script
        .as_file()
        .metadata()
        .map_err(|error| format!("Unable to inspect downloaded installer: {error}"))?
        .len();
    if script_length == 0 || script_length > MAX_SCRIPT_BYTES {
        return Err("The official installer download was empty or too large.".to_string());
    }

    emit("status", "Running the official installer…\n");
    let mut command = installer_command(agent, script.path());
    command.current_dir(&home);
    run_process(command, "Agent installation", INSTALL_TIMEOUT, emit).await?;

    let path = installed_path(agent).ok_or_else(|| {
        format!("The installer finished, but an executable {} was not found. Check the output or use the official installation guide.", agent.command())
    })?;
    emit("status", "Checking the installed command…\n");
    let mut version = Command::new(&path);
    version
        .arg("--version")
        .env("PATH", crate::build_path_env())
        .current_dir(&home);
    run_process(version, "Installed command check", VERSION_TIMEOUT, emit).await?;
    emit(
        "status",
        "Installation complete. Sign in with your own account when the agent starts.\n",
    );
    Ok(InstalledAgent { agent, path })
}

/// 明示的な導入操作だけから呼ぶ。任意の URL・コマンド・認証情報を受け付けない。
#[tauri::command]
pub async fn install_terminal_agent(
    app: tauri::AppHandle,
    agent: String,
) -> Result<InstalledAgent, String> {
    static ACTIVE_INSTALLS: OnceLock<ActiveInstalls> = OnceLock::new();
    let agent = InstallableAgent::parse(&agent)?;
    let _guard = ACTIVE_INSTALLS
        .get_or_init(ActiveInstalls::default)
        .acquire(agent)?;
    let emitted = AtomicUsize::new(0);
    let emit =
        |stream, text: &str| {
            if stream != "status" {
                let previous = emitted.fetch_add(text.len(), Ordering::Relaxed);
                if previous >= MAX_OUTPUT_BYTES {
                    return;
                }
                if previous + text.len() > MAX_OUTPUT_BYTES {
                    let _ = app.emit_to("main", OUTPUT_EVENT, InstallOutput {
                    agent,
                    stream: "status",
                    text: "Further installer output is hidden. Installation is still running.\n",
                });
                    return;
                }
            }
            let _ = app.emit_to(
                "main",
                OUTPUT_EVENT,
                InstallOutput {
                    agent,
                    stream,
                    text,
                },
            );
        };
    install_agent(agent, &emit).await
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn collect_bytewise_output(bytes: &[u8]) -> String {
        use tokio::io::AsyncWriteExt;

        // 1 byte の pipe で、日本語・絵文字の全ての byte 境界に読取を分割する。
        let (mut writer, reader) = tokio::io::duplex(1);
        let output = Mutex::new(String::new());
        let emit = |_, text: &str| output.lock().unwrap().push_str(text);
        let (read_result, ()) = tokio::join!(forward_output(reader, "stdout", &emit), async {
            writer.write_all(bytes).await.unwrap();
            drop(writer);
        });
        read_result.unwrap();
        output.into_inner().unwrap()
    }

    #[tokio::test]
    async fn output_preserves_utf8_characters_split_across_reads() {
        let expected = "導入中… 🐈‍⬛\n完了 ✅";
        assert_eq!(collect_bytewise_output(expected.as_bytes()).await, expected);
    }

    #[tokio::test]
    async fn output_replaces_invalid_bytes_and_incomplete_final_character() {
        assert_eq!(
            collect_bytewise_output(&[b'x', 0xff, 0xe3, 0x81, 0x82, b'y', 0xf0, 0x9f]).await,
            "x�あy�"
        );
    }

    #[test]
    fn agent_allowlist_rejects_command_and_url_input() {
        for input in [
            "",
            "opencode",
            "claude; touch /tmp/no",
            "https://example.com/install.sh",
            "/bin/sh",
            "CODEX",
        ] {
            assert!(InstallableAgent::parse(input).is_err(), "accepted {input}");
        }
        assert_eq!(
            InstallableAgent::parse("claude"),
            Ok(InstallableAgent::Claude)
        );
        assert_eq!(
            InstallableAgent::parse("codex"),
            Ok(InstallableAgent::Codex)
        );
    }

    #[test]
    fn duplicate_install_is_blocked_until_guard_drops() {
        let installs = ActiveInstalls::default();
        let guard = installs.acquire(InstallableAgent::Claude).unwrap();
        assert!(installs.acquire(InstallableAgent::Claude).is_err());
        let _other = installs.acquire(InstallableAgent::Codex).unwrap();
        drop(guard);
        assert!(installs.acquire(InstallableAgent::Claude).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn plain_file_is_not_an_installed_executable() {
        use std::os::unix::fs::PermissionsExt;
        let file = tempfile::NamedTempFile::new().unwrap();
        assert!(!crate::command_path_is_executable(file.path()));
        std::fs::set_permissions(file.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
        assert!(crate::command_path_is_executable(file.path()));
        assert!(!crate::command_path_is_executable(
            file.path().parent().unwrap()
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn subprocess_failure_preserves_output_and_releases_install_guard() {
        let installs = ActiveInstalls::default();
        let outputs = Mutex::new(Vec::new());
        {
            let _guard = installs.acquire(InstallableAgent::Codex).unwrap();
            let mut command = Command::new("/bin/sh");
            command.args([
                "-c",
                "printf 'started'; printf 'download failed' >&2; exit 22",
            ]);
            let result = run_process(
                command,
                "Fixture download",
                Duration::from_secs(3),
                &|stream, text| {
                    outputs.lock().unwrap().push((stream, text.to_string()));
                },
            )
            .await;
            assert!(result.unwrap_err().contains("failed"));
        }
        let outputs = outputs.lock().unwrap();
        assert!(outputs
            .iter()
            .any(|(stream, text)| *stream == "stdout" && text == "started"));
        assert!(outputs
            .iter()
            .any(|(stream, text)| *stream == "stderr" && text == "download failed"));
        assert!(installs.acquire(InstallableAgent::Codex).is_ok());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_stops_child_and_descendants() {
        let output = Mutex::new(String::new());
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 60 & printf '%s' $!; wait"]);
        let result = run_process(
            command,
            "Fixture installer",
            Duration::from_millis(150),
            &|stream, text| {
                if stream == "stdout" {
                    output.lock().unwrap().push_str(text);
                }
            },
        )
        .await;
        assert!(result.unwrap_err().contains("timed out"));
        let pid = output.lock().unwrap().parse::<i32>().unwrap();
        // 孤児の回収は OS に任せる。Linux の zombie は停止済みとして扱う。
        for _ in 0..50 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return;
            }
            #[cfg(target_os = "linux")]
            if std::fs::read_to_string(format!("/proc/{pid}/stat")).is_ok_and(|stat| {
                stat.rsplit_once(") ")
                    .is_some_and(|(_, rest)| rest.starts_with("Z "))
            }) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("installer descendant survived timeout");
    }
}
