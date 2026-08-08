//! Codex app-server sidecar の spawn registry と startup reaper。
//!
//! sidecar は `CodexAppServerProcess` の Drop で殺されるが、app が force-quit /
//! crash / SIGKILL で死ぬと Drop が走らず orphan (PPID=1) として残る。Codex
//! 0.147.0 からは orphan が `~/.codex/thread-writer-locks/` の writer lock を
//! 握り続けるため、次回の `resume --last` が `-32600 already has an active
//! writer` で拒否され、Codex session の自動起動が失敗する（issue #109）。
//!
//! 対策は 2 層：
//! - spawn 時に {owner_pid, sidecar_pid, endpoint} を registry へ記録し、Drop で除去
//! - 次回起動時に、owner が死んだ entry だけを reap する
//!
//! reap は「registry に記録した endpoint がコマンドラインに現れる `codex app-server`
//! プロセス」以外を絶対に殺さない。PID 再利用や、Yorishiro 以外が起動した
//! app-server を巻き込まないための identity guard。owner の PID 再利用で
//! owner が生きて見えるケースは、sidecar 側の PPID=1（親喪失）で検出する。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SidecarEntry {
    /// sidecar を spawn した Yorishiro app process の PID。
    pub owner_pid: u32,
    /// `codex app-server --listen <endpoint>` process の PID。
    pub sidecar_pid: u32,
    /// spawn ごとに一意な listen endpoint（例: `ws://127.0.0.1:61323`）。
    /// PID 再利用時の identity guard としてコマンドライン照合に使う。
    pub endpoint: String,
}

/// reap 判定が必要とする process 観測の抽象。テストでは fake に差し替える。
pub(crate) trait ProcessProbe {
    fn is_alive(&self, pid: u32) -> bool;
    fn parent_pid(&self, pid: u32) -> Option<u32>;
    fn command_line(&self, pid: u32) -> Option<String>;
    fn terminate(&self, pid: u32);
    fn force_kill(&self, pid: u32);
}

pub fn registry_path_under(yorishiro_home: &Path) -> PathBuf {
    yorishiro_home.join("runtime").join("codex-sidecars.json")
}

fn registry_path() -> Option<PathBuf> {
    crate::yorishiro_home_path()
        .ok()
        .map(|home| registry_path_under(&home))
}

/// spawn 直後に呼ぶ。registry の失敗は spawn を止めない（session の可用性を
/// 帳簿より優先する設計判断）が、false を返して caller に警告させる。
/// 記録できなかった sidecar は crash 時に reap 不能になる。
#[must_use]
pub fn record_spawn(path: &Path, entry: SidecarEntry) -> bool {
    with_registry_lock(path, || {
        let mut entries = read_entries(path);
        entries.retain(|e| e.sidecar_pid != entry.sidecar_pid);
        entries.push(entry);
        write_entries(path, &entries)
    })
}

/// `CodexAppServerProcess` の Drop（正常 teardown）で呼ぶ。
/// owner も一致した entry だけを消す。wait() 後に他 instance が同じ PID を
/// 再利用して record した entry を巻き添えにしないため。
pub fn remove_sidecar(path: &Path, owner_pid: u32, sidecar_pid: u32) {
    with_registry_lock(path, || {
        let mut entries = read_entries(path);
        entries.retain(|e| !(e.sidecar_pid == sidecar_pid && e.owner_pid == owner_pid));
        write_entries(path, &entries);
    });
}

/// App 起動時に呼ぶ。前回 instance が leak した sidecar を回収する。
/// 最初の Codex session が `resume --last` する前に完了している必要が
/// あるため、同期実行を前提とする（stale entry がなければ即 return）。
pub fn reap_stale_sidecars() {
    let Some(path) = registry_path() else {
        return;
    };
    reap_stale_at(&path, &SystemProbe);
    reap_unrecorded_orphans_at(&path, &SystemProbe, &SystemOrphanScanner);
}

/// 3 相で reap する。kill は bounded wait（最長 2 秒）を含むため lock の外で
/// 行い、lock の保持は read-modify-write の間だけに抑える。lock を長く握ると、
/// 並行 instance の record が lock timeout 経由で走り、こちらの書き戻しに
/// 上書きされて entry を失う。
fn reap_stale_at(path: &Path, probe: &dyn ProcessProbe) {
    // Phase 1: plan を確定し、drop 対象（死骸・identity 不一致）だけを先に
    // 整理する。kill 対象は殺し終わるまで registry に残す。
    let plan = with_registry_lock(path, || {
        let entries = read_entries(path);
        if entries.is_empty() && !path.exists() {
            return None;
        }
        let plan = plan_reap(entries, probe);
        let mut retained = plan.keep.clone();
        retained.extend(plan.kill.iter().cloned());
        write_entries(path, &retained);
        Some(plan)
    });
    let Some(plan) = plan else {
        return;
    };
    if plan.kill.is_empty() {
        return;
    }

    // Phase 2: lock の外で kill。plan 確定からの時間経過で PID が別プロセスに
    // 化けている可能性に備え、signal 直前に identity を再確認する（確認と
    // signal の間の microsecond 窓は PID 指名 signal の限界として残る）。
    for entry in &plan.kill {
        if still_matches(probe, entry) {
            probe.terminate(entry.sidecar_pid);
        }
    }
    wait_for_death_or_escalate(&plan.kill, probe);

    // Phase 3: 死亡を確認できた kill 対象だけを registry から除く。並行
    // instance がその間に record した entry や生き残り（次回再挑戦）は残す。
    let mut reaped = 0usize;
    with_registry_lock(path, || {
        let mut entries = read_entries(path);
        entries.retain(|e| {
            let was_target = plan
                .kill
                .iter()
                .any(|k| k.owner_pid == e.owner_pid && k.sidecar_pid == e.sidecar_pid);
            if was_target && !probe.is_alive(e.sidecar_pid) {
                reaped += 1;
                false
            } else {
                true
            }
        });
        write_entries(path, &entries);
    });
    if reaped > 0 {
        eprintln!("[codex-sidecar] reaped {reaped} leaked app-server process(es)");
    }
}

/// 移行用 sweep が必要とする process 一覧と接続状態の観測。テストでは fake。
pub(crate) trait OrphanScanProbe {
    /// 全 process の (pid, ppid, command line)。
    fn list_processes(&self) -> Vec<(u32, u32, String)>;
    /// その port へ ESTABLISHED な TCP 接続が存在するか。
    fn has_established_client(&self, port: u16) -> bool;
}

/// registry 導入前の build（v0.6.x 以前）が leak した sidecar の移行用 sweep。
///
/// 旧 build は spawn を記録しないため registry reap では回収できない。update
/// では「旧 build が codex session を開いたまま終了 → 記録なしの orphan が
/// 最新 thread の writer lock を握る → 新 build の `resume --last` が -32600」
/// という経路が必ず成立するため、記録の代わりに以下の全条件で判定する：
///
/// 1. コマンドラインが `<codex binary> app-server --listen ws://127.0.0.1:<port>`
///    そのもの（末尾まで一致。daemon subcommand や unix socket は対象外）
/// 2. PPID = 1（spawn した親が既に死んでいる）
/// 3. registry に記録がない（記録があるものは registry reap の管轄）
/// 4. その listen port に ESTABLISHED な接続が 1 本もない
///    （生きた client が付いた server は、誰が spawn したかに関わらず殺さない）
fn reap_unrecorded_orphans_at(
    path: &Path,
    probe: &dyn ProcessProbe,
    scanner: &dyn OrphanScanProbe,
) {
    let recorded: std::collections::HashSet<u32> = with_registry_lock(path, || read_entries(path))
        .iter()
        .map(|e| e.sidecar_pid)
        .collect();
    let targets = plan_unrecorded_reap(&scanner.list_processes(), &recorded, scanner);
    if targets.is_empty() {
        return;
    }
    for entry in &targets {
        if still_matches(probe, entry) {
            probe.terminate(entry.sidecar_pid);
        }
    }
    wait_for_death_or_escalate(&targets, probe);
    let reaped = targets
        .iter()
        .filter(|e| !probe.is_alive(e.sidecar_pid))
        .count();
    if reaped > 0 {
        eprintln!(
            "[codex-sidecar] migration: reaped {reaped} unrecorded orphan app-server process(es) left by a pre-registry build"
        );
    }
}

/// 条件 1〜4 を満たす orphan を、registry reap と同じ kill 経路に流せるよう
/// `SidecarEntry` の形に合成して返す（owner は既に居ないので便宜上 1）。
fn plan_unrecorded_reap(
    processes: &[(u32, u32, String)],
    recorded_pids: &std::collections::HashSet<u32>,
    scanner: &dyn OrphanScanProbe,
) -> Vec<SidecarEntry> {
    let mut targets = Vec::new();
    for (pid, ppid, command) in processes {
        if *ppid != 1 || recorded_pids.contains(pid) {
            continue;
        }
        let Some(port) = parse_sidecar_listen_port(command.trim()) else {
            continue;
        };
        if scanner.has_established_client(port) {
            continue;
        }
        targets.push(SidecarEntry {
            owner_pid: 1,
            sidecar_pid: *pid,
            endpoint: format!("ws://127.0.0.1:{port}"),
        });
    }
    targets
}

/// コマンドラインが Yorishiro 型 sidecar の形（`<binary> app-server --listen
/// ws://127.0.0.1:<port>` で終端、binary は空白なしで "codex" を含む）なら
/// port を返す。判定を狭く保つことが安全性の根拠なので、疑わしきは None。
fn parse_sidecar_listen_port(command: &str) -> Option<u16> {
    let marker = " app-server --listen ws://127.0.0.1:";
    let idx = command.find(marker)?;
    let binary = &command[..idx];
    if binary.contains(char::is_whitespace) || !binary.contains("codex") {
        return None;
    }
    let port_str = &command[idx + marker.len()..];
    if port_str.is_empty() || !port_str.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let port: u32 = port_str.parse().ok()?;
    u16::try_from(port).ok().filter(|p| *p > 0)
}

struct ReapPlan {
    /// owner が生存中の entry。registry に残す。
    keep: Vec<SidecarEntry>,
    /// owner を失い、identity 照合も通った sidecar。kill 対象。
    kill: Vec<SidecarEntry>,
}

fn plan_reap(entries: Vec<SidecarEntry>, probe: &dyn ProcessProbe) -> ReapPlan {
    let mut keep = Vec::new();
    let mut kill = Vec::new();
    for entry in entries {
        if !probe.is_alive(entry.sidecar_pid) {
            // sidecar は既に死んでいる。registry の残骸なので落とすだけ。
            continue;
        }
        let orphaned = probe.parent_pid(entry.sidecar_pid) == Some(1);
        if probe.is_alive(entry.owner_pid) && !orphaned {
            keep.push(entry);
            continue;
        }
        match probe.command_line(entry.sidecar_pid) {
            // probe 失敗（ps が引けない等）は判定不能。registry に残して
            // 次回 startup で再判定する。reap 権を放棄しない。
            None => keep.push(entry),
            Some(command) if command_matches(&command, &entry.endpoint) => kill.push(entry),
            // identity 不一致（PID 再利用で別プロセスになっている等）は
            // 触らずに registry から落とす。
            Some(_) => {}
        }
    }
    ReapPlan { keep, kill }
}

/// コマンドラインが「registry に記録した endpoint で listen する codex app-server」
/// であることを確認する。`app-server --listen <endpoint>` の連続一致と直後の
/// 語境界を要求し、endpoint がポート番号の前方一致で別プロセスに当たる事故
/// （`:5000` vs `:50001`）や、endpoint をただ引数中に含むだけの無関係な
/// プロセスへの誤爆を防ぐ。
fn command_matches(command: &str, endpoint: &str) -> bool {
    if !command.contains("codex") {
        return false;
    }
    let needle = format!("app-server --listen {endpoint}");
    command.match_indices(&needle).any(|(idx, matched)| {
        command[idx + matched.len()..]
            .chars()
            .next()
            .is_none_or(|ch| ch.is_whitespace())
    })
}

/// signal 直前の identity 再確認。TERM 猶予中に PID が別プロセスへ再利用される
/// TOCTOU に対する防波堤。probe 失敗（None）は「確認できない＝触らない」。
fn still_matches(probe: &dyn ProcessProbe, entry: &SidecarEntry) -> bool {
    probe
        .command_line(entry.sidecar_pid)
        .is_some_and(|command| command_matches(&command, &entry.endpoint))
}

/// TERM 送信後、writer lock が解放されるのを bounded に待つ。生き残りは
/// identity を再確認したうえで KILL。
fn wait_for_death_or_escalate(targets: &[SidecarEntry], probe: &dyn ProcessProbe) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    while std::time::Instant::now() < deadline {
        if targets.iter().all(|e| !probe.is_alive(e.sidecar_pid)) {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    for entry in targets {
        if probe.is_alive(entry.sidecar_pid) && still_matches(probe, entry) {
            probe.force_kill(entry.sidecar_pid);
        }
    }
}

fn read_entries(path: &Path) -> Vec<SidecarEntry> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    // 壊れた registry は空として扱い、次の write で作り直す。
    serde_json::from_str(&raw).unwrap_or_default()
}

fn write_entries(path: &Path, entries: &[SidecarEntry]) -> bool {
    let Ok(raw) = serde_json::to_string_pretty(entries) else {
        return false;
    };
    // 書きかけの crash で registry 全体（= 将来の reap 権）を失わないよう
    // tmp + rename で atomic に置き換える。
    let tmp = path.with_extension("json.tmp");
    let result = std::fs::write(&tmp, raw).and_then(|()| std::fs::rename(&tmp, path));
    match result {
        Ok(()) => true,
        Err(e) => {
            eprintln!(
                "[codex-sidecar] registry write failed at {}: {e}",
                path.display()
            );
            false
        }
    }
}

/// registry の read-modify-write を複数 app instance 間で直列化する。
/// lock 取得に失敗しても操作自体は実行する（best effort）。app の起動・終了
/// 経路から呼ばれるため、他 instance が lock を握ったまま固まっていても
/// 無期限には待たず、bounded timeout で諦めて進む。
fn with_registry_lock<T>(path: &Path, f: impl FnOnce() -> T) -> T {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let lock_file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(path.with_extension("lock"))
        .ok();
    #[cfg(unix)]
    if let Some(ref file) = lock_file {
        use std::os::unix::io::AsRawFd;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        loop {
            let acquired =
                unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0;
            if acquired {
                break;
            }
            if std::time::Instant::now() >= deadline {
                eprintln!("[codex-sidecar] registry lock timed out; proceeding unlocked");
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    }
    let result = f();
    #[cfg(unix)]
    if let Some(ref file) = lock_file {
        use std::os::unix::io::AsRawFd;
        let _ = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    }
    drop(lock_file);
    result
}

/// 実 process に対する probe。reap 対象は他 process（自分の子ではない）なので
/// waitpid は使えず、liveness は signal 0、系譜とコマンドラインは ps で読む。
struct SystemProbe;

/// signal を送ってよい PID か。0 / 1 / pid_t に収まらない値（負値へ化けて
/// process group や全 process を指してしまう）を弾く。
#[cfg(unix)]
fn signalable(pid: u32) -> bool {
    pid > 1 && pid <= i32::MAX as u32
}

#[cfg(unix)]
impl ProcessProbe for SystemProbe {
    fn is_alive(&self, pid: u32) -> bool {
        if !signalable(pid) {
            return false;
        }
        let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
        if result == 0 {
            return true;
        }
        // EPERM は「生きているが署名できない」。所有外 process は触らない側に倒す。
        std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn parent_pid(&self, pid: u32) -> Option<u32> {
        ps_field(pid, "ppid=")?.trim().parse().ok()
    }

    fn command_line(&self, pid: u32) -> Option<String> {
        ps_field(pid, "command=")
    }

    fn terminate(&self, pid: u32) {
        if signalable(pid) {
            let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        }
    }

    fn force_kill(&self, pid: u32) {
        if signalable(pid) {
            let _ = unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
        }
    }
}

#[cfg(unix)]
fn ps_field(pid: u32, field: &str) -> Option<String> {
    let output = std::process::Command::new("ps")
        // -ww: command 列を表示幅で切り詰めさせない。切り詰められた command は
        // identity 不一致と誤判定され、entry を失う（reap 不能化）。
        .args(["-ww", "-o", field, "-p", &pid.to_string()])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// 実 system に対する移行用 sweep の観測。ps で全 process、lsof で接続を読む。
struct SystemOrphanScanner;

#[cfg(unix)]
impl OrphanScanProbe for SystemOrphanScanner {
    fn list_processes(&self) -> Vec<(u32, u32, String)> {
        let Ok(output) = std::process::Command::new("ps")
            .args(["-axww", "-o", "pid=,ppid=,command="])
            .output()
        else {
            return Vec::new();
        };
        if !output.status.success() {
            return Vec::new();
        }
        let Ok(text) = String::from_utf8(output.stdout) else {
            return Vec::new();
        };
        text.lines()
            .filter_map(|line| {
                let trimmed = line.trim_start();
                let (pid_str, rest) = trimmed.split_once(char::is_whitespace)?;
                let rest = rest.trim_start();
                let (ppid_str, command) = rest.split_once(char::is_whitespace)?;
                Some((
                    pid_str.parse().ok()?,
                    ppid_str.parse().ok()?,
                    command.trim().to_string(),
                ))
            })
            .collect()
    }

    fn has_established_client(&self, port: u16) -> bool {
        let Ok(output) = std::process::Command::new("lsof")
            .args(["-nP", &format!("-iTCP:{port}"), "-sTCP:ESTABLISHED", "-t"])
            .output()
        else {
            // 確認できないときは「client あり」に倒して殺さない。
            return true;
        };
        !String::from_utf8_lossy(&output.stdout).trim().is_empty()
    }
}

#[cfg(not(unix))]
impl OrphanScanProbe for SystemOrphanScanner {
    fn list_processes(&self) -> Vec<(u32, u32, String)> {
        Vec::new()
    }

    fn has_established_client(&self, _port: u16) -> bool {
        true
    }
}

#[cfg(not(unix))]
impl ProcessProbe for SystemProbe {
    fn is_alive(&self, _pid: u32) -> bool {
        false
    }
    fn parent_pid(&self, _pid: u32) -> Option<u32> {
        None
    }
    fn command_line(&self, _pid: u32) -> Option<String> {
        None
    }
    fn terminate(&self, _pid: u32) {}
    fn force_kill(&self, _pid: u32) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    fn entry(owner_pid: u32, sidecar_pid: u32, port: u16) -> SidecarEntry {
        SidecarEntry {
            owner_pid,
            sidecar_pid,
            endpoint: format!("ws://127.0.0.1:{port}"),
        }
    }

    fn temp_registry(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yorishiro-sidecar-registry-test-{}-{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        registry_path_under(&dir)
    }

    struct FakeProbe {
        alive: Mutex<HashSet<u32>>,
        parents: HashMap<u32, u32>,
        commands: HashMap<u32, String>,
        terminated: Mutex<Vec<u32>>,
        force_killed: Mutex<Vec<u32>>,
    }

    impl FakeProbe {
        fn new() -> Self {
            Self {
                alive: Mutex::new(HashSet::new()),
                parents: HashMap::new(),
                commands: HashMap::new(),
                terminated: Mutex::new(Vec::new()),
                force_killed: Mutex::new(Vec::new()),
            }
        }

        fn with_alive(mut self, pids: &[u32]) -> Self {
            self.alive = Mutex::new(pids.iter().copied().collect());
            self
        }

        fn with_parent(mut self, pid: u32, ppid: u32) -> Self {
            self.parents.insert(pid, ppid);
            self
        }

        fn with_command(mut self, pid: u32, command: &str) -> Self {
            self.commands.insert(pid, command.to_string());
            self
        }
    }

    impl ProcessProbe for FakeProbe {
        fn is_alive(&self, pid: u32) -> bool {
            self.alive.lock().unwrap().contains(&pid)
        }

        fn parent_pid(&self, pid: u32) -> Option<u32> {
            self.parents.get(&pid).copied()
        }

        fn command_line(&self, pid: u32) -> Option<String> {
            self.commands.get(&pid).cloned()
        }

        fn terminate(&self, pid: u32) {
            self.terminated.lock().unwrap().push(pid);
            // TERM は即死する想定。escalation 経路は専用テストで踏む。
            self.alive.lock().unwrap().remove(&pid);
        }

        fn force_kill(&self, pid: u32) {
            self.force_killed.lock().unwrap().push(pid);
            self.alive.lock().unwrap().remove(&pid);
        }
    }

    fn sidecar_command(port: u16) -> String {
        format!("/Users/x/.local/bin/codex app-server --listen ws://127.0.0.1:{port}")
    }

    #[test]
    fn record_and_remove_round_trip() {
        let path = temp_registry("round-trip");
        assert!(record_spawn(&path, entry(100, 200, 50001)));
        assert!(record_spawn(&path, entry(100, 201, 50002)));
        assert_eq!(read_entries(&path).len(), 2);

        remove_sidecar(&path, 100, 200);
        let remaining = read_entries(&path);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].sidecar_pid, 201);
    }

    #[test]
    fn remove_sidecar_ignores_entries_from_other_owners() {
        // wait() 後の PID 再利用で、他 instance が record した entry を
        // 自分の Drop が巻き添えにしないこと。
        let path = temp_registry("owner-scope");
        assert!(record_spawn(&path, entry(999, 200, 50001)));
        remove_sidecar(&path, 100, 200);
        assert_eq!(read_entries(&path).len(), 1);
    }

    #[test]
    fn command_matches_requires_exact_listen_endpoint_token() {
        let cmd = sidecar_command(50001);
        assert!(command_matches(&cmd, "ws://127.0.0.1:50001"));
        // ポート番号の前方一致では当たらない（:5000 vs :50001）
        assert!(!command_matches(&cmd, "ws://127.0.0.1:5000"));
        // endpoint を引数中に含むだけの無関係な command には当たらない
        assert!(!command_matches(
            "rg 'ws://127.0.0.1:50001' codex-app-server.log",
            "ws://127.0.0.1:50001"
        ));
        // 後続引数があっても連続一致していれば当たる
        assert!(command_matches(
            &format!("{} --extra-flag", sidecar_command(50001)),
            "ws://127.0.0.1:50001"
        ));
    }

    #[test]
    fn keeps_entry_for_retry_when_command_probe_fails() {
        // sidecar は生きているが ps が引けない（一時障害）。誤殺も放棄もせず
        // registry に残して次回 startup で再判定する。
        let probe = FakeProbe::new().with_alive(&[200]).with_parent(200, 1);
        let plan = plan_reap(vec![entry(100, 200, 50001)], &probe);
        assert_eq!(plan.keep.len(), 1);
        assert!(plan.kill.is_empty());
    }

    #[test]
    fn record_spawn_replaces_stale_entry_for_reused_sidecar_pid() {
        let path = temp_registry("pid-reuse");
        assert!(record_spawn(&path, entry(100, 200, 50001)));
        assert!(record_spawn(&path, entry(101, 200, 50002)));
        let entries = read_entries(&path);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].endpoint, "ws://127.0.0.1:50002");
    }

    #[test]
    fn corrupted_registry_is_treated_as_empty() {
        let path = temp_registry("corrupted");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, "not json").unwrap();
        assert!(read_entries(&path).is_empty());
        // reap は panic せず registry を作り直す。
        reap_stale_at(&path, &FakeProbe::new());
        assert_eq!(std::fs::read_to_string(&path).unwrap().trim(), "[]");
    }

    #[test]
    fn keeps_sidecars_whose_owner_is_still_alive() {
        let probe = FakeProbe::new()
            .with_alive(&[100, 200])
            .with_parent(200, 100)
            .with_command(200, &sidecar_command(50001));
        let plan = plan_reap(vec![entry(100, 200, 50001)], &probe);
        assert_eq!(plan.keep.len(), 1);
        assert!(plan.kill.is_empty());
    }

    #[test]
    fn kills_orphaned_sidecar_with_matching_command() {
        let probe = FakeProbe::new()
            .with_alive(&[200])
            .with_parent(200, 1)
            .with_command(200, &sidecar_command(50001));
        let plan = plan_reap(vec![entry(100, 200, 50001)], &probe);
        assert!(plan.keep.is_empty());
        assert_eq!(plan.kill.len(), 1);
    }

    #[test]
    fn reaps_sidecar_reparented_to_launchd_even_if_owner_pid_was_reused() {
        // owner PID が別 process に再利用されて生きて見えるケース。
        // sidecar の PPID=1 が親喪失の証拠になる。
        let probe = FakeProbe::new()
            .with_alive(&[100, 200])
            .with_parent(200, 1)
            .with_command(200, &sidecar_command(50001));
        let plan = plan_reap(vec![entry(100, 200, 50001)], &probe);
        assert!(plan.keep.is_empty());
        assert_eq!(plan.kill.len(), 1);
    }

    #[test]
    fn never_kills_process_whose_command_does_not_match_registry_endpoint() {
        // sidecar PID が無関係の process に再利用されたケース。触らず落とすだけ。
        let probe = FakeProbe::new()
            .with_alive(&[200])
            .with_parent(200, 1)
            .with_command(200, "/usr/bin/vim important.txt");
        let plan = plan_reap(vec![entry(100, 200, 50001)], &probe);
        assert!(plan.keep.is_empty());
        assert!(plan.kill.is_empty());
    }

    #[test]
    fn never_kills_sidecar_listening_on_a_different_endpoint() {
        let probe = FakeProbe::new()
            .with_alive(&[200])
            .with_parent(200, 1)
            .with_command(200, &sidecar_command(59999));
        let plan = plan_reap(vec![entry(100, 200, 50001)], &probe);
        assert!(plan.kill.is_empty());
    }

    #[test]
    fn drops_entries_for_dead_sidecars() {
        let probe = FakeProbe::new().with_alive(&[100]);
        let plan = plan_reap(vec![entry(100, 200, 50001)], &probe);
        assert!(plan.keep.is_empty());
        assert!(plan.kill.is_empty());
    }

    #[test]
    fn reap_terminates_stale_and_rewrites_registry() {
        let path = temp_registry("reap");
        assert!(record_spawn(&path, entry(100, 200, 50001))); // owner 生存 → keep
        assert!(record_spawn(&path, entry(999, 201, 50002))); // owner 死亡 → kill
        let probe = FakeProbe::new()
            .with_alive(&[100, 200, 201])
            .with_parent(200, 100)
            .with_parent(201, 1)
            .with_command(200, &sidecar_command(50001))
            .with_command(201, &sidecar_command(50002));

        reap_stale_at(&path, &probe);

        assert_eq!(*probe.terminated.lock().unwrap(), vec![201]);
        assert!(probe.force_killed.lock().unwrap().is_empty());
        let remaining = read_entries(&path);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].sidecar_pid, 200);
    }

    #[test]
    fn escalates_to_force_kill_when_terminate_is_ignored() {
        struct StubbornProbe(FakeProbe);
        impl ProcessProbe for StubbornProbe {
            fn is_alive(&self, pid: u32) -> bool {
                self.0.alive.lock().unwrap().contains(&pid)
            }
            fn parent_pid(&self, pid: u32) -> Option<u32> {
                self.0.parent_pid(pid)
            }
            fn command_line(&self, pid: u32) -> Option<String> {
                self.0.command_line(pid)
            }
            fn terminate(&self, pid: u32) {
                // TERM を無視する process。alive のまま残す。
                self.0.terminated.lock().unwrap().push(pid);
            }
            fn force_kill(&self, pid: u32) {
                self.0.force_kill(pid);
            }
        }

        let path = temp_registry("escalate");
        assert!(record_spawn(&path, entry(999, 201, 50002)));
        let probe = StubbornProbe(
            FakeProbe::new()
                .with_alive(&[201])
                .with_parent(201, 1)
                .with_command(201, &sidecar_command(50002)),
        );

        reap_stale_at(&path, &probe);

        assert_eq!(*probe.0.terminated.lock().unwrap(), vec![201]);
        assert_eq!(*probe.0.force_killed.lock().unwrap(), vec![201]);
        assert!(read_entries(&path).is_empty());
    }

    #[test]
    fn skips_signals_when_identity_changes_before_delivery() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        // plan 確定後・signal 送信前に PID が別プロセスへ再利用された TOCTOU。
        // 再確認で不一致になったら TERM も KILL も送らない。
        struct FlipProbe {
            command_calls: AtomicUsize,
            signalled: Mutex<Vec<u32>>,
        }
        impl ProcessProbe for FlipProbe {
            fn is_alive(&self, pid: u32) -> bool {
                pid == 200
            }
            fn parent_pid(&self, _pid: u32) -> Option<u32> {
                Some(1)
            }
            fn command_line(&self, _pid: u32) -> Option<String> {
                if self.command_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                    Some(sidecar_command(50001))
                } else {
                    Some("/usr/bin/vim important.txt".to_string())
                }
            }
            fn terminate(&self, pid: u32) {
                self.signalled.lock().unwrap().push(pid);
            }
            fn force_kill(&self, pid: u32) {
                self.signalled.lock().unwrap().push(pid);
            }
        }

        let path = temp_registry("identity-flip");
        assert!(record_spawn(&path, entry(999, 200, 50001)));
        let probe = FlipProbe {
            command_calls: AtomicUsize::new(0),
            signalled: Mutex::new(Vec::new()),
        };

        reap_stale_at(&path, &probe);

        assert!(probe.signalled.lock().unwrap().is_empty());
        // entry は残り、次回 startup で再判定される。
        assert_eq!(read_entries(&path).len(), 1);
    }

    #[test]
    fn reap_preserves_entries_recorded_concurrently_during_kill() {
        // Phase 2（lock 外の kill）中に並行 instance が record した entry を
        // Phase 3 の書き戻しが上書きで消さないこと。
        struct RecordingProbe {
            path: PathBuf,
            alive: Mutex<HashSet<u32>>,
        }
        impl ProcessProbe for RecordingProbe {
            fn is_alive(&self, pid: u32) -> bool {
                self.alive.lock().unwrap().contains(&pid)
            }
            fn parent_pid(&self, _pid: u32) -> Option<u32> {
                Some(1)
            }
            fn command_line(&self, _pid: u32) -> Option<String> {
                Some(sidecar_command(50001))
            }
            fn terminate(&self, pid: u32) {
                assert!(record_spawn(&self.path, entry(555, 556, 50999)));
                self.alive.lock().unwrap().remove(&pid);
            }
            fn force_kill(&self, _pid: u32) {}
        }

        let path = temp_registry("concurrent-record");
        assert!(record_spawn(&path, entry(999, 200, 50001)));
        let probe = RecordingProbe {
            path: path.clone(),
            alive: Mutex::new([200].into_iter().collect()),
        };

        reap_stale_at(&path, &probe);

        let remaining = read_entries(&path);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].sidecar_pid, 556);
    }

    struct FakeScanner {
        processes: Vec<(u32, u32, String)>,
        established_ports: HashSet<u16>,
    }

    impl OrphanScanProbe for FakeScanner {
        fn list_processes(&self) -> Vec<(u32, u32, String)> {
            self.processes.clone()
        }

        fn has_established_client(&self, port: u16) -> bool {
            self.established_ports.contains(&port)
        }
    }

    #[test]
    fn parses_only_exact_sidecar_command_shapes() {
        assert_eq!(
            parse_sidecar_listen_port(
                "/Users/x/.local/bin/codex app-server --listen ws://127.0.0.1:50001"
            ),
            Some(50001)
        );
        // daemon subcommand・unix socket・追加引数・非 loopback・codex 以外の
        // binary・空白入り binary はすべて対象外。
        assert_eq!(
            parse_sidecar_listen_port("codex app-server daemon run --port 50001"),
            None
        );
        assert_eq!(
            parse_sidecar_listen_port("codex app-server --listen unix:///tmp/x.sock"),
            None
        );
        assert_eq!(
            parse_sidecar_listen_port("codex app-server --listen ws://127.0.0.1:50001 --extra"),
            None
        );
        assert_eq!(
            parse_sidecar_listen_port("codex app-server --listen ws://0.0.0.0:50001"),
            None
        );
        assert_eq!(
            parse_sidecar_listen_port("/usr/bin/other app-server --listen ws://127.0.0.1:50001"),
            None
        );
        assert_eq!(
            parse_sidecar_listen_port("rg foo codex app-server --listen ws://127.0.0.1:50001"),
            None
        );
        assert_eq!(
            parse_sidecar_listen_port("codex app-server --listen ws://127.0.0.1:"),
            None
        );
    }

    #[test]
    fn plan_unrecorded_targets_only_abandoned_unrecorded_clientless_sidecars() {
        let sidecar = |pid: u32, ppid: u32, port: u16| (pid, ppid, sidecar_command(port));
        let processes = vec![
            sidecar(300, 1, 50001),            // 対象: 孤児・未記録・client なし
            sidecar(301, 4242, 50002),         // 親が生きている → 対象外
            sidecar(302, 1, 50003),            // registry に記録あり → 対象外
            sidecar(303, 1, 50004),            // ESTABLISHED client あり → 対象外
            (304, 1, "/usr/bin/vim x".into()), // 形が違う → 対象外
        ];
        let recorded = HashSet::from([302u32]);
        let scanner = FakeScanner {
            processes: processes.clone(),
            established_ports: HashSet::from([50004u16]),
        };

        let targets = plan_unrecorded_reap(&processes, &recorded, &scanner);

        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].sidecar_pid, 300);
        assert_eq!(targets[0].endpoint, "ws://127.0.0.1:50001");
    }

    #[test]
    fn migration_sweep_kills_pre_registry_orphan_end_to_end() {
        let path = temp_registry("migration");
        let probe = FakeProbe::new()
            .with_alive(&[300])
            .with_command(300, &sidecar_command(50001));
        let scanner = FakeScanner {
            processes: vec![(300, 1, sidecar_command(50001))],
            established_ports: HashSet::new(),
        };

        reap_unrecorded_orphans_at(&path, &probe, &scanner);

        assert_eq!(*probe.terminated.lock().unwrap(), vec![300]);
    }

    #[test]
    fn migration_sweep_skips_orphan_when_identity_recheck_fails() {
        // plan と signal の間に PID が別プロセスへ化けた場合、still_matches の
        // 再確認で signal を送らない。
        let path = temp_registry("migration-flip");
        let probe = FakeProbe::new()
            .with_alive(&[300])
            .with_command(300, "/usr/bin/vim important.txt");
        let scanner = FakeScanner {
            processes: vec![(300, 1, sidecar_command(50001))],
            established_ports: HashSet::new(),
        };

        reap_unrecorded_orphans_at(&path, &probe, &scanner);

        assert!(probe.terminated.lock().unwrap().is_empty());
        assert!(probe.force_killed.lock().unwrap().is_empty());
    }

    /// SystemProbe の実バインディング（signal 0 / ps 読み）を実 process で検証する。
    #[cfg(unix)]
    #[test]
    fn system_probe_reads_real_process_state() {
        let probe = SystemProbe;
        let me = std::process::id();
        assert!(probe.is_alive(me));

        let mut child = std::process::Command::new("/bin/sleep")
            .arg("30")
            .spawn()
            .expect("spawn sleep");
        let pid = child.id();
        assert!(probe.is_alive(pid));
        assert_eq!(probe.parent_pid(pid), Some(me));
        assert!(probe
            .command_line(pid)
            .is_some_and(|command| command.contains("sleep")));

        probe.terminate(pid);
        let _ = child.wait();
        assert!(!probe.is_alive(pid));
    }
}
