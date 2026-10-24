//! Cleanup for ordinary detached descendants, independent of POSIX groups.
//!
//! A random inherited marker discovers early-orphaned children; observed children
//! remain tracked after removing it. macOS audit-token signaling checks the
//! kernel PID incarnation atomically, so recycled PIDs are never signaled.
//! This is NOT hostile-process containment: a process that removes the marker
//! before observation and immediately reparents can evade discovery. Such code
//! requires a VM. Immutable review artifacts remain outside the writable clone.
use std::future::Future;
use std::sync::Arc;
use tokio::process::Command;

#[cfg(target_os = "macos")]
pub const MARKER: &str = "YORISHIRO_AUTONOMY_RUN_ID";
#[derive(Clone, Debug)]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub enum CleanupProgress {
    Pending,
    Blocked(String),
    Complete,
}
pub type Observer = Arc<dyn Fn(CleanupProgress) + Send + Sync>;
tokio::task_local! { static OBSERVER: Observer; }

pub async fn observe_cleanup<F: Future>(observer: Observer, future: F) -> F::Output {
    OBSERVER.scope(observer, future).await
}

pub struct Supervisor {
    #[cfg(target_os = "macos")]
    observer: Option<Observer>,
    #[cfg(target_os = "macos")]
    stop: Option<std::sync::mpsc::Sender<macos::Control>>,
    #[cfg(target_os = "macos")]
    done: Option<tokio::sync::oneshot::Receiver<()>>,
}

impl Supervisor {
    pub fn prepare(command: &mut Command) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        {
            macos::verify()?;
            let marker = uuid::Uuid::new_v4().to_string();
            command.env(MARKER, &marker);
            let observer = OBSERVER.try_with(Arc::clone).ok();
            let thread_observer = observer.clone();
            let (stop, control) = std::sync::mpsc::channel();
            let (ack, done) = tokio::sync::oneshot::channel();
            let since = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "プロセス監視の開始時刻を確認できません")?
                .as_secs()
                .saturating_sub(5);
            std::thread::Builder::new()
                .name("autonomy-process-supervisor".into())
                .spawn(move || macos::supervise(marker, since, control, ack, thread_observer))
                .map_err(|_| "子プロセスの監視を開始できません")?;
            Ok(Self {
                observer,
                stop: Some(stop),
                done: Some(done),
            })
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = command;
            Err("子プロセスまで確認して停止する自律作業は、現在macOSのみ対応しています。この環境では開始しません。".into())
        }
    }

    pub fn attach(&self, pid: u32) {
        #[cfg(target_os = "macos")]
        if let Some(sender) = &self.stop {
            // Called before Child::wait, so this child PID cannot be recycled.
            if let Ok(Some(identity)) = macos::identity(pid as i32) {
                let _ = sender.send(macos::Control::Attach(identity));
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = pid;
    }

    /// Does not acknowledge completion while enumeration fails or known owned
    /// processes remain. The independent thread also survives a dropped future.
    pub async fn finish(&mut self) {
        #[cfg(target_os = "macos")]
        {
            if let Some(sender) = self.stop.take() {
                if let Some(observer) = &self.observer {
                    observer(CleanupProgress::Pending);
                }
                let _ = sender.send(macos::Control::Finish);
            }
            if let Some(done) = self.done.take() {
                if done.await.is_err() {
                    // A lost supervisor is not proof that its processes stopped.
                    if let Ok(observer) = OBSERVER.try_with(Arc::clone) {
                        observer(CleanupProgress::Blocked("子プロセスの停止確認が中断されました。安全のため次の作業は開始していません。".into()));
                    }
                    std::future::pending::<()>().await;
                }
            }
        }
    }
}

impl Drop for Supervisor {
    fn drop(&mut self) {
        #[cfg(target_os = "macos")]
        if let Some(sender) = self.stop.take() {
            if let Some(observer) = &self.observer {
                observer(CleanupProgress::Pending);
            }
            let _ = sender.send(macos::Control::Finish);
        }
    }
}

#[cfg(all(test, not(target_os = "macos")))]
mod unsupported_tests {
    use super::*;
    #[test]
    fn unsupported_platform_rejects_before_spawning_any_command() {
        let mut command = Command::new("must-not-be-started");
        let error = Supervisor::prepare(&mut command)
            .err()
            .expect("must fail before spawn");
        assert!(error.contains("macOS"));
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use super::{CleanupProgress, Observer, MARKER};
    use std::collections::{HashMap, HashSet};
    use std::sync::mpsc::{Receiver, RecvTimeoutError};
    use std::time::{Duration, Instant};

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
    pub(super) struct Identity([u32; 8]);
    impl Identity {
        fn pid(self) -> i32 {
            self.0[5] as i32
        }
    }
    pub(super) enum Control {
        Attach(Identity),
        Finish,
    }
    unsafe extern "C" {
        fn mach_task_self() -> u32;
        fn task_name_for_pid(task: u32, pid: i32, name: *mut u32) -> i32;
        fn mach_port_deallocate(task: u32, name: u32) -> i32;
        fn proc_signal_with_audittoken(token: *mut u32, signal: i32) -> i32;
    }

    fn bsd(pid: i32) -> Result<Option<libc::proc_bsdinfo>, String> {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::uninit();
        let size = std::mem::size_of::<libc::proc_bsdinfo>() as i32;
        let count = unsafe {
            libc::proc_pidinfo(
                pid,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                size,
            )
        };
        if count == size {
            Ok(Some(unsafe { info.assume_init() }))
        } else if std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH) {
            Ok(None)
        } else {
            Err("子プロセスの状態を確認できません。停止確認を続けています。".into())
        }
    }

    pub(super) fn identity(pid: i32) -> Result<Option<Identity>, String> {
        let mut port = 0;
        let result = unsafe { task_name_for_pid(mach_task_self(), pid, &mut port) };
        if result != 0 {
            return if bsd(pid)?.is_none_or(|info| info.pbi_status == 5) {
                Ok(None)
            } else {
                Err("子プロセスの識別情報を確認できません。停止確認を続けています。".into())
            };
        }
        let mut token = [0u32; 8];
        let mut count = 8;
        let result = unsafe { libc::task_info(port, 15, token.as_mut_ptr().cast(), &mut count) };
        unsafe {
            mach_port_deallocate(mach_task_self(), port);
        }
        if result != 0 || count != 8 || token[5] != pid as u32 {
            return if bsd(pid)?.is_none_or(|info| info.pbi_status == 5) {
                Ok(None)
            } else {
                Err("子プロセスの識別情報を確認できません。停止確認を続けています。".into())
            };
        }
        Ok(Some(Identity(token)))
    }

    fn signal(identity: Identity, signal: i32) -> Result<(), String> {
        let mut token = identity.0;
        let status = unsafe { proc_signal_with_audittoken(token.as_mut_ptr(), signal) };
        if status == 0 || status == libc::ESRCH {
            return Ok(());
        }
        Err("子プロセスを停止できません。停止確認を続けています。".into())
    }

    fn pids() -> Result<Vec<i32>, String> {
        for _ in 0..3 {
            let size = unsafe {
                libc::proc_listpids(
                    4, /* PROC_UID_ONLY, public sys/proc_info.h */
                    libc::geteuid(),
                    std::ptr::null_mut(),
                    0,
                )
            };
            if size <= 0 || size > 4 * 1024 * 1024 {
                break;
            }
            let mut pids = vec![0i32; size as usize / 4 + 256];
            let capacity = (pids.len() * 4) as i32;
            let used = unsafe {
                libc::proc_listpids(
                    4, /* PROC_UID_ONLY, public sys/proc_info.h */
                    libc::geteuid(),
                    pids.as_mut_ptr().cast(),
                    capacity,
                )
            };
            if used > 0 && used < capacity && used % 4 == 0 {
                pids.truncate(used as usize / 4);
                pids.retain(|pid| *pid > 1);
                return Ok(pids);
            }
        }
        Err("子プロセス一覧を確認できません。停止確認を続けています。".into())
    }

    fn has_marker(pid: i32, marker: &[u8]) -> Result<bool, String> {
        let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
        let mut size = 0;
        let status = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                std::ptr::null_mut(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        if status != 0 || !(4..=2 * 1024 * 1024).contains(&size) {
            return if bsd(pid)?.is_none_or(|info| info.pbi_status == 5) {
                Ok(false)
            } else {
                Err("子プロセスの所属を確認できません。停止確認を続けています。".into())
            };
        }
        let mut bytes = vec![0u8; size];
        let status = unsafe {
            libc::sysctl(
                mib.as_mut_ptr(),
                3,
                bytes.as_mut_ptr().cast(),
                &mut size,
                std::ptr::null_mut(),
                0,
            )
        };
        let matches = if status == 0 && size <= bytes.len() {
            marker_in_environment(&bytes[..size], marker)
        } else {
            None
        };
        // Process environments may contain secrets. Never log or retain them.
        bytes.fill(0);
        match matches {
            Some(value) => Ok(value),
            None if bsd(pid)?.is_none_or(|info| info.pbi_status == 5) => Ok(false),
            None => Err("子プロセスの所属を確認できません。停止確認を続けています。".into()),
        }
    }

    fn marker_in_environment(bytes: &[u8], marker: &[u8]) -> Option<bool> {
        let argc = i32::from_ne_bytes(bytes.get(..4)?.try_into().ok()?);
        if !(0..=65536).contains(&argc) {
            return None;
        }
        let mut at = 4;
        at += bytes.get(at..)?.iter().position(|b| *b == 0)? + 1;
        while bytes.get(at) == Some(&0) {
            at += 1;
        }
        for _ in 0..argc {
            at += bytes.get(at..)?.iter().position(|b| *b == 0)? + 1;
        }
        Some(
            bytes
                .get(at..)?
                .split(|b| *b == 0)
                .any(|item| item == marker),
        )
    }

    pub(super) fn verify() -> Result<(), String> {
        identity(std::process::id() as i32)?.ok_or("プロセス監視を初期化できません")?;
        pids()?;
        Ok(())
    }

    fn observe(marker: &[u8], since: u64, known: &mut HashSet<Identity>) -> Result<(), String> {
        let own_pid = std::process::id();
        let mut infos = HashMap::new();
        for pid in pids()? {
            if let Some(info) = bsd(pid)? {
                if info.pbi_uid == unsafe { libc::geteuid() }
                    && info.pbi_pid != own_pid
                    && info.pbi_status != 5
                    && info.pbi_start_tvsec >= since
                {
                    infos.insert(pid, info);
                }
            }
        }
        // Repeated closure captures a marker-clearing child while its observed
        // parent is still alive; marker lookup also captures early orphans.
        loop {
            let previous = known.len();
            for (&pid, info) in &infos {
                let existing = known.iter().any(|identity| identity.pid() == pid);
                let parent = known
                    .iter()
                    .find(|identity| identity.pid() == info.pbi_ppid as i32)
                    .copied();
                let descended = if let Some(parent) = parent {
                    identity(parent.pid())? == Some(parent)
                } else {
                    false
                };
                if !existing && !descended && !has_marker(pid, marker)? {
                    continue;
                }
                let Some(before) = identity(pid)? else {
                    continue;
                };
                let Some(current) = bsd(pid)? else {
                    continue;
                };
                if current.pbi_uid != unsafe { libc::geteuid() }
                    || current.pbi_start_tvsec != info.pbi_start_tvsec
                    || current.pbi_start_tvusec != info.pbi_start_tvusec
                {
                    continue;
                }
                let parent = known
                    .iter()
                    .find(|identity| identity.pid() == current.pbi_ppid as i32)
                    .copied();
                let descended = if let Some(parent) = parent {
                    identity(parent.pid())? == Some(parent)
                } else {
                    false
                };
                let matching =
                    existing && known.contains(&before) || descended || has_marker(pid, marker)?;
                if matching && identity(pid)? == Some(before) {
                    known.insert(before);
                }
            }
            if known.len() == previous {
                break;
            }
        }
        let mut alive = HashSet::new();
        for &entry in known.iter() {
            if bsd(entry.pid())?.is_some_and(|info| info.pbi_status != 5)
                && identity(entry.pid())? == Some(entry)
            {
                alive.insert(entry);
            }
        }
        *known = alive;
        Ok(())
    }

    pub(super) fn supervise(
        marker: String,
        since: u64,
        control: Receiver<Control>,
        ack: tokio::sync::oneshot::Sender<()>,
        observer: Option<Observer>,
    ) {
        let marker = format!("{MARKER}={marker}").into_bytes();
        let mut known = HashSet::new();
        let mut stopping = None;
        let mut empty_since = None;
        let mut last_notice = None;
        loop {
            match control.recv_timeout(Duration::from_millis(if stopping.is_some() {
                25
            } else {
                100
            })) {
                Ok(Control::Attach(identity)) => {
                    known.insert(identity);
                }
                Ok(Control::Finish) => {
                    stopping.get_or_insert_with(Instant::now);
                }
                Err(RecvTimeoutError::Disconnected) => {
                    stopping.get_or_insert_with(Instant::now);
                    std::thread::sleep(Duration::from_millis(25));
                }
                Err(RecvTimeoutError::Timeout) => (),
            }
            let mut result = observe(&marker, since, &mut known);
            if stopping.is_some() {
                // Signal by immutable kernel incarnation, never a bare PID or
                // recycled process group. Stop first to limit ordinary forks.
                for &entry in &known {
                    if let Err(error) =
                        signal(entry, libc::SIGSTOP).and_then(|()| signal(entry, libc::SIGKILL))
                    {
                        result = Err(error);
                    }
                }
                if result.is_ok() && known.is_empty() {
                    if empty_since.get_or_insert_with(Instant::now).elapsed()
                        >= Duration::from_millis(200)
                    {
                        if let Some(observer) = &observer {
                            observer(CleanupProgress::Complete);
                        }
                        let _ = ack.send(());
                        return;
                    }
                } else {
                    empty_since = None;
                }
                let notice = result.err().or_else(|| stopping.filter(|start: &Instant| start.elapsed() > Duration::from_secs(2))
                    .map(|_| "子プロセスの終了を確認しています。確認が終わるまで次の作業は開始しません。".into()));
                if notice != last_notice {
                    if let (Some(observer), Some(message)) = (&observer, &notice) {
                        observer(CleanupProgress::Blocked(message.clone()));
                    }
                    last_notice = notice;
                }
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn marker_must_be_exact_environment_entry_not_an_argument() {
            let key = b"YORISHIRO_AUTONOMY_RUN_ID=fixture";
            let mut bytes = 2i32.to_ne_bytes().to_vec();
            bytes.extend_from_slice(
                b"/bin/tool\0\0tool\0YORISHIRO_AUTONOMY_RUN_ID=fixture\0OTHER=value\0",
            );
            assert_eq!(marker_in_environment(&bytes, key), Some(false));
            bytes.extend_from_slice(key);
            bytes.push(0);
            assert_eq!(marker_in_environment(&bytes, key), Some(true));
        }
        #[test]
        fn stale_audit_incarnation_cannot_signal_an_unrelated_process() {
            let mut child = std::process::Command::new("/bin/sleep")
                .arg("10")
                .spawn()
                .unwrap();
            let mut token = identity(child.id() as i32).unwrap().unwrap();
            token.0[7] = token.0[7].wrapping_add(1);
            let status =
                unsafe { proc_signal_with_audittoken(token.0.as_mut_ptr(), libc::SIGTERM) };
            let alive = child.try_wait().unwrap().is_none();
            child.kill().unwrap();
            child.wait().unwrap();
            assert_eq!(status, libc::ESRCH);
            assert!(alive);
        }
    }
}
