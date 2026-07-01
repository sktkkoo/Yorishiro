//! OSC 133 parser (state machine)。
//!
//! PTY byte stream を chunk で受け、`OSC 133 ; A | B | C | D[;<exit>]` の
//! marker を検出して OscEvent を emit する。Marker が chunk 境界で分断されても
//! 状態を保持する（feed_chunk を呼び続けるだけで連続 stream を捌ける）。
//!
//! 終端は BEL (0x07) と ST (ESC '\\') の両方に対応。malformed sequence は
//! 静かに捨てる（buffer reset、次の ESC を探す状態に戻る）。
//!
//! 詳細: docs/terminal.md §Shell integration / VT100.net OSC reference。
//!
//! Internal design-record: 2026-05-05-multi-pane-terminal.md.

const ESC: u8 = 0x1B;
const BEL: u8 = 0x07;
const ST_TAIL: u8 = b'\\';
const OSC_INTRODUCER: u8 = b']';

/// 1 つの OSC 133 marker を検出すると emit される event。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OscEvent {
    /// `OSC 133 ; A` — prompt の描画が始まる。
    PromptStart,
    /// `OSC 133 ; B` — prompt 描画完了、ここから user の入力。
    PromptEnd,
    /// `OSC 133 ; C` — user が Enter を押し、command 実行が始まる。
    CommandStart,
    /// `OSC 133 ; D[;<exit_code>]` — command 終了。exit_code は marker に乗ってる場合のみ。
    CommandEnd { exit_code: Option<i32> },
    /// `OSC 7 ; file://...` — current working directory notification。
    CurrentDir { cwd: String },
}

/// OSC body の最大長。これを超えたら malformed として捨てる。
/// OSC 7 cwd は長い path を運ぶため、通常の OSC 133 marker より余裕を持つ。
const MAX_OSC_BODY: usize = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    /// 通常 byte stream。ESC を待つ。
    Idle,
    /// ESC を受けた直後。']' で OSC 開始。
    AfterEsc,
    /// OSC body を読んでいる。BEL / ESC \ で終端。
    InOsc,
    /// OSC 中に ESC を受けた。'\\' で ST 終端、それ以外なら abort。
    InOscEsc,
}

pub struct Osc133Parser {
    state: State,
    body: Vec<u8>,
}

impl Osc133Parser {
    pub fn new() -> Self {
        Self {
            state: State::Idle,
            body: Vec::with_capacity(MAX_OSC_BODY),
        }
    }

    /// 1 byte feed。1 つの OSC 133 marker が完結すれば Some(event)。
    pub fn feed(&mut self, byte: u8) -> Option<OscEvent> {
        match self.state {
            State::Idle => {
                if byte == ESC {
                    self.state = State::AfterEsc;
                }
                None
            }
            State::AfterEsc => {
                if byte == OSC_INTRODUCER {
                    self.state = State::InOsc;
                    self.body.clear();
                } else {
                    // 別 escape sequence (CSI 等)。Phase B-2 では無視。
                    self.state = State::Idle;
                }
                None
            }
            State::InOsc => match byte {
                BEL => {
                    let event = parse_osc133(&self.body);
                    self.body.clear();
                    self.state = State::Idle;
                    event
                }
                ESC => {
                    self.state = State::InOscEsc;
                    None
                }
                _ => {
                    if self.body.len() < MAX_OSC_BODY {
                        self.body.push(byte);
                    } else {
                        // 上限超過 → abort
                        self.body.clear();
                        self.state = State::Idle;
                    }
                    None
                }
            },
            State::InOscEsc => {
                if byte == ST_TAIL {
                    let event = parse_osc133(&self.body);
                    self.body.clear();
                    self.state = State::Idle;
                    event
                } else {
                    // false alarm — 中で ESC + 別 char、buffer 捨てて Idle へ。
                    // 厳密には「ESC ] ... ESC <other>」も別 OSC として続けるが、
                    // 安全策で abort する。
                    self.body.clear();
                    self.state = State::Idle;
                    None
                }
            }
        }
    }

    /// chunk feed。順番に各 byte を feed し、emit された全 event を集める。
    pub fn feed_chunk(&mut self, chunk: &[u8]) -> Vec<OscEvent> {
        let mut events = Vec::new();
        for &b in chunk {
            if let Some(e) = self.feed(b) {
                events.push(e);
            }
        }
        events
    }
}

impl Default for Osc133Parser {
    fn default() -> Self {
        Self::new()
    }
}

/// "133;A" / "133;B" / "133;C" / "133;D" / "133;D;<exit>" を OscEvent に変換。
/// それ以外は None。
fn parse_osc133(body: &[u8]) -> Option<OscEvent> {
    let s = std::str::from_utf8(body).ok()?;
    if let Some(cwd) = parse_osc7_cwd(s) {
        return Some(OscEvent::CurrentDir { cwd });
    }
    let rest = s.strip_prefix("133;")?;
    let mut parts = rest.splitn(2, ';');
    let code = parts.next()?;
    match code {
        "A" => Some(OscEvent::PromptStart),
        "B" => Some(OscEvent::PromptEnd),
        "C" => Some(OscEvent::CommandStart),
        "D" => {
            let exit_code = parts.next().and_then(|s| s.parse::<i32>().ok());
            Some(OscEvent::CommandEnd { exit_code })
        }
        _ => None,
    }
}

fn parse_osc7_cwd(s: &str) -> Option<String> {
    let rest = s.strip_prefix("7;file://")?;
    let path_start = rest.find('/')?;
    let cwd = &rest[path_start..];
    if cwd.is_empty() {
        return None;
    }
    Some(cwd.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn feed_str(parser: &mut Osc133Parser, input: &[u8]) -> Vec<OscEvent> {
        parser.feed_chunk(input)
    }

    #[test]
    fn parses_command_start_with_bel_terminator() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]133;C\x07");
        assert_eq!(events, vec![OscEvent::CommandStart]);
    }

    #[test]
    fn parses_command_end_with_exit_code() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]133;D;0\x07");
        assert_eq!(events, vec![OscEvent::CommandEnd { exit_code: Some(0) }]);
    }

    #[test]
    fn parses_command_end_without_exit_code() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]133;D\x07");
        assert_eq!(events, vec![OscEvent::CommandEnd { exit_code: None }]);
    }

    #[test]
    fn parses_command_end_with_st_terminator() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]133;D;42\x1b\\");
        assert_eq!(
            events,
            vec![OscEvent::CommandEnd {
                exit_code: Some(42)
            }]
        );
    }

    #[test]
    fn parses_prompt_start_and_end() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]133;A\x07\x1b]133;B\x07");
        assert_eq!(events, vec![OscEvent::PromptStart, OscEvent::PromptEnd]);
    }

    #[test]
    fn parses_osc7_current_directory() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]7;file:///Users/alice/Charminal\x07");
        assert_eq!(
            events,
            vec![OscEvent::CurrentDir {
                cwd: "/Users/alice/Charminal".to_string()
            }]
        );
    }

    #[test]
    fn handles_marker_split_across_chunks() {
        let mut p = Osc133Parser::new();
        assert_eq!(feed_str(&mut p, b"\x1b]"), Vec::new());
        assert_eq!(feed_str(&mut p, b"133;"), Vec::new());
        assert_eq!(feed_str(&mut p, b"C"), Vec::new());
        assert_eq!(feed_str(&mut p, b"\x07"), vec![OscEvent::CommandStart]);
    }

    #[test]
    fn handles_marker_split_in_exit_code() {
        let mut p = Osc133Parser::new();
        assert_eq!(feed_str(&mut p, b"\x1b]133;D;1"), Vec::new());
        assert_eq!(
            feed_str(&mut p, b"27\x07"),
            vec![OscEvent::CommandEnd {
                exit_code: Some(127)
            }]
        );
    }

    #[test]
    fn ignores_non_133_osc() {
        let mut p = Osc133Parser::new();
        // OSC 0 (set window title) — parse 通すが OSC 133 ではないので no event
        let events = feed_str(&mut p, b"\x1b]0;Some Window Title\x07");
        assert_eq!(events, Vec::new());
    }

    #[test]
    fn ignores_unknown_133_code() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]133;Z\x07");
        assert_eq!(events, Vec::new());
    }

    #[test]
    fn passes_through_normal_text_between_markers() {
        let mut p = Osc133Parser::new();
        let events = feed_str(
            &mut p,
            b"hello world\x1b]133;C\x07cargo build\x1b]133;D;0\x07more text",
        );
        assert_eq!(
            events,
            vec![
                OscEvent::CommandStart,
                OscEvent::CommandEnd { exit_code: Some(0) }
            ]
        );
    }

    #[test]
    fn aborts_on_malformed_invalid_utf8_in_body() {
        let mut p = Osc133Parser::new();
        // Invalid UTF-8 in body → parse fails → no event
        let events = feed_str(&mut p, b"\x1b]133;\xFF\x07");
        assert_eq!(events, Vec::new());
    }

    #[test]
    fn drops_overflowing_body() {
        let mut p = Osc133Parser::new();
        let mut input: Vec<u8> = b"\x1b]133;D;".to_vec();
        // Pad with too many digits (over MAX_OSC_BODY)
        input.extend(std::iter::repeat_n(b'0', MAX_OSC_BODY + 10));
        input.push(BEL);
        let events = feed_str(&mut p, &input);
        // No event because buffer was dropped on overflow
        assert!(events.is_empty());
    }

    #[test]
    fn handles_esc_followed_by_non_osc_char() {
        let mut p = Osc133Parser::new();
        // ESC [ ... is CSI, not OSC. Parser should reject and stay sane.
        let events = feed_str(&mut p, b"\x1b[31mred\x1b[0m\x1b]133;C\x07");
        assert_eq!(events, vec![OscEvent::CommandStart]);
    }

    #[test]
    fn handles_esc_in_osc_body_with_non_st_followup() {
        let mut p = Osc133Parser::new();
        // ESC inside OSC, followed by something other than '\' → abort.
        let events = feed_str(&mut p, b"\x1b]133;C\x1bXrest");
        assert_eq!(events, Vec::new());
        // After abort, parser should recover and parse next marker
        let events = feed_str(&mut p, b"\x1b]133;D;0\x07");
        assert_eq!(events, vec![OscEvent::CommandEnd { exit_code: Some(0) }]);
    }

    #[test]
    fn parses_multiple_markers_in_single_chunk() {
        let mut p = Osc133Parser::new();
        let events = feed_str(
            &mut p,
            b"\x1b]133;A\x07prompt\x1b]133;B\x07cmd\x1b]133;C\x07output\x1b]133;D;0\x07",
        );
        assert_eq!(
            events,
            vec![
                OscEvent::PromptStart,
                OscEvent::PromptEnd,
                OscEvent::CommandStart,
                OscEvent::CommandEnd { exit_code: Some(0) }
            ]
        );
    }

    #[test]
    fn negative_exit_code_parses() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]133;D;-1\x07");
        assert_eq!(
            events,
            vec![OscEvent::CommandEnd {
                exit_code: Some(-1)
            }]
        );
    }

    #[test]
    fn non_numeric_exit_code_becomes_none() {
        let mut p = Osc133Parser::new();
        let events = feed_str(&mut p, b"\x1b]133;D;abc\x07");
        assert_eq!(events, vec![OscEvent::CommandEnd { exit_code: None }]);
    }
}
