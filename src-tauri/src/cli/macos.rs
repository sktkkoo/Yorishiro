use super::{
    encode, live_instances, not_running, print_sessions, read_registry, resolve_home,
    select_session, take_buffered_frame, Command, DetachFilter, InstanceRecord,
};
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::io::{self, Read, Write};
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd, RawFd};
use std::os::unix::fs::FileTypeExt;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command as ProcessCommand, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::thread;
use std::time::{Duration, Instant};
use yorishiro_lib::attach::protocol::{ControlMessage, Frame, ListedSession};

const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
const STARTUP_POLL_INTERVAL: Duration = Duration::from_millis(100);
const STDIN_FD: RawFd = libc::STDIN_FILENO;

pub(super) fn run(command: Command) -> Result<i32, String> {
    match command {
        Command::List => {
            let instances = discover_instances()?;
            let snapshots = query_instances(instances)?;
            let sessions = snapshots
                .iter()
                .flat_map(|snapshot| snapshot.sessions.iter().cloned())
                .collect::<Vec<_>>();
            print_sessions(&sessions);
            Ok(0)
        }
        Command::Attach(requested) => {
            let snapshots = query_instances(discover_instances()?)?;
            attach_to_session(snapshots, requested, false)
        }
        Command::Companion(requested) => {
            let (snapshots, launched) = discover_companion_snapshots()?;
            attach_to_session(snapshots, requested, launched)
        }
    }
}

fn attach_to_session(
    mut snapshots: Vec<InstanceSnapshot>,
    requested: Option<String>,
    quit_app_on_ctrl_c: bool,
) -> Result<i32, String> {
    let sessions = snapshots
        .iter()
        .flat_map(|snapshot| snapshot.sessions.iter().cloned())
        .collect::<Vec<_>>();
    let selected = match select_session(&sessions, requested.as_deref()) {
        Ok(selected) => selected,
        Err(error) => {
            if requested.is_none() && sessions.iter().filter(|session| session.alive).count() > 1 {
                print_sessions(&sessions);
            }
            return Err(error);
        }
    };
    let agent_session = sessions
        .iter()
        .find(|session| session.id == selected)
        .is_some_and(|session| session.agent);
    let snapshot_index = snapshots
        .iter()
        .position(|snapshot| {
            snapshot
                .sessions
                .iter()
                .any(|session| session.alive && session.id == selected)
        })
        .ok_or_else(|| format!("no live session named '{selected}'"))?;
    let mut snapshot = snapshots.swap_remove(snapshot_index);
    drop(snapshots);
    snapshot.client.attach(&selected)?;
    snapshot.client.interact(agent_session, quit_app_on_ctrl_c)
}

fn discover_companion_snapshots() -> Result<(Vec<InstanceSnapshot>, bool), String> {
    match discover_instances() {
        Ok(instances) => query_instances(instances).map(|snapshots| (snapshots, false)),
        Err(error) if error == not_running() => {
            launch_gui()?;
            wait_for_attachable_instance().map(|snapshots| (snapshots, true))
        }
        Err(error) => Err(error),
    }
}

fn launch_gui() -> Result<(), String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("could not locate the Yorishiro executable: {error}"))?;
    eprintln!("Starting Yorishiro...");
    ProcessCommand::new(&executable)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|error| format!("could not start {}: {error}", executable.display()))?;
    Ok(())
}

fn wait_for_attachable_instance() -> Result<Vec<InstanceSnapshot>, String> {
    let deadline = Instant::now() + STARTUP_TIMEOUT;
    let mut last_error = None;
    loop {
        match discover_instances().and_then(query_instances) {
            Ok(snapshots)
                if snapshots
                    .iter()
                    .any(|snapshot| snapshot.sessions.iter().any(|session| session.alive)) =>
            {
                return Ok(snapshots);
            }
            Ok(_) => {}
            Err(error) => last_error = Some(error),
        }

        if Instant::now() >= deadline {
            return Err(match last_error {
                Some(error) => format!(
                    "Yorishiro started, but no live terminal session became available within {} seconds ({error})",
                    STARTUP_TIMEOUT.as_secs()
                ),
                None => format!(
                    "Yorishiro started, but no live terminal session became available within {} seconds",
                    STARTUP_TIMEOUT.as_secs()
                ),
            });
        }
        thread::sleep(STARTUP_POLL_INTERVAL);
    }
}

fn discover_instances() -> Result<Vec<InstanceRecord>, String> {
    let home = resolve_home()?;
    let live = live_instances(read_registry(&home)?, pid_is_alive, socket_is_present);
    if live.is_empty() {
        Err(not_running())
    } else {
        Ok(live)
    }
}

fn pid_is_alive(pid: u32) -> bool {
    if pid == 0 || pid > libc::pid_t::MAX as u32 {
        return false;
    }
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

fn socket_is_present(path: &Path) -> bool {
    path.is_absolute()
        && fs::symlink_metadata(path)
            .map(|metadata| metadata.file_type().is_socket())
            .unwrap_or(false)
}

struct InstanceSnapshot {
    client: Client,
    sessions: Vec<ListedSession>,
}

fn query_instances(instances: Vec<InstanceRecord>) -> Result<Vec<InstanceSnapshot>, String> {
    let mut snapshots = Vec::new();
    let mut paths = HashSet::<PathBuf>::new();
    let mut last_error = None;

    for instance in instances {
        if !paths.insert(instance.socket_path.clone()) {
            continue;
        }
        match Client::connect(&instance.socket_path).and_then(|mut client| {
            let sessions = client.list()?;
            Ok(InstanceSnapshot { client, sessions })
        }) {
            Ok(snapshot) => snapshots.push(snapshot),
            Err(error) => last_error = Some(error),
        }
    }

    if snapshots.is_empty() {
        if let Some(error) = last_error {
            Err(format!("{} ({error})", not_running()))
        } else {
            Err(not_running())
        }
    } else {
        Ok(snapshots)
    }
}

struct Client {
    socket: UnixStream,
    buffered: Vec<u8>,
    pending_frames: VecDeque<Frame>,
}

impl Client {
    fn connect(path: &Path) -> Result<Self, String> {
        let socket = UnixStream::connect(path)
            .map_err(|error| format!("could not connect to {}: {error}", path.display()))?;
        socket
            .set_read_timeout(Some(HANDSHAKE_TIMEOUT))
            .map_err(|error| format!("could not configure attach connection: {error}"))?;
        Ok(Self {
            socket,
            buffered: Vec::new(),
            pending_frames: VecDeque::new(),
        })
    }

    fn send(&mut self, frame: Frame) -> Result<(), String> {
        let encoded = encode(frame)?;
        self.socket
            .write_all(&encoded)
            .map_err(|error| format!("could not write attach connection: {error}"))
    }

    fn next_blocking(&mut self) -> Result<Option<Frame>, String> {
        loop {
            if let Some(frame) = take_buffered_frame(&mut self.buffered)? {
                return Ok(Some(frame));
            }
            let mut chunk = [0_u8; 8192];
            match self.socket.read(&mut chunk) {
                Ok(0) if self.buffered.is_empty() => return Ok(None),
                Ok(0) => return Err("connection closed in the middle of a frame".into()),
                Ok(read) => self.buffered.extend_from_slice(&chunk[..read]),
                Err(error) => return Err(format!("could not read attach connection: {error}")),
            }
        }
    }

    fn list(&mut self) -> Result<Vec<ListedSession>, String> {
        self.send(Frame::Control(ControlMessage::Hello { replay: false }))?;
        self.send(Frame::Control(ControlMessage::List))?;
        loop {
            match self.next_blocking()? {
                Some(Frame::Control(ControlMessage::ListResult { sessions })) => {
                    return Ok(sessions)
                }
                Some(Frame::Control(ControlMessage::Error { code, message })) => {
                    return Err(format!("server error {code}: {message}"));
                }
                Some(_) => {}
                None => return Err("Yorishiro closed the connection while listing sessions".into()),
            }
        }
    }

    fn attach(&mut self, session_id: &str) -> Result<(), String> {
        self.send(Frame::Control(ControlMessage::Attach {
            session_id: session_id.into(),
        }))?;
        loop {
            match self.next_blocking()? {
                Some(Frame::Control(ControlMessage::Attached { .. })) => {
                    self.socket.set_read_timeout(None).map_err(|error| {
                        format!("could not configure attach connection: {error}")
                    })?;
                    return Ok(());
                }
                Some(Frame::Control(ControlMessage::Error { code, message })) => {
                    return Err(format!("server error {code}: {message}"));
                }
                Some(frame) => self.pending_frames.push_back(frame),
                None => return Err("Yorishiro closed the connection before attaching".into()),
            }
        }
    }

    fn interact(&mut self, agent_session: bool, quit_app_on_ctrl_c: bool) -> Result<i32, String> {
        let signals = SignalGuard::install()?;
        let _terminal = RawTerminalGuard::new(STDIN_FD)?;
        self.send_current_size()?;

        let socket_fd = self.socket.as_raw_fd();
        let mut detach_filter = DetachFilter::new(agent_session);
        let mut stdout = io::stdout().lock();

        loop {
            if let Some(code) = self.drain_incoming(&mut stdout)? {
                return Ok(code);
            }
            let mut descriptors = [
                libc::pollfd {
                    fd: socket_fd,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: STDIN_FD,
                    events: libc::POLLIN,
                    revents: 0,
                },
                libc::pollfd {
                    fd: signals.read_fd,
                    events: libc::POLLIN,
                    revents: 0,
                },
            ];
            let result = unsafe {
                libc::poll(
                    descriptors.as_mut_ptr(),
                    descriptors.len() as libc::nfds_t,
                    -1,
                )
            };
            if result < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("could not wait for terminal input: {error}"));
            }

            if descriptors[2].revents & libc::POLLIN != 0 {
                for signal in signals.read_pending()? {
                    match signal {
                        libc::SIGWINCH => self.send_current_size()?,
                        libc::SIGHUP | libc::SIGINT | libc::SIGQUIT | libc::SIGTERM => {
                            self.send_detach_best_effort();
                            return Ok(128 + signal);
                        }
                        _ => {}
                    }
                }
            }

            if descriptors[0].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                let eof = self.read_ready()?;
                if let Some(code) = self.drain_incoming(&mut stdout)? {
                    return Ok(code);
                }
                if eof {
                    if self.buffered.is_empty() {
                        return Err("Yorishiro disconnected".into());
                    }
                    return Err("connection closed in the middle of a frame".into());
                }
            }

            if descriptors[1].revents & (libc::POLLIN | libc::POLLHUP | libc::POLLERR) != 0 {
                let mut input = [0_u8; 8192];
                let read = unsafe {
                    libc::read(
                        STDIN_FD,
                        input.as_mut_ptr().cast::<libc::c_void>(),
                        input.len(),
                    )
                };
                if read < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() != io::ErrorKind::Interrupted {
                        return Err(format!("could not read terminal input: {error}"));
                    }
                } else if read == 0 {
                    let trailing = detach_filter.finish();
                    if !trailing.is_empty() {
                        self.send(Frame::Data(trailing))?;
                    }
                    self.send_detach_best_effort();
                    return Ok(0);
                } else {
                    let filtered = detach_filter.filter(&input[..read as usize]);
                    if !filtered.data.is_empty() {
                        self.send(Frame::Data(filtered.data))?;
                    }
                    if filtered.detach {
                        let control = if filtered.quit_requested && quit_app_on_ctrl_c {
                            ControlMessage::Quit
                        } else {
                            ControlMessage::Detach
                        };
                        self.send(Frame::Control(control))?;
                        return Ok(0);
                    }
                }
            }
        }
    }

    fn read_ready(&mut self) -> Result<bool, String> {
        let mut chunk = [0_u8; 8192];
        match self.socket.read(&mut chunk) {
            Ok(0) => Ok(true),
            Ok(read) => {
                self.buffered.extend_from_slice(&chunk[..read]);
                Ok(false)
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => Ok(false),
            Err(error) => Err(format!("could not read attach connection: {error}")),
        }
    }

    fn drain_incoming(&mut self, output: &mut impl Write) -> Result<Option<i32>, String> {
        loop {
            let frame = match self.pending_frames.pop_front() {
                Some(frame) => frame,
                None => match take_buffered_frame(&mut self.buffered)? {
                    Some(frame) => frame,
                    None => return Ok(None),
                },
            };
            match frame {
                Frame::Data(data) => {
                    output
                        .write_all(&data)
                        .and_then(|_| output.flush())
                        .map_err(|error| format!("could not write terminal output: {error}"))?;
                }
                Frame::Control(ControlMessage::Exit { code }) => {
                    return Ok(Some(code.unwrap_or(0)))
                }
                Frame::Control(ControlMessage::Detach) => return Ok(Some(0)),
                Frame::Control(ControlMessage::Error { code, message }) => {
                    return Err(format!("server error {code}: {message}"));
                }
                Frame::Control(ControlMessage::ResizeAuthority { .. }) => {
                    // The server broadcasts authority changes. Only the new
                    // authority's resize is accepted, so every client can
                    // safely offer its current terminal size here.
                    self.send_current_size()?;
                }
                Frame::Control(_) => {}
            }
        }
    }

    fn send_current_size(&mut self) -> Result<(), String> {
        let (cols, rows) = tty_size(STDIN_FD)?;
        self.send(Frame::Control(ControlMessage::Resize { cols, rows }))
    }

    fn send_detach_best_effort(&mut self) {
        let _ = self.send(Frame::Control(ControlMessage::Detach));
    }
}

fn tty_size(fd: RawFd) -> Result<(u16, u16), String> {
    let mut size = MaybeUninit::<libc::winsize>::zeroed();
    let result = unsafe { libc::ioctl(fd, libc::TIOCGWINSZ, size.as_mut_ptr()) };
    if result < 0 {
        return Err(format!(
            "could not read terminal size: {}",
            io::Error::last_os_error()
        ));
    }
    let size = unsafe { size.assume_init() };
    Ok((size.ws_col.max(1), size.ws_row.max(1)))
}

struct RawTerminalGuard {
    fd: RawFd,
    saved: libc::termios,
}

impl RawTerminalGuard {
    fn new(fd: RawFd) -> Result<Self, String> {
        let mut saved = MaybeUninit::<libc::termios>::uninit();
        if unsafe { libc::tcgetattr(fd, saved.as_mut_ptr()) } < 0 {
            return Err(format!(
                "stdin is not an interactive terminal: {}",
                io::Error::last_os_error()
            ));
        }
        let saved = unsafe { saved.assume_init() };
        let mut raw = saved;
        unsafe { libc::cfmakeraw(&mut raw) };
        if unsafe { libc::tcsetattr(fd, libc::TCSADRAIN, &raw) } < 0 {
            return Err(format!(
                "could not enter raw terminal mode: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(Self { fd, saved })
    }
}

impl Drop for RawTerminalGuard {
    fn drop(&mut self) {
        if unsafe { libc::tcsetattr(self.fd, libc::TCSADRAIN, &self.saved) } < 0 {
            // A drain can fail if the peer vanished. TCSANOW still restores
            // local echo/canonical mode and is the safest last-resort cleanup.
            unsafe {
                libc::tcsetattr(self.fd, libc::TCSANOW, &self.saved);
            }
        }
    }
}

static SIGNAL_PIPE_WRITE_FD: AtomicI32 = AtomicI32::new(-1);

extern "C" fn signal_handler(signal: libc::c_int) {
    let fd = SIGNAL_PIPE_WRITE_FD.load(Ordering::Relaxed);
    if fd >= 0 {
        let bytes = signal.to_ne_bytes();
        unsafe {
            libc::write(fd, bytes.as_ptr().cast::<libc::c_void>(), bytes.len());
        }
    }
}

struct SignalGuard {
    read_fd: RawFd,
    write_fd: RawFd,
    previous: Vec<(libc::c_int, libc::sigaction)>,
}

impl SignalGuard {
    fn install() -> Result<Self, String> {
        let mut pipe_fds = [-1; 2];
        if unsafe { libc::pipe(pipe_fds.as_mut_ptr()) } < 0 {
            return Err(format!(
                "could not create signal pipe: {}",
                io::Error::last_os_error()
            ));
        }
        let mut guard = Self {
            read_fd: pipe_fds[0],
            write_fd: pipe_fds[1],
            previous: Vec::new(),
        };
        for fd in pipe_fds {
            let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
            if flags < 0
                || unsafe { libc::fcntl(fd, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
                || unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) } < 0
            {
                return Err(format!(
                    "could not configure signal pipe: {}",
                    io::Error::last_os_error()
                ));
            }
        }

        SIGNAL_PIPE_WRITE_FD.store(pipe_fds[1], Ordering::SeqCst);
        for signal in [
            libc::SIGHUP,
            libc::SIGINT,
            libc::SIGQUIT,
            libc::SIGTERM,
            libc::SIGWINCH,
        ] {
            guard.install_one(signal)?;
        }
        Ok(guard)
    }

    fn install_one(&mut self, signal: libc::c_int) -> Result<(), String> {
        let mut action = unsafe { MaybeUninit::<libc::sigaction>::zeroed().assume_init() };
        action.sa_sigaction = signal_handler as usize;
        action.sa_flags = 0;
        unsafe { libc::sigemptyset(&mut action.sa_mask) };
        let mut previous = MaybeUninit::<libc::sigaction>::uninit();
        if unsafe { libc::sigaction(signal, &action, previous.as_mut_ptr()) } < 0 {
            return Err(format!(
                "could not install terminal signal handler: {}",
                io::Error::last_os_error()
            ));
        }
        self.previous
            .push((signal, unsafe { previous.assume_init() }));
        Ok(())
    }

    fn read_pending(&self) -> Result<Vec<libc::c_int>, String> {
        let mut buffer = [0_u8; 64];
        let mut signals = Vec::new();
        loop {
            let read = unsafe {
                libc::read(
                    self.read_fd,
                    buffer.as_mut_ptr().cast::<libc::c_void>(),
                    buffer.len(),
                )
            };
            if read < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::WouldBlock {
                    break;
                }
                if error.kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(format!("could not read terminal signal: {error}"));
            }
            if read == 0 {
                break;
            }
            for bytes in buffer[..read as usize].chunks_exact(std::mem::size_of::<libc::c_int>()) {
                signals.push(libc::c_int::from_ne_bytes(
                    bytes.try_into().expect("signal width"),
                ));
            }
        }
        Ok(signals)
    }
}

impl Drop for SignalGuard {
    fn drop(&mut self) {
        SIGNAL_PIPE_WRITE_FD.store(-1, Ordering::SeqCst);
        for (signal, previous) in self.previous.iter().rev() {
            unsafe {
                libc::sigaction(*signal, previous, std::ptr::null_mut());
            }
        }
        unsafe {
            libc::close(self.read_fd);
            libc::close(self.write_fd);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raw_terminal_guard_restores_a_private_pseudoterminal() {
        let mut master = -1;
        let mut slave = -1;
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                )
            },
            0
        );

        let before = termios(slave);
        {
            let _guard = RawTerminalGuard::new(slave).expect("enter raw mode");
            let raw = termios(slave);
            assert_eq!(raw.c_lflag & libc::ICANON, 0);
            assert_eq!(raw.c_lflag & libc::ECHO, 0);
        }
        let restored = termios(slave);
        assert_eq!(restored.c_iflag, before.c_iflag);
        assert_eq!(restored.c_oflag, before.c_oflag);
        assert_eq!(restored.c_cflag, before.c_cflag);
        // macOS may set the transient PENDIN bit when canonical mode is
        // re-enabled; all persisted local-mode bits must match the snapshot.
        assert_eq!(
            restored.c_lflag & !libc::PENDIN,
            before.c_lflag & !libc::PENDIN
        );

        unsafe {
            libc::close(master);
            libc::close(slave);
        }
    }

    fn termios(fd: RawFd) -> libc::termios {
        let mut value = MaybeUninit::<libc::termios>::uninit();
        assert_eq!(unsafe { libc::tcgetattr(fd, value.as_mut_ptr()) }, 0);
        unsafe { value.assume_init() }
    }
}
