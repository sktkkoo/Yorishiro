//! Transport-independent wire protocol for external terminal clients.
//!
//! Each frame is encoded as `[type: u8][length: u32, big-endian][payload]`.

use serde::{Deserialize, Serialize};
use std::error::Error;
use std::fmt;

pub const DATA_FRAME_TYPE: u8 = 0x00;
pub const CONTROL_FRAME_TYPE: u8 = 0x01;
pub const FRAME_HEADER_LENGTH: usize = 5;

/// Maximum payload accepted by the codec (16 MiB).
pub const MAX_PAYLOAD_LENGTH: usize = 16 * 1024 * 1024;

/// Paths are relative to the configured Yorishiro home directory.
pub const RUN_DIR_RELATIVE_PATH: &str = "run";
pub const SOCKET_RELATIVE_PATH: &str = "run/attach.sock";

/// Ctrl-\\ followed by `q`.
pub const DETACH_SEQUENCE: [u8; 2] = [0x1c, b'q'];

pub const EXTERNAL_CLIENTS_CHANGED_EVENT: &str = "external-clients-changed";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExternalClientsChangedPayload {
    pub count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListedSession {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub alive: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "kebab-case")]
pub enum ControlMessage {
    Hello {
        replay: bool,
    },
    List,
    ListResult {
        sessions: Vec<ListedSession>,
    },
    Attach {
        session_id: String,
    },
    Attached {
        session_id: String,
        cols: u16,
        rows: u16,
    },
    Resize {
        cols: u16,
        rows: u16,
    },
    Detach,
    Exit {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        code: Option<i32>,
    },
    SizeChanged {
        cols: u16,
        rows: u16,
    },
    ResizeAuthority {
        client_id: String,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Data(Vec<u8>),
    Control(ControlMessage),
}

#[derive(Debug)]
pub enum ProtocolError {
    UnknownFrameType(u8),
    TruncatedHeader { actual: usize },
    TruncatedPayload { expected: usize, actual: usize },
    PayloadTooLarge { length: usize, maximum: usize },
    InvalidControlUtf8(std::str::Utf8Error),
    InvalidControlJson(serde_json::Error),
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnknownFrameType(frame_type) => {
                write!(formatter, "unknown frame type: 0x{frame_type:02x}")
            }
            Self::TruncatedHeader { actual } => write!(
                formatter,
                "truncated frame header: expected {FRAME_HEADER_LENGTH} bytes, got {actual}"
            ),
            Self::TruncatedPayload { expected, actual } => write!(
                formatter,
                "truncated frame payload: expected {expected} bytes, got {actual}"
            ),
            Self::PayloadTooLarge { length, maximum } => write!(
                formatter,
                "frame payload is too large: {length} bytes exceeds {maximum} bytes"
            ),
            Self::InvalidControlUtf8(error) => {
                write!(formatter, "control payload is not valid UTF-8: {error}")
            }
            Self::InvalidControlJson(error) => {
                write!(formatter, "control payload is not valid JSON: {error}")
            }
        }
    }
}

impl Error for ProtocolError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::InvalidControlUtf8(error) => Some(error),
            Self::InvalidControlJson(error) => Some(error),
            _ => None,
        }
    }
}

/// Encode one complete frame.
pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, ProtocolError> {
    let (frame_type, payload) = match frame {
        Frame::Data(payload) => (DATA_FRAME_TYPE, payload.clone()),
        Frame::Control(control) => (
            CONTROL_FRAME_TYPE,
            serde_json::to_vec(control).map_err(ProtocolError::InvalidControlJson)?,
        ),
    };

    if payload.len() > MAX_PAYLOAD_LENGTH {
        return Err(ProtocolError::PayloadTooLarge {
            length: payload.len(),
            maximum: MAX_PAYLOAD_LENGTH,
        });
    }

    let payload_length = payload.len() as u32;
    let mut encoded = Vec::with_capacity(FRAME_HEADER_LENGTH + payload.len());
    encoded.push(frame_type);
    encoded.extend_from_slice(&payload_length.to_be_bytes());
    encoded.extend_from_slice(&payload);
    Ok(encoded)
}

/// Decode the first complete frame in `input` and return it with the number of
/// consumed bytes. Any following frame bytes are left for the caller.
pub fn decode_frame(input: &[u8]) -> Result<(Frame, usize), ProtocolError> {
    if input.len() < FRAME_HEADER_LENGTH {
        return Err(ProtocolError::TruncatedHeader {
            actual: input.len(),
        });
    }

    let frame_type = input[0];
    if frame_type != DATA_FRAME_TYPE && frame_type != CONTROL_FRAME_TYPE {
        return Err(ProtocolError::UnknownFrameType(frame_type));
    }

    let payload_length = u32::from_be_bytes([input[1], input[2], input[3], input[4]]) as usize;
    if payload_length > MAX_PAYLOAD_LENGTH {
        return Err(ProtocolError::PayloadTooLarge {
            length: payload_length,
            maximum: MAX_PAYLOAD_LENGTH,
        });
    }

    let available_payload_length = input.len() - FRAME_HEADER_LENGTH;
    if available_payload_length < payload_length {
        return Err(ProtocolError::TruncatedPayload {
            expected: payload_length,
            actual: available_payload_length,
        });
    }

    let consumed = FRAME_HEADER_LENGTH + payload_length;
    let payload = &input[FRAME_HEADER_LENGTH..consumed];
    let frame = match frame_type {
        DATA_FRAME_TYPE => Frame::Data(payload.to_vec()),
        CONTROL_FRAME_TYPE => {
            let json = std::str::from_utf8(payload).map_err(ProtocolError::InvalidControlUtf8)?;
            let control = serde_json::from_str(json).map_err(ProtocolError::InvalidControlJson)?;
            Frame::Control(control)
        }
        _ => unreachable!("frame type was validated above"),
    };

    Ok((frame, consumed))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    fn round_trip(frame: Frame) {
        let encoded = encode_frame(&frame).expect("encode frame");
        let (decoded, consumed) = decode_frame(&encoded).expect("decode frame");
        assert_eq!(decoded, frame);
        assert_eq!(consumed, encoded.len());
    }

    #[test]
    fn round_trips_every_control_variant() {
        let controls = [
            ControlMessage::Hello { replay: false },
            ControlMessage::List,
            ControlMessage::ListResult {
                sessions: vec![
                    ListedSession {
                        id: "shell-1".into(),
                        cwd: Some("/work".into()),
                        alive: true,
                    },
                    ListedSession {
                        id: "shell-2".into(),
                        cwd: None,
                        alive: false,
                    },
                ],
            },
            ControlMessage::Attach {
                session_id: "shell-1".into(),
            },
            ControlMessage::Attached {
                session_id: "shell-1".into(),
                cols: 120,
                rows: 40,
            },
            ControlMessage::Resize { cols: 80, rows: 24 },
            ControlMessage::Detach,
            ControlMessage::Exit { code: Some(7) },
            ControlMessage::Exit { code: None },
            ControlMessage::SizeChanged {
                cols: 132,
                rows: 50,
            },
            ControlMessage::ResizeAuthority {
                client_id: "client-2".into(),
            },
            ControlMessage::Error {
                code: "no-such-session".into(),
                message: "session not found".into(),
            },
        ];

        for control in controls {
            round_trip(Frame::Control(control));
        }
    }

    #[test]
    fn round_trips_arbitrary_binary_data_unchanged() {
        round_trip(Frame::Data(vec![0x00, 0xff, 0x1c, b'q', 0x80, 0x0a]));
    }

    #[test]
    fn uses_big_endian_payload_length() {
        let encoded = encode_frame(&Frame::Data(vec![0; 0x0102])).expect("encode frame");
        assert_eq!(
            &encoded[..FRAME_HEADER_LENGTH],
            &[0x00, 0x00, 0x00, 0x01, 0x02]
        );
    }

    #[test]
    fn decodes_one_frame_and_reports_consumed_bytes() {
        let first = encode_frame(&Frame::Data(vec![1, 2])).expect("encode first");
        let second = encode_frame(&Frame::Data(vec![3])).expect("encode second");
        let mut joined = first.clone();
        joined.extend_from_slice(&second);

        let (decoded, consumed) = decode_frame(&joined).expect("decode first");
        assert_eq!(decoded, Frame::Data(vec![1, 2]));
        assert_eq!(consumed, first.len());
    }

    #[test]
    fn rejects_unknown_frame_type() {
        let error = decode_frame(&[0x7f, 0, 0, 0, 0]).expect_err("unknown type");
        assert!(matches!(error, ProtocolError::UnknownFrameType(0x7f)));
    }

    #[test]
    fn rejects_truncated_header() {
        let error = decode_frame(&[DATA_FRAME_TYPE, 0, 0, 0]).expect_err("truncated header");
        assert!(matches!(
            error,
            ProtocolError::TruncatedHeader { actual: 4 }
        ));
    }

    #[test]
    fn rejects_truncated_payload() {
        let error =
            decode_frame(&[DATA_FRAME_TYPE, 0, 0, 0, 3, 1, 2]).expect_err("truncated payload");
        assert!(matches!(
            error,
            ProtocolError::TruncatedPayload {
                expected: 3,
                actual: 2
            }
        ));
    }

    #[test]
    fn rejects_oversized_declared_payload_before_allocation() {
        let oversized = (MAX_PAYLOAD_LENGTH as u32 + 1).to_be_bytes();
        let input = [
            DATA_FRAME_TYPE,
            oversized[0],
            oversized[1],
            oversized[2],
            oversized[3],
        ];
        let error = decode_frame(&input).expect_err("oversized payload");
        assert!(matches!(
            error,
            ProtocolError::PayloadTooLarge {
                length,
                maximum: MAX_PAYLOAD_LENGTH
            } if length == MAX_PAYLOAD_LENGTH + 1
        ));
    }

    #[test]
    fn rejects_oversized_payload_during_encoding() {
        let error = encode_frame(&Frame::Data(vec![0; MAX_PAYLOAD_LENGTH + 1]))
            .expect_err("oversized payload");
        assert!(matches!(error, ProtocolError::PayloadTooLarge { .. }));
    }

    #[test]
    fn rejects_non_utf8_control_payload() {
        let input = [CONTROL_FRAME_TYPE, 0, 0, 0, 1, 0xff];
        let error = decode_frame(&input).expect_err("invalid UTF-8");
        assert!(matches!(error, ProtocolError::InvalidControlUtf8(_)));
    }

    #[test]
    fn rejects_invalid_control_json() {
        let payload = b"{not-json}";
        let mut input = vec![CONTROL_FRAME_TYPE];
        input.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        input.extend_from_slice(payload);

        let error = decode_frame(&input).expect_err("invalid JSON");
        assert!(matches!(error, ProtocolError::InvalidControlJson(_)));
    }

    #[test]
    fn accepts_unknown_json_fields_for_forward_compatibility() {
        let payload =
            br#"{"t":"attached","session_id":"shell-1","cols":80,"rows":24,"future":true}"#;
        let mut input = vec![CONTROL_FRAME_TYPE];
        input.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        input.extend_from_slice(payload);

        let (frame, consumed) = decode_frame(&input).expect("decode with unknown field");
        assert_eq!(
            frame,
            Frame::Control(ControlMessage::Attached {
                session_id: "shell-1".into(),
                cols: 80,
                rows: 24,
            })
        );
        assert_eq!(consumed, input.len());
    }

    #[test]
    fn serializes_stable_control_names_and_fields() {
        assert_eq!(
            serde_json::to_value(ControlMessage::ResizeAuthority {
                client_id: "client-1".into()
            })
            .expect("serialize control"),
            serde_json::json!({"t": "resize-authority", "client_id": "client-1"})
        );
        assert_eq!(
            serde_json::to_value(ControlMessage::ListResult { sessions: vec![] })
                .expect("serialize control"),
            serde_json::json!({"t": "list-result", "sessions": []})
        );
    }
}
