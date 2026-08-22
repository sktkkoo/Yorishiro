use super::protocol::{
    ControlMessage, ExternalClientsChangedPayload, Frame, ListedSession,
    EXTERNAL_CLIENTS_CHANGED_EVENT,
};
use crate::sessions::pty_session::{ExternalPtySink, ExternalResizeResult, PtySession};
use crate::sessions::{SessionKind, SessionRegistry};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
#[cfg(target_os = "macos")]
use std::sync::mpsc::{self, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{AppHandle, Emitter};

fn lock_or_recover<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct ClientCounter {
    count: AtomicUsize,
    emit_lock: Mutex<()>,
    changed: Arc<dyn Fn(usize) + Send + Sync>,
}

impl ClientCounter {
    fn new(changed: impl Fn(usize) + Send + Sync + 'static) -> Self {
        Self {
            count: AtomicUsize::new(0),
            emit_lock: Mutex::new(()),
            changed: Arc::new(changed),
        }
    }

    fn increment(&self) -> usize {
        let _emit_guard = lock_or_recover(&self.emit_lock);
        let count = self.count.fetch_add(1, Ordering::AcqRel) + 1;
        (self.changed)(count);
        count
    }

    fn decrement(&self) -> usize {
        let _emit_guard = lock_or_recover(&self.emit_lock);
        let mut current = self.count.load(Ordering::Acquire);
        loop {
            if current == 0 {
                return 0;
            }
            match self.count.compare_exchange_weak(
                current,
                current - 1,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => {
                    (self.changed)(current - 1);
                    return current - 1;
                }
                Err(actual) => current = actual,
            }
        }
    }

    fn emit_current(&self) -> usize {
        // Serialize the snapshot with attach/detach emissions. A frontend can
        // subscribe first and then request this sync without losing an edge.
        let _emit_guard = lock_or_recover(&self.emit_lock);
        let count = self.count.load(Ordering::Acquire);
        (self.changed)(count);
        count
    }

    #[cfg(test)]
    fn get(&self) -> usize {
        self.count.load(Ordering::Acquire)
    }
}

/// Managed Tauri state for the local attach server. On non-macOS targets this
/// is intentionally an unsupported/no-op boundary and never attempts UDS I/O.
pub(crate) struct AttachServer {
    #[cfg(target_os = "macos")]
    state: MacServerState,
}

impl AttachServer {
    pub(crate) fn start(app: AppHandle, registry: Arc<SessionRegistry>) -> Result<Self, String> {
        #[cfg(target_os = "macos")]
        {
            Self::start_macos(app, registry)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (app, registry);
            Ok(Self {})
        }
    }

    pub(crate) fn disabled() -> Self {
        Self {
            #[cfg(target_os = "macos")]
            state: MacServerState {
                shutdown: Arc::new(AtomicBool::new(true)),
                listener_thread: Mutex::new(None),
                counter: Arc::new(ClientCounter::new(|_| {})),
                yorishiro_home: None,
                socket_path: None,
            },
        }
    }

    pub(crate) fn stop(&self) {
        #[cfg(target_os = "macos")]
        self.stop_macos();
    }

    pub(crate) fn emit_current_client_count(&self) -> usize {
        #[cfg(target_os = "macos")]
        {
            self.state.counter.emit_current()
        }
        #[cfg(not(target_os = "macos"))]
        {
            0
        }
    }
}

impl Drop for AttachServer {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(target_os = "macos")]
struct MacServerState {
    shutdown: Arc<AtomicBool>,
    listener_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
    counter: Arc<ClientCounter>,
    yorishiro_home: Option<std::path::PathBuf>,
    socket_path: Option<std::path::PathBuf>,
}

#[cfg(target_os = "macos")]
impl AttachServer {
    fn start_macos(app: AppHandle, registry: Arc<SessionRegistry>) -> Result<Self, String> {
        let yorishiro_home = crate::yorishiro_home_path()?;
        let (listener, socket_path) = super::transport::bind_listener(&yorishiro_home)?;
        if let Err(error) = super::registry_file::register_instance(&yorishiro_home, &socket_path) {
            drop(listener);
            let _ = std::fs::remove_file(&socket_path);
            return Err(error);
        }

        let shutdown = Arc::new(AtomicBool::new(false));
        let counter_app = app.clone();
        let counter = Arc::new(ClientCounter::new(move |count| {
            let _ = counter_app.emit(
                EXTERNAL_CLIENTS_CHANGED_EVENT,
                ExternalClientsChangedPayload { count },
            );
        }));
        let state_counter = Arc::clone(&counter);
        let thread_shutdown = Arc::clone(&shutdown);
        let quit_app: Arc<dyn Fn() + Send + Sync> = Arc::new(move || app.exit(0));
        let thread = match std::thread::Builder::new()
            .name("yorishiro-attach-server".into())
            .spawn(move || {
                run_listener(listener, thread_shutdown, registry, counter, quit_app);
            }) {
            Ok(thread) => thread,
            Err(error) => {
                let _ = std::fs::remove_file(&socket_path);
                let _ = super::registry_file::unregister_instance(&yorishiro_home);
                return Err(format!("failed to start attach server thread: {error}"));
            }
        };

        Ok(Self {
            state: MacServerState {
                shutdown,
                listener_thread: Mutex::new(Some(thread)),
                counter: state_counter,
                yorishiro_home: Some(yorishiro_home),
                socket_path: Some(socket_path),
            },
        })
    }

    fn stop_macos(&self) {
        if !self.state.shutdown.swap(true, Ordering::AcqRel) {
            if let Some(thread) = lock_or_recover(&self.state.listener_thread).take() {
                let _ = thread.join();
            }
            if let Some(socket_path) = self.state.socket_path.as_ref() {
                match std::fs::remove_file(socket_path) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => eprintln!("[attach-server] socket cleanup failed: {error}"),
                }
            }
            if let Some(home) = self.state.yorishiro_home.as_ref() {
                if let Err(error) = super::registry_file::unregister_instance(home) {
                    eprintln!("[attach-server] registry cleanup failed: {error}");
                }
            }
        }
    }
}

#[cfg(target_os = "macos")]
struct SocketSink {
    sender: Mutex<Option<SyncSender<Vec<u8>>>>,
    close_stream: super::transport::Stream,
    closed: Arc<AtomicBool>,
    writer_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

#[cfg(target_os = "macos")]
const WRITER_QUEUE_CAPACITY: usize = 512;

#[cfg(target_os = "macos")]
const SOCKET_WRITE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

#[cfg(target_os = "macos")]
impl SocketSink {
    fn new(writer: super::transport::Stream) -> Result<Self, String> {
        Self::new_with_capacity(writer, WRITER_QUEUE_CAPACITY)
    }

    fn new_with_capacity(
        mut writer: super::transport::Stream,
        capacity: usize,
    ) -> Result<Self, String> {
        writer
            .set_write_timeout(Some(SOCKET_WRITE_TIMEOUT))
            .map_err(|error| format!("failed to configure attach writer: {error}"))?;
        let close_stream = writer
            .try_clone()
            .map_err(|error| format!("failed to clone attach writer: {error}"))?;
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(capacity);
        let closed = Arc::new(AtomicBool::new(false));
        let writer_closed = Arc::clone(&closed);
        let writer_thread = std::thread::Builder::new()
            .name("yorishiro-attach-writer".into())
            .spawn(move || {
                use std::io::Write;

                while let Ok(encoded) = receiver.recv() {
                    if let Err(error) = writer.write_all(&encoded) {
                        eprintln!("[attach-server] client write failed: {error}");
                        break;
                    }
                }
                writer_closed.store(true, Ordering::Release);
                let _ = writer.shutdown(std::net::Shutdown::Both);
            })
            .map_err(|error| format!("failed to start attach writer thread: {error}"))?;

        Ok(Self {
            sender: Mutex::new(Some(sender)),
            close_stream,
            closed,
            writer_thread: Mutex::new(Some(writer_thread)),
        })
    }

    fn enqueue(&self, frame: Frame) -> Result<(), String> {
        if self.closed.load(Ordering::Acquire) {
            return Err("attach socket writer is closed".to_string());
        }
        let encoded = super::protocol::encode_frame(&frame).map_err(|error| error.to_string())?;
        let result = {
            let sender = lock_or_recover(&self.sender);
            let Some(sender) = sender.as_ref() else {
                return Err("attach socket writer is closed".to_string());
            };
            sender.try_send(encoded)
        };
        match result {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.fail_connection();
                Err("attach socket writer queue overflowed".to_string())
            }
            Err(TrySendError::Disconnected(_)) => {
                self.fail_connection();
                Err("attach socket writer disconnected".to_string())
            }
        }
    }

    fn fail_connection(&self) {
        if !self.closed.swap(true, Ordering::AcqRel) {
            let _ = self.close_stream.shutdown(std::net::Shutdown::Both);
        }
    }

    fn shutdown_and_join(&self) {
        self.closed.store(true, Ordering::Release);
        lock_or_recover(&self.sender).take();
        let _ = self.close_stream.shutdown(std::net::Shutdown::Both);
        if let Some(thread) = lock_or_recover(&self.writer_thread).take() {
            let _ = thread.join();
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for SocketSink {
    fn drop(&mut self) {
        self.shutdown_and_join();
    }
}

#[cfg(target_os = "macos")]
impl ExternalPtySink for SocketSink {
    fn send_data(&self, data: &[u8]) -> Result<(), String> {
        self.enqueue(Frame::Data(data.to_vec()))
    }

    fn send_control(&self, control: &ControlMessage) -> Result<(), String> {
        self.enqueue(Frame::Control(control.clone()))
    }
}

#[cfg(target_os = "macos")]
fn run_listener(
    listener: super::transport::Listener,
    shutdown: Arc<AtomicBool>,
    registry: Arc<SessionRegistry>,
    counter: Arc<ClientCounter>,
    quit_app: Arc<dyn Fn() + Send + Sync>,
) {
    let mut clients = Vec::new();
    while !shutdown.load(Ordering::Acquire) {
        match listener.accept() {
            Ok((stream, _)) => {
                match super::transport::peer_is_current_user(&stream) {
                    Ok(true) => {}
                    Ok(false) => {
                        eprintln!("[attach-server] rejected client owned by another uid");
                        continue;
                    }
                    Err(error) => {
                        eprintln!("[attach-server] rejected unverifiable peer: {error}");
                        continue;
                    }
                }
                let client_shutdown = Arc::clone(&shutdown);
                let client_registry = Arc::clone(&registry);
                let client_counter = Arc::clone(&counter);
                let client_quit_app = Arc::clone(&quit_app);
                match std::thread::Builder::new()
                    .name("yorishiro-attach-client".into())
                    .spawn(move || {
                        handle_client(
                            stream,
                            client_shutdown,
                            client_registry,
                            client_counter,
                            client_quit_app,
                        );
                    }) {
                    Ok(thread) => clients.push(thread),
                    Err(error) => eprintln!("[attach-server] client thread failed: {error}"),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err(error) => {
                if !shutdown.load(Ordering::Acquire) {
                    eprintln!("[attach-server] accept failed: {error}");
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
        }
    }
    drop(listener);
    for client in clients {
        let _ = client.join();
    }
}

#[cfg(target_os = "macos")]
fn listed_sessions(registry: &SessionRegistry) -> Vec<ListedSession> {
    registry
        .list()
        .into_iter()
        .map(|descriptor| {
            let alive = registry
                .get_pty_session(&descriptor.id)
                .is_some_and(|session| session.is_alive());
            ListedSession {
                id: descriptor.id,
                cwd: descriptor.display_cwd.or(descriptor.cwd),
                alive,
                agent: descriptor.kind == SessionKind::Agent,
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn send_error(sink: &SocketSink, code: &str, message: impl Into<String>) {
    let _ = sink.send_control(&ControlMessage::Error {
        code: code.to_string(),
        message: message.into(),
    });
}

#[cfg(target_os = "macos")]
fn clear_attachment(
    attached: &mut Option<Arc<PtySession>>,
    client_id: &str,
    counter: &ClientCounter,
) {
    if let Some(session) = attached.take() {
        session.remove_external_sink(client_id);
        counter.decrement();
    }
}

#[cfg(target_os = "macos")]
fn handle_client(
    reader: super::transport::Stream,
    shutdown: Arc<AtomicBool>,
    registry: Arc<SessionRegistry>,
    counter: Arc<ClientCounter>,
    quit_app: Arc<dyn Fn() + Send + Sync>,
) {
    use std::io::ErrorKind;

    let _ = reader.set_read_timeout(Some(std::time::Duration::from_millis(100)));
    let writer = match reader.try_clone() {
        Ok(writer) => writer,
        Err(error) => {
            eprintln!("[attach-server] failed to clone client socket: {error}");
            return;
        }
    };
    let sink = match SocketSink::new(writer) {
        Ok(sink) => Arc::new(sink),
        Err(error) => {
            eprintln!("[attach-server] failed to start client writer: {error}");
            let _ = reader.shutdown(std::net::Shutdown::Both);
            return;
        }
    };
    if sink
        .send_control(&ControlMessage::Hello { replay: false })
        .is_err()
    {
        return;
    }

    let client_id = format!("client-{}", uuid::Uuid::new_v4());
    let mut attached: Option<Arc<PtySession>> = None;
    let mut frames = super::transport::FrameReader::new(reader);
    while !shutdown.load(Ordering::Acquire) {
        let frame = match frames.read_frame() {
            Ok(Some(frame)) => frame,
            Ok(None) => break,
            Err(super::transport::ReadFrameError::Io(error))
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) =>
            {
                continue
            }
            Err(super::transport::ReadFrameError::Io(error)) => {
                send_error(&sink, "transport-error", error.to_string());
                break;
            }
            Err(super::transport::ReadFrameError::Protocol(error)) => {
                send_error(&sink, "protocol-error", error);
                break;
            }
        };

        match frame {
            Frame::Data(data) => {
                let Some(session) = attached.as_ref() else {
                    send_error(
                        &sink,
                        "not-attached",
                        "attach to a session before sending data",
                    );
                    continue;
                };
                if let Err(error) = session.external_write(&client_id, &data) {
                    send_error(&sink, "pty-write-failed", error);
                }
            }
            Frame::Control(ControlMessage::Hello { replay }) => {
                if replay {
                    send_error(
                        &sink,
                        "replay-unsupported",
                        "external terminal attach never replays prior PTY output",
                    );
                }
            }
            Frame::Control(ControlMessage::List) => {
                let _ = sink.send_control(&ControlMessage::ListResult {
                    sessions: listed_sessions(&registry),
                });
            }
            Frame::Control(ControlMessage::Attach { session_id }) => {
                if attached.is_some() {
                    send_error(
                        &sink,
                        "already-attached",
                        "detach before attaching to another session",
                    );
                    continue;
                }
                let Some(session) = registry.get_pty_session(&session_id) else {
                    send_error(&sink, "no-such-session", "session not found");
                    continue;
                };
                let external_sink: Arc<dyn ExternalPtySink> = sink.clone();
                match session.register_external_sink(client_id.clone(), external_sink) {
                    Ok(size) => {
                        if sink
                            .send_control(&ControlMessage::Attached {
                                session_id,
                                cols: size.cols,
                                rows: size.rows,
                            })
                            .is_err()
                        {
                            session.remove_external_sink(&client_id);
                            break;
                        }
                        attached = Some(session);
                        counter.increment();
                        // Send Attached before provoking a redraw so the CLI
                        // cannot discard redraw bytes while awaiting the ack.
                        if let Some(session) = attached.as_ref() {
                            if let Err(error) = session.nudge_external_size() {
                                send_error(&sink, "redraw-nudge-failed", error);
                            }
                        }
                    }
                    Err(error) => send_error(&sink, "attach-failed", error),
                }
            }
            Frame::Control(ControlMessage::Resize { cols, rows }) => {
                let Some(session) = attached.as_ref() else {
                    send_error(&sink, "not-attached", "attach before resizing");
                    continue;
                };
                match session.external_resize(&client_id, cols, rows) {
                    Ok(ExternalResizeResult::Applied { .. }) => {}
                    Ok(ExternalResizeResult::NotAuthority { cols, rows }) => {
                        let _ = sink.send_control(&ControlMessage::SizeChanged { cols, rows });
                    }
                    Err(error) => send_error(&sink, "resize-failed", error),
                }
            }
            Frame::Control(ControlMessage::Detach) => {
                clear_attachment(&mut attached, &client_id, &counter);
            }
            Frame::Control(ControlMessage::Quit) => {
                clear_attachment(&mut attached, &client_id, &counter);
                quit_app();
                break;
            }
            Frame::Control(
                ControlMessage::ListResult { .. }
                | ControlMessage::Attached { .. }
                | ControlMessage::Exit { .. }
                | ControlMessage::SizeChanged { .. }
                | ControlMessage::ResizeAuthority { .. }
                | ControlMessage::Error { .. },
            ) => {
                send_error(
                    &sink,
                    "unexpected-control",
                    "client sent a server-only control frame",
                );
            }
        }
    }
    clear_attachment(&mut attached, &client_id, &counter);
    sink.shutdown_and_join();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn client_counter_never_underflows_and_emits_each_real_change() {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&changes);
        let counter = ClientCounter::new(move |count| {
            lock_or_recover(&observed).push(count);
        });
        assert_eq!(counter.decrement(), 0);
        assert_eq!(counter.increment(), 1);
        assert_eq!(counter.increment(), 2);
        assert_eq!(counter.decrement(), 1);
        assert_eq!(counter.decrement(), 0);
        assert_eq!(counter.decrement(), 0);
        assert_eq!(counter.get(), 0);
        assert_eq!(*lock_or_recover(&changes), vec![1, 2, 1, 0]);
    }

    #[test]
    fn client_counter_can_emit_a_current_snapshot_after_subscription() {
        let changes = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&changes);
        let counter = ClientCounter::new(move |count| {
            lock_or_recover(&observed).push(count);
        });
        counter.increment();

        assert_eq!(counter.emit_current(), 1);
        assert_eq!(*lock_or_recover(&changes), vec![1, 1]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn asynchronous_writer_preserves_control_then_data_order() {
        let (server_stream, client_stream) =
            super::super::transport::Stream::pair().expect("socket pair");
        let sink = SocketSink::new_with_capacity(server_stream, 4).expect("writer");
        sink.send_control(&ControlMessage::Attached {
            session_id: "shell-1".into(),
            cols: 80,
            rows: 24,
        })
        .expect("enqueue attached");
        sink.send_data(b"redraw").expect("enqueue redraw");

        let mut frames = super::super::transport::FrameReader::new(client_stream);
        assert_eq!(
            frames.read_frame().expect("attached"),
            Some(Frame::Control(ControlMessage::Attached {
                session_id: "shell-1".into(),
                cols: 80,
                rows: 24,
            }))
        );
        assert_eq!(
            frames.read_frame().expect("redraw"),
            Some(Frame::Data(b"redraw".to_vec()))
        );

        sink.shutdown_and_join();
        assert!(sink.closed.load(Ordering::Acquire));
        assert!(lock_or_recover(&sink.writer_thread).is_none());
        sink.shutdown_and_join(); // idempotent, and cannot leak a second join handle
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn queue_overflow_closes_the_connection_without_blocking() {
        let (server_stream, mut client_stream) =
            super::super::transport::Stream::pair().expect("socket pair");
        let (sender, receiver) = mpsc::sync_channel(1);
        let sink = SocketSink {
            sender: Mutex::new(Some(sender)),
            close_stream: server_stream,
            closed: Arc::new(AtomicBool::new(false)),
            writer_thread: Mutex::new(None),
        };

        sink.send_data(b"queued").expect("fill one-slot queue");
        let error = sink.send_data(b"overflow").expect_err("queue must reject");
        assert!(error.contains("overflowed"));
        assert!(sink.closed.load(Ordering::Acquire));

        use std::io::Read;
        let mut byte = [0_u8; 1];
        assert_eq!(client_stream.read(&mut byte).expect("closed peer"), 0);
        drop(receiver);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn writer_failure_closes_the_connection_and_thread_exits() {
        let (server_stream, peer) = super::super::transport::Stream::pair().expect("socket pair");
        let sink = SocketSink::new_with_capacity(server_stream, 4).expect("writer");
        peer.shutdown(std::net::Shutdown::Both).expect("close peer");
        drop(peer);
        for _ in 0..4 {
            let _ = sink.send_data(&vec![b'x'; 64 * 1024]);
            if sink.closed.load(Ordering::Acquire) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
        while !sink.closed.load(Ordering::Acquire) && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(sink.closed.load(Ordering::Acquire));
        assert!(sink.send_data(b"after failure").is_err());
        sink.shutdown_and_join();
        assert!(lock_or_recover(&sink.writer_thread).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn socket_client_receives_hello_and_can_list_registry_sessions() {
        use crate::sessions::{SessionDescriptor, SessionKind};

        let registry = Arc::new(SessionRegistry::new());
        registry.add(SessionDescriptor {
            id: "shell-1".into(),
            profile_id: "shell".into(),
            kind: SessionKind::Shell,
            label: "shell".into(),
            cwd: Some("/launch".into()),
            display_cwd: Some("/current".into()),
            started_at: 1,
        });
        let changes = Arc::new(Mutex::new(Vec::new()));
        let observed = Arc::clone(&changes);
        let counter = Arc::new(ClientCounter::new(move |count| {
            lock_or_recover(&observed).push(count);
        }));
        let shutdown = Arc::new(AtomicBool::new(false));
        let (server_stream, mut client_stream) =
            super::super::transport::Stream::pair().expect("socket pair");
        let server_shutdown = Arc::clone(&shutdown);
        let server_registry = Arc::clone(&registry);
        let server_counter = Arc::clone(&counter);
        let server_thread = std::thread::spawn(move || {
            handle_client(
                server_stream,
                server_shutdown,
                server_registry,
                server_counter,
                Arc::new(|| {}),
            );
        });

        let mut frames = super::super::transport::FrameReader::new(
            client_stream.try_clone().expect("clone client"),
        );
        assert_eq!(
            frames.read_frame().expect("server hello"),
            Some(Frame::Control(ControlMessage::Hello { replay: false }))
        );
        super::super::transport::write_frame(
            &mut client_stream,
            &Frame::Control(ControlMessage::List),
        )
        .expect("send list");
        assert_eq!(
            frames.read_frame().expect("list result"),
            Some(Frame::Control(ControlMessage::ListResult {
                sessions: vec![ListedSession {
                    id: "shell-1".into(),
                    cwd: Some("/current".into()),
                    alive: false,
                    agent: false,
                }],
            }))
        );

        shutdown.store(true, Ordering::Release);
        let _ = client_stream.shutdown(std::net::Shutdown::Both);
        server_thread.join().expect("server client thread");
        assert!(lock_or_recover(&changes).is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn quit_control_invokes_the_app_exit_callback() {
        let registry = Arc::new(SessionRegistry::new());
        let counter = Arc::new(ClientCounter::new(|_| {}));
        let shutdown = Arc::new(AtomicBool::new(false));
        let quit_called = Arc::new(AtomicBool::new(false));
        let observed_quit = Arc::clone(&quit_called);
        let (server_stream, mut client_stream) =
            super::super::transport::Stream::pair().expect("socket pair");
        let server_thread = std::thread::spawn(move || {
            handle_client(
                server_stream,
                shutdown,
                registry,
                counter,
                Arc::new(move || observed_quit.store(true, Ordering::Release)),
            );
        });

        let mut frames = super::super::transport::FrameReader::new(
            client_stream.try_clone().expect("clone client"),
        );
        assert_eq!(
            frames.read_frame().expect("server hello"),
            Some(Frame::Control(ControlMessage::Hello { replay: false }))
        );
        super::super::transport::write_frame(
            &mut client_stream,
            &Frame::Control(ControlMessage::Quit),
        )
        .expect("send quit");

        server_thread.join().expect("server client thread");
        assert!(quit_called.load(Ordering::Acquire));
    }
}
