use serde::Deserialize;
use std::ffi::OsString;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use yorishiro_lib::attach::protocol::{
    decode_frame, encode_frame, Frame, ListedSession, FRAME_HEADER_LENGTH, MAX_PAYLOAD_LENGTH,
};

#[cfg(target_os = "macos")]
mod macos;

#[derive(Debug, PartialEq, Eq)]
enum Command {
    List,
    Attach(Option<String>),
    Companion(Option<String>),
}

#[derive(Debug, PartialEq, Eq)]
enum ParsedDispatch {
    Gui,
    Cli(Result<Command, String>),
}

pub enum Dispatch {
    Gui,
    Cli(Result<i32, String>),
}

/// Only the exact CLI command names opt out of the GUI startup path.
/// LaunchServices and Tauri are allowed to pass arbitrary arguments through.
pub fn dispatch(args: impl IntoIterator<Item = OsString>) -> Dispatch {
    match parse_dispatch(args) {
        ParsedDispatch::Gui => Dispatch::Gui,
        ParsedDispatch::Cli(Err(error)) => Dispatch::Cli(Err(error)),
        ParsedDispatch::Cli(Ok(command)) => Dispatch::Cli(run(command)),
    }
}

fn parse_dispatch(args: impl IntoIterator<Item = OsString>) -> ParsedDispatch {
    let mut args = args.into_iter();
    let Some(first) = args.next() else {
        return ParsedDispatch::Gui;
    };

    if first == "list" {
        if args.next().is_some() {
            return ParsedDispatch::Cli(Err("usage: yorishiro list".into()));
        }
        return ParsedDispatch::Cli(Ok(Command::List));
    }

    if first == "attach" {
        let session = match args.next() {
            Some(value) => match value.into_string() {
                Ok(value) => Some(value),
                Err(_) => {
                    return ParsedDispatch::Cli(Err(
                        "session id is not valid UTF-8\nusage: yorishiro attach [session]".into(),
                    ));
                }
            },
            None => None,
        };
        if args.next().is_some() {
            return ParsedDispatch::Cli(Err("usage: yorishiro attach [session]".into()));
        }
        return ParsedDispatch::Cli(Ok(Command::Attach(session)));
    }

    if first == "companion" {
        let session = match args.next() {
            Some(value) => match value.into_string() {
                Ok(value) => Some(value),
                Err(_) => {
                    return ParsedDispatch::Cli(Err(
                        "session id is not valid UTF-8\nusage: yorishiro companion [session]"
                            .into(),
                    ));
                }
            },
            None => None,
        };
        if args.next().is_some() {
            return ParsedDispatch::Cli(Err("usage: yorishiro companion [session]".into()));
        }
        return ParsedDispatch::Cli(Ok(Command::Companion(session)));
    }

    ParsedDispatch::Gui
}

#[cfg(target_os = "macos")]
fn run(command: Command) -> Result<i32, String> {
    macos::run(command)
}

#[cfg(not(target_os = "macos"))]
fn run(_command: Command) -> Result<i32, String> {
    Err("external terminal attach is currently supported only on macOS".into())
}

#[derive(Debug, Deserialize)]
struct InstanceRegistry {
    version: u32,
    instances: Vec<InstanceRecord>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct InstanceRecord {
    pid: u32,
    socket_path: PathBuf,
}

fn read_registry(home: &Path) -> Result<Vec<InstanceRecord>, String> {
    let path = home.join("run/instances.json");
    let contents = fs::read_to_string(&path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            not_running()
        } else {
            format!("could not read {}: {error}", path.display())
        }
    })?;
    let registry: InstanceRegistry = serde_json::from_str(&contents)
        .map_err(|error| format!("could not parse {}: {error}", path.display()))?;
    if registry.version != 1 {
        return Err(format!(
            "unsupported Yorishiro instance registry version {}",
            registry.version
        ));
    }
    Ok(registry.instances)
}

fn live_instances(
    instances: Vec<InstanceRecord>,
    mut pid_alive: impl FnMut(u32) -> bool,
    mut socket_present: impl FnMut(&Path) -> bool,
) -> Vec<InstanceRecord> {
    instances
        .into_iter()
        .filter(|instance| pid_alive(instance.pid) && socket_present(&instance.socket_path))
        .collect()
}

fn resolve_home() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".yorishiro"))
        .ok_or_else(|| "home directory not found".into())
}

fn not_running() -> String {
    "Yorishiro is not running".into()
}

fn print_sessions(sessions: &[ListedSession]) {
    if sessions.is_empty() {
        println!("No terminal sessions.");
        return;
    }

    println!("SESSION\tSTATUS\tCWD");
    for session in sessions {
        let status = if session.alive { "live" } else { "stopped" };
        println!(
            "{}\t{}\t{}",
            session.id,
            status,
            session.cwd.as_deref().unwrap_or("-")
        );
    }
}

fn select_session(sessions: &[ListedSession], requested: Option<&str>) -> Result<String, String> {
    let live: Vec<&ListedSession> = sessions.iter().filter(|session| session.alive).collect();
    if let Some(requested) = requested {
        return live
            .into_iter()
            .find(|session| session.id == requested)
            .map(|session| session.id.clone())
            .ok_or_else(|| format!("no live session named '{requested}'"));
    }

    match live.as_slice() {
        [session] => Ok(session.id.clone()),
        [] => Err("no live terminal sessions".into()),
        _ => Err("multiple live sessions; specify one with `yorishiro attach <session>`".into()),
    }
}

#[cfg(test)]
struct FrameStream<R> {
    reader: R,
    buffered: Vec<u8>,
}

#[cfg(test)]
impl<R: std::io::Read> FrameStream<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buffered: Vec::new(),
        }
    }

    fn next(&mut self) -> Result<Option<Frame>, String> {
        loop {
            if let Some(frame) = take_buffered_frame(&mut self.buffered)? {
                return Ok(Some(frame));
            }

            let mut chunk = [0_u8; 8192];
            match self.reader.read(&mut chunk) {
                Ok(0) if self.buffered.is_empty() => return Ok(None),
                Ok(0) => return Err("connection closed in the middle of a frame".into()),
                Ok(read) => self.buffered.extend_from_slice(&chunk[..read]),
                Err(error) => return Err(format!("could not read attach connection: {error}")),
            }
        }
    }
}

fn take_buffered_frame(buffered: &mut Vec<u8>) -> Result<Option<Frame>, String> {
    if buffered.len() < FRAME_HEADER_LENGTH {
        return Ok(None);
    }
    let payload_length =
        u32::from_be_bytes([buffered[1], buffered[2], buffered[3], buffered[4]]) as usize;
    if payload_length > MAX_PAYLOAD_LENGTH {
        return Err(format!(
            "attach frame payload is too large: {payload_length} bytes"
        ));
    }
    let frame_length = FRAME_HEADER_LENGTH + payload_length;
    if buffered.len() < frame_length {
        return Ok(None);
    }
    let (frame, consumed) =
        decode_frame(buffered).map_err(|error| format!("invalid frame from Yorishiro: {error}"))?;
    buffered.drain(..consumed);
    Ok(Some(frame))
}

struct DetachFilter {
    pending_prefix: bool,
    agent_session: bool,
}

struct FilteredInput {
    data: Vec<u8>,
    detach: bool,
    quit_requested: bool,
}

impl DetachFilter {
    fn new(agent_session: bool) -> Self {
        Self {
            pending_prefix: false,
            agent_session,
        }
    }

    fn filter(&mut self, input: &[u8]) -> FilteredInput {
        let mut data = Vec::with_capacity(input.len());
        for &byte in input {
            if self.pending_prefix {
                match byte {
                    b'q' => {
                        self.pending_prefix = false;
                        return FilteredInput {
                            data,
                            detach: true,
                            quit_requested: false,
                        };
                    }
                    b'c' => {
                        self.pending_prefix = false;
                        data.push(0x03);
                        continue;
                    }
                    _ => {}
                }
                data.push(yorishiro_lib::attach::protocol::DETACH_SEQUENCE[0]);
                self.pending_prefix = false;
            }

            if byte == 0x03 && self.agent_session {
                return FilteredInput {
                    data,
                    detach: true,
                    quit_requested: true,
                };
            } else if byte == 0x11 {
                return FilteredInput {
                    data,
                    detach: true,
                    quit_requested: false,
                };
            } else if byte == yorishiro_lib::attach::protocol::DETACH_SEQUENCE[0] {
                self.pending_prefix = true;
            } else {
                data.push(byte);
            }
        }
        FilteredInput {
            data,
            detach: false,
            quit_requested: false,
        }
    }

    fn finish(&mut self) -> Vec<u8> {
        if self.pending_prefix {
            self.pending_prefix = false;
            vec![yorishiro_lib::attach::protocol::DETACH_SEQUENCE[0]]
        } else {
            Vec::new()
        }
    }
}

fn encode(frame: Frame) -> Result<Vec<u8>, String> {
    encode_frame(&frame).map_err(|error| format!("could not encode attach frame: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Cursor, Read};
    use yorishiro_lib::attach::protocol::ControlMessage;

    fn args(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    fn session(id: &str, alive: bool) -> ListedSession {
        ListedSession {
            id: id.into(),
            cwd: None,
            alive,
            agent: false,
        }
    }

    #[test]
    fn dispatches_only_exact_known_first_arguments() {
        assert_eq!(parse_dispatch(args(&[])), ParsedDispatch::Gui);
        assert_eq!(parse_dispatch(args(&["--flag"])), ParsedDispatch::Gui);
        assert_eq!(parse_dispatch(args(&["LIST"])), ParsedDispatch::Gui);
        assert_eq!(
            parse_dispatch(args(&["list-sessions"])),
            ParsedDispatch::Gui
        );
        assert_eq!(
            parse_dispatch(args(&["list"])),
            ParsedDispatch::Cli(Ok(Command::List))
        );
        assert_eq!(
            parse_dispatch(args(&["attach"])),
            ParsedDispatch::Cli(Ok(Command::Attach(None)))
        );
        assert_eq!(
            parse_dispatch(args(&["attach", "main"])),
            ParsedDispatch::Cli(Ok(Command::Attach(Some("main".into()))))
        );
        assert_eq!(
            parse_dispatch(args(&["companion"])),
            ParsedDispatch::Cli(Ok(Command::Companion(None)))
        );
        assert_eq!(
            parse_dispatch(args(&["companion", "main"])),
            ParsedDispatch::Cli(Ok(Command::Companion(Some("main".into()))))
        );
        assert!(matches!(
            parse_dispatch(args(&["attach", "one", "two"])),
            ParsedDispatch::Cli(Err(_))
        ));
    }

    #[test]
    fn frame_stream_handles_fragmented_and_coalesced_frames() {
        let first = encode(Frame::Data(vec![0, 1, 2])).unwrap();
        let second = encode(Frame::Control(ControlMessage::Exit { code: Some(3) })).unwrap();
        let bytes = [first, second].concat();
        let reader = FragmentedReader {
            inner: Cursor::new(bytes),
            maximum: 2,
        };
        let mut stream = FrameStream::new(reader);
        assert_eq!(stream.next().unwrap(), Some(Frame::Data(vec![0, 1, 2])));
        assert_eq!(
            stream.next().unwrap(),
            Some(Frame::Control(ControlMessage::Exit { code: Some(3) }))
        );
        assert_eq!(stream.next().unwrap(), None);
    }

    #[test]
    fn frame_stream_rejects_eof_during_a_frame() {
        let mut bytes = encode(Frame::Data(vec![1, 2, 3])).unwrap();
        bytes.pop();
        let mut stream = FrameStream::new(Cursor::new(bytes));
        assert!(stream.next().unwrap_err().contains("middle of a frame"));
    }

    #[test]
    fn detach_filter_recognizes_split_sequence_without_forwarding_it() {
        let mut filter = DetachFilter::new(false);
        let first = filter.filter(b"hello\x1c");
        assert_eq!(first.data, b"hello");
        assert!(!first.detach);
        let second = filter.filter(b"qignored");
        assert!(second.data.is_empty());
        assert!(second.detach);
    }

    #[test]
    fn detach_filter_forwards_false_prefix_and_flushes_trailing_prefix() {
        let mut filter = DetachFilter::new(false);
        let filtered = filter.filter(b"a\x1cxb");
        assert_eq!(filtered.data, b"a\x1cxb");
        assert!(!filtered.detach);
        filter.filter(b"\x1c");
        assert_eq!(filter.finish(), b"\x1c");
    }

    #[test]
    fn detach_filter_uses_ctrl_c_to_close_agent_attach() {
        let mut filter = DetachFilter::new(true);
        let filtered = filter.filter(b"\x03");

        assert!(filtered.data.is_empty());
        assert!(filtered.detach);
        assert!(filtered.quit_requested);
    }

    #[test]
    fn detach_filter_forwards_ctrl_c_to_shell_sessions() {
        let mut filter = DetachFilter::new(false);
        let filtered = filter.filter(b"\x03");

        assert_eq!(filtered.data, b"\x03");
        assert!(!filtered.detach);
        assert!(!filtered.quit_requested);
    }

    #[test]
    fn detach_filter_forwards_escape_to_agent_sessions() {
        let mut filter = DetachFilter::new(true);
        let filtered = filter.filter(b"\x1b");

        assert_eq!(filtered.data, b"\x1b");
        assert!(!filtered.detach);
        assert!(!filtered.quit_requested);
    }

    #[test]
    fn detach_filter_forwards_explicit_ctrl_c_escape() {
        let mut filter = DetachFilter::new(true);
        let first = filter.filter(b"\x1c");
        assert!(first.data.is_empty());
        assert!(!first.detach);

        let second = filter.filter(b"c");
        assert_eq!(second.data, b"\x03");
        assert!(!second.detach);
    }

    #[test]
    fn session_selection_requires_one_live_session_when_omitted() {
        assert_eq!(
            select_session(&[session("only", true)], None).unwrap(),
            "only"
        );
        assert!(select_session(&[], None).unwrap_err().contains("no live"));
        assert!(
            select_session(&[session("a", true), session("b", true)], None)
                .unwrap_err()
                .contains("multiple")
        );
        assert_eq!(
            select_session(
                &[session("dead", false), session("live", true)],
                Some("live")
            )
            .unwrap(),
            "live"
        );
        assert!(select_session(&[session("dead", false)], Some("dead")).is_err());
    }

    #[test]
    fn registry_parser_tolerates_unknown_fields() {
        let directory = tempfile::tempdir().unwrap();
        let home = directory.path();
        fs::create_dir(home.join("run")).unwrap();
        fs::write(
            home.join("run/instances.json"),
            r#"{"version":1,"future":true,"instances":[{"pid":42,"socketPath":"/tmp/attach.sock","extra":"ok"}]}"#,
        )
        .unwrap();
        assert_eq!(
            read_registry(home).unwrap(),
            vec![InstanceRecord {
                pid: 42,
                socket_path: PathBuf::from("/tmp/attach.sock")
            }]
        );
    }

    #[test]
    fn stale_pid_and_missing_socket_records_are_filtered() {
        let instances = vec![
            InstanceRecord {
                pid: 1,
                socket_path: PathBuf::from("/live"),
            },
            InstanceRecord {
                pid: 2,
                socket_path: PathBuf::from("/dead-pid"),
            },
            InstanceRecord {
                pid: 3,
                socket_path: PathBuf::from("/missing-socket"),
            },
        ];
        let live = live_instances(
            instances,
            |pid| pid != 2,
            |path| path == Path::new("/live") || path == Path::new("/dead-pid"),
        );
        assert_eq!(live.len(), 1);
        assert_eq!(live[0].pid, 1);
    }

    struct FragmentedReader<R> {
        inner: R,
        maximum: usize,
    }

    impl<R: Read> Read for FragmentedReader<R> {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            let maximum = self.maximum.min(buffer.len());
            self.inner.read(&mut buffer[..maximum])
        }
    }
}
