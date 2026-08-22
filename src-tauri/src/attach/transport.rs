use super::protocol::{decode_frame, Frame, FRAME_HEADER_LENGTH, MAX_PAYLOAD_LENGTH};
#[cfg(test)]
use std::io::Write;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

#[derive(Debug)]
pub(crate) enum ReadFrameError {
    Io(io::Error),
    Protocol(String),
}

pub(crate) struct FrameReader<R> {
    reader: R,
    buffered: Vec<u8>,
}

impl<R: Read> FrameReader<R> {
    pub(crate) fn new(reader: R) -> Self {
        Self {
            reader,
            buffered: Vec::new(),
        }
    }

    pub(crate) fn read_frame(&mut self) -> Result<Option<Frame>, ReadFrameError> {
        loop {
            if self.buffered.len() >= FRAME_HEADER_LENGTH {
                let payload_length = u32::from_be_bytes([
                    self.buffered[1],
                    self.buffered[2],
                    self.buffered[3],
                    self.buffered[4],
                ]) as usize;
                if payload_length > MAX_PAYLOAD_LENGTH {
                    return Err(ReadFrameError::Protocol(format!(
                        "frame payload is too large: {payload_length} bytes"
                    )));
                }
                let frame_length = FRAME_HEADER_LENGTH + payload_length;
                if self.buffered.len() >= frame_length {
                    let (frame, consumed) = decode_frame(&self.buffered[..frame_length])
                        .map_err(|error| ReadFrameError::Protocol(error.to_string()))?;
                    self.buffered.drain(..consumed);
                    return Ok(Some(frame));
                }
            }

            let mut chunk = [0u8; 8192];
            match self.reader.read(&mut chunk) {
                Ok(0) if self.buffered.is_empty() => return Ok(None),
                Ok(0) => {
                    return Err(ReadFrameError::Protocol(
                        "connection closed in the middle of a frame".to_string(),
                    ))
                }
                Ok(length) => self.buffered.extend_from_slice(&chunk[..length]),
                Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                Err(error) => return Err(ReadFrameError::Io(error)),
            }
        }
    }
}

#[cfg(test)]
pub(crate) fn write_frame(writer: &mut impl Write, frame: &Frame) -> Result<(), String> {
    let bytes = super::protocol::encode_frame(frame).map_err(|error| error.to_string())?;
    writer
        .write_all(&bytes)
        .and_then(|()| writer.flush())
        .map_err(|error| error.to_string())
}

pub(crate) fn peer_uid_is_allowed(peer_uid: u32, process_uid: u32) -> bool {
    peer_uid == process_uid
}

pub(crate) fn socket_path_under(yorishiro_home: &Path) -> PathBuf {
    yorishiro_home.join(super::protocol::SOCKET_RELATIVE_PATH)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};
    use std::os::unix::net::{UnixListener, UnixStream};

    pub(crate) fn bind_listener(yorishiro_home: &Path) -> Result<(UnixListener, PathBuf), String> {
        let run_dir = yorishiro_home.join(super::super::protocol::RUN_DIR_RELATIVE_PATH);
        if let Ok(metadata) = std::fs::symlink_metadata(&run_dir) {
            if metadata.file_type().is_symlink() {
                return Err("attach run directory must not be a symbolic link".to_string());
            }
        }
        std::fs::create_dir_all(&run_dir)
            .map_err(|error| format!("failed to create attach run directory: {error}"))?;
        std::fs::set_permissions(&run_dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("failed to secure attach run directory: {error}"))?;

        let socket_path = socket_path_under(yorishiro_home);
        if let Ok(metadata) = std::fs::symlink_metadata(&socket_path) {
            if !metadata.file_type().is_socket() {
                return Err(format!(
                    "attach socket path exists and is not a socket: {}",
                    socket_path.display()
                ));
            }
            match UnixStream::connect(&socket_path) {
                Ok(_) => {
                    return Err(format!(
                        "another attach server is already listening at {}",
                        socket_path.display()
                    ))
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound
                    ) =>
                {
                    std::fs::remove_file(&socket_path).map_err(|remove_error| {
                        format!("failed to remove stale attach socket: {remove_error}")
                    })?;
                }
                Err(error) => {
                    return Err(format!("failed to inspect existing attach socket: {error}"))
                }
            }
        }

        let listener = UnixListener::bind(&socket_path)
            .map_err(|error| format!("failed to bind attach socket: {error}"))?;
        std::fs::set_permissions(&socket_path, std::fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("failed to secure attach socket: {error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("failed to configure attach listener: {error}"))?;
        Ok((listener, socket_path))
    }

    pub(crate) fn peer_is_current_user(stream: &UnixStream) -> Result<bool, String> {
        let mut effective_uid: libc::uid_t = 0;
        let mut effective_gid: libc::gid_t = 0;
        let result =
            unsafe { libc::getpeereid(stream.as_raw_fd(), &mut effective_uid, &mut effective_gid) };
        if result != 0 {
            return Err(format!(
                "failed to inspect attach peer credentials: {}",
                io::Error::last_os_error()
            ));
        }
        Ok(peer_uid_is_allowed(
            effective_uid as u32,
            unsafe { libc::geteuid() } as u32,
        ))
    }

    pub(crate) use std::os::unix::net::{UnixListener as Listener, UnixStream as Stream};
}

#[cfg(target_os = "macos")]
pub(crate) use macos::{bind_listener, peer_is_current_user, Listener, Stream};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::attach::protocol::ControlMessage;

    #[test]
    fn transport_frame_helpers_round_trip() {
        let frame = Frame::Control(ControlMessage::Hello { replay: false });
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &frame).expect("write");
        let mut reader = FrameReader::new(bytes.as_slice());
        assert_eq!(reader.read_frame().expect("read"), Some(frame));
    }

    #[test]
    fn peer_filter_only_accepts_the_process_user() {
        assert!(peer_uid_is_allowed(501, 501));
        assert!(!peer_uid_is_allowed(0, 501));
        assert!(!peer_uid_is_allowed(502, 501));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn peer_credentials_accept_a_same_process_socket() {
        let (stream, _peer) = Stream::pair().expect("socket pair");
        assert!(peer_is_current_user(&stream).expect("peer credentials"));
    }

    #[test]
    fn socket_path_is_relative_to_yorishiro_home() {
        assert_eq!(
            socket_path_under(Path::new("/Users/test/.yorishiro")),
            Path::new("/Users/test/.yorishiro/run/attach.sock")
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn bind_replaces_a_stale_socket_and_applies_private_modes() {
        use std::os::unix::fs::PermissionsExt;

        let temp = tempfile::tempdir().expect("tempdir");
        let home = temp.path().join(".yorishiro");
        let (listener, socket_path) = bind_listener(&home).expect("first bind");
        drop(listener); // leaves the filesystem socket behind, as after an unclean exit

        let (replacement, replacement_path) = bind_listener(&home).expect("replace stale socket");
        assert_eq!(replacement_path, socket_path);
        assert_eq!(
            std::fs::metadata(home.join("run"))
                .expect("run metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            std::fs::metadata(&socket_path)
                .expect("socket metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        drop(replacement);
    }
}
