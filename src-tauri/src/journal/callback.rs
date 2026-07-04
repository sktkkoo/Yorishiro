//! Journal callback — セッション開始時の記憶想起（P1）。
//!
//! app 起動時に決定論的ルール（日付の節目・久しぶりの起動）で記憶を最大 1 件
//! 選び、`~/.charminal/journal/callback-pending.txt` に書く。Claude の
//! UserPromptSubmit hook script がワンショットで消費して削除する。
//! 口にするかどうかは住人（LLM）の判断で、黙って流してよい。
//!
//! 設計判断（design-record: 2026-07-03-journal-callback-redesign.md）:
//! - 発火は決定論・選別は LLM。注入文言に想起の様態（「ふと思い出した」等）を
//!   主張させない。中立的な背景情報 + 日付ポインタのみ。
//! - PTY 由来テキストは扱わない（P1 は話題トリガーなし）。
//! - 状態ファイルは記憶の日付と発火日のみ保持し、本文は残さない。
//! - 壊れた状態ファイルで起動を止めない。fail-safe は「callback がやや多めに
//!   出る」方向（状態リセット）に倒す。
//! - 複数セッションの競合は「最後の書き込みが勝つ / まれな二重発火は許容」。

use std::collections::BTreeMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// 「久しぶりの起動」とみなす空白日数（normal）。帰納的調整の対象。
const LONG_ABSENCE_DAYS_NORMAL: i64 = 3;
/// 同・rare。
const LONG_ABSENCE_DAYS_RARE: i64 = 7;
/// callback 全体の最小間隔（日）。normal は 1 日 1 回まで。
const GLOBAL_MIN_GAP_DAYS_NORMAL: i64 = 1;
/// 同・rare。
const GLOBAL_MIN_GAP_DAYS_RARE: i64 = 7;
/// 同じ記憶を再発火させない cooldown（日）。
const MEMORY_COOLDOWN_DAYS_NORMAL: i64 = 21;
/// 同・rare。
const MEMORY_COOLDOWN_DAYS_RARE: i64 = 42;

/// config.json `journalCallback` の頻度ノブ。off スイッチ + 一ノブ。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Knob {
    Off,
    Rare,
    Normal,
}

impl Knob {
    fn from_config_value(value: Option<&str>) -> Self {
        match value {
            Some("off") => Knob::Off,
            Some("rare") => Knob::Rare,
            _ => Knob::Normal,
        }
    }

    fn long_absence_days(self) -> i64 {
        match self {
            Knob::Rare => LONG_ABSENCE_DAYS_RARE,
            _ => LONG_ABSENCE_DAYS_NORMAL,
        }
    }

    fn global_min_gap_days(self) -> i64 {
        match self {
            Knob::Rare => GLOBAL_MIN_GAP_DAYS_RARE,
            _ => GLOBAL_MIN_GAP_DAYS_NORMAL,
        }
    }

    fn memory_cooldown_days(self) -> i64 {
        match self {
            Knob::Rare => MEMORY_COOLDOWN_DAYS_RARE,
            _ => MEMORY_COOLDOWN_DAYS_NORMAL,
        }
    }
}

/// memories.md の 1 行（`YYYY-MM-DD: 本文`）。壊れた行はパース時に skip する。
#[derive(Debug, Clone)]
struct MemoryLine {
    date: String,
    days: i64,
    text: String,
}

/// 発火履歴。記憶の日付と発火日のみを持つ（本文は残さない）。
#[derive(Debug, Default, Serialize, Deserialize)]
struct CallbackState {
    /// 最後に callback を発火させた日（YYYY-MM-DD）。
    #[serde(default)]
    last_fired_on: Option<String>,
    /// 記憶の日付 → その記憶を最後に発火させた日。
    #[serde(default)]
    fired: BTreeMap<String, String>,
}

/// 発火判定の結果。
#[derive(Debug, PartialEq)]
struct Decision {
    memory_date: String,
    message: String,
}

fn journal_dir() -> Result<PathBuf, String> {
    Ok(crate::home_dir_or_err()?.join(".charminal").join("journal"))
}

fn state_path() -> Result<PathBuf, String> {
    Ok(journal_dir()?.join("callback-state.json"))
}

fn pending_path() -> Result<PathBuf, String> {
    Ok(journal_dir()?.join("callback-pending.txt"))
}

/// Howard Hinnant の days_from_civil。cohabitation.rs の civil_from_days の逆。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = if m > 2 { m as i64 - 3 } else { m as i64 + 9 };
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// `YYYY-MM-DD`（先頭 10 文字）を (y, m, d) にパースする。壊れていれば None。
fn parse_date(text: &str) -> Option<(i64, u32, u32)> {
    let bytes = text.as_bytes();
    if bytes.len() < 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        let s = text.get(range)?;
        if !s.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        s.parse().ok()
    };
    let y = digits(0..4)?;
    let m = digits(5..7)? as u32;
    let d = digits(8..10)? as u32;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some((y, m, d))
}

fn date_to_days(text: &str) -> Option<i64> {
    parse_date(text).map(|(y, m, d)| days_from_civil(y, m, d))
}

/// memories.md の本文から日付付きの行を抽出する。壊れた行は黙って skip。
fn parse_memories(content: &str) -> Vec<MemoryLine> {
    content
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (date_part, rest) = (line.get(0..10)?, line.get(10..)?);
            let days = date_to_days(date_part)?;
            let text = rest.trim_start_matches(':').trim();
            if text.is_empty() {
                return None;
            }
            Some(MemoryLine {
                date: date_part.to_string(),
                days,
                text: text.to_string(),
            })
        })
        .collect()
}

/// 発火判定の純関数本体。
///
/// 優先順位: 一年前の節目 > ひと月前の節目 > 久しぶりの起動（直近の記憶）。
/// cooldown 中の記憶は次の候補に譲る。すべて gate に落ちたら None。
fn decide(
    memories: &[MemoryLine],
    state: &CallbackState,
    today: (i64, u32, u32),
    last_shutdown_days: Option<i64>,
    knob: Knob,
) -> Option<Decision> {
    if knob == Knob::Off || memories.is_empty() {
        return None;
    }
    let (ty, tm, td) = today;
    let today_days = days_from_civil(ty, tm, td);

    // 全体 gate: 最小間隔内に発火済みなら沈黙。
    if let Some(last) = state.last_fired_on.as_deref().and_then(date_to_days) {
        if today_days - last < knob.global_min_gap_days() {
            return None;
        }
    }

    let cooled = |memory: &MemoryLine| -> bool {
        state
            .fired
            .get(&memory.date)
            .and_then(|fired_on| date_to_days(fired_on))
            .is_some_and(|fired| today_days - fired < knob.memory_cooldown_days())
    };

    // 候補を優先順位順に集める。
    let mut candidates: Vec<(&MemoryLine, String)> = Vec::new();

    let year_ago = format!("{:04}-{:02}-{:02}", ty - 1, tm, td);
    let (my, mm) = if tm == 1 { (ty - 1, 12) } else { (ty, tm - 1) };
    let month_ago = format!("{:04}-{:02}-{:02}", my, mm, td);

    for memory in memories {
        if memory.date == year_ago {
            candidates.push((memory, "ちょうど一年前".to_string()));
        }
    }
    for memory in memories {
        if memory.date == month_ago {
            candidates.push((memory, "ちょうどひと月前".to_string()));
        }
    }

    // 久しぶりの起動: 前回終了から一定日数空いたら、最も新しい記憶を候補にする。
    if let Some(shutdown_days) = last_shutdown_days {
        let gap = today_days - shutdown_days;
        if gap >= knob.long_absence_days() {
            if let Some(latest) = memories.iter().max_by_key(|m| m.days) {
                candidates.push((latest, format!("{}日ぶりの起動", gap)));
            }
        }
    }

    let (memory, reason) = candidates.into_iter().find(|(m, _)| !cooled(m))?;

    // 中立的な背景情報として組み立てる。想起の様態（「ふと思い出した」等）は
    // 主張しない。本文は住人自身が書いた memories.md の一行のみで、PTY 由来
    // テキストは含まれない。
    let message = format!(
        "過去の journal（{}、{}）: {}\n関係があれば触れてよいし、なければ流してかまわない。詳細は journal_read で {} を読める。",
        memory.date, reason, memory.text, memory.date
    );
    Some(Decision {
        memory_date: memory.date.clone(),
        message,
    })
}

/// 状態ファイルを読む。壊れていたら default（= cooldown リセット）で続行。
fn read_state(path: &std::path::Path) -> CallbackState {
    let Ok(text) = std::fs::read_to_string(path) else {
        return CallbackState::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_state_atomic(path: &std::path::Path, state: &CallbackState) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(state)
        .map_err(|e| format!("callback-state.json シリアライズ失敗: {}", e))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &serialized)
        .map_err(|e| format!("callback-state.json.tmp 書き込み失敗: {}", e))?;
    std::fs::rename(&tmp_path, path).map_err(|e| format!("callback-state.json rename 失敗: {}", e))
}

/// config.json の `journalCallback` を読む。読めなければ default（normal）。
fn read_knob() -> Knob {
    let value = crate::home_dir_or_err()
        .ok()
        .and_then(|home| std::fs::read_to_string(home.join(".charminal").join("config.json")).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|config| config.get("journalCallback")?.as_str().map(String::from));
    Knob::from_config_value(value.as_deref())
}

/// cohabitation.json の last_shutdown（ISO 8601）を日数に変換して返す。
fn last_shutdown_days() -> Option<i64> {
    let home = crate::home_dir_or_err().ok()?;
    let text = std::fs::read_to_string(home.join(".charminal").join("cohabitation.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let iso = value.get("last_shutdown")?.as_str()?;
    date_to_days(iso)
}

/// app 起動時に呼ぶ。発火すれば pending file を書き、しなければ古い pending を消す。
pub fn evaluate_on_boot() -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("SystemTime エラー: {}", e))?;
    let today = super::cohabitation::civil_from_days((now.as_secs() / 86400) as i64);
    evaluate_on_boot_at((today.0, today.1, today.2))
}

fn evaluate_on_boot_at(today: (i64, u32, u32)) -> Result<(), String> {
    let pending = pending_path()?;
    let knob = read_knob();
    let memories_text = super::read_memories().unwrap_or_default();
    let memories = parse_memories(&memories_text);
    let state_file = state_path()?;
    let mut state = read_state(&state_file);

    match decide(&memories, &state, today, last_shutdown_days(), knob) {
        Some(decision) => {
            let today_str = format!("{:04}-{:02}-{:02}", today.0, today.1, today.2);
            std::fs::create_dir_all(pending.parent().unwrap())
                .map_err(|e| format!("journal ディレクトリの作成に失敗: {}", e))?;
            std::fs::write(&pending, &decision.message)
                .map_err(|e| format!("callback-pending.txt 書き込み失敗: {}", e))?;
            state
                .fired
                .insert(decision.memory_date.clone(), today_str.clone());
            state.last_fired_on = Some(today_str);
            write_state_atomic(&state_file, &state)?;
            eprintln!("[journal-callback] fired: {}", decision.memory_date);
        }
        None => {
            // 前回消費されなかった pending は文脈が古いので捨てる（保留キューは作らない）。
            let _ = std::fs::remove_file(&pending);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn memory(date: &str, text: &str) -> MemoryLine {
        MemoryLine {
            date: date.to_string(),
            days: date_to_days(date).expect("valid date"),
            text: text.to_string(),
        }
    }

    #[test]
    fn parse_memories_skips_broken_lines() {
        let content =
            "2026-06-27: 花火を見た日。\nこわれた行\n2026-06-28:\n2026-06-30: 鳥の群れ。\n";
        let parsed = parse_memories(content);
        assert_eq!(parsed.len(), 2);
        assert_eq!(parsed[0].date, "2026-06-27");
        assert_eq!(parsed[0].text, "花火を見た日。");
        assert_eq!(parsed[1].date, "2026-06-30");
    }

    #[test]
    fn decide_off_never_fires() {
        let memories = vec![memory("2026-06-04", "節目の記憶。")];
        let state = CallbackState::default();
        let result = decide(&memories, &state, (2026, 7, 4), Some(0), Knob::Off);
        assert!(result.is_none());
    }

    #[test]
    fn decide_fires_on_month_anniversary() {
        let memories = vec![memory("2026-06-04", "ひと月前の記憶。")];
        let state = CallbackState::default();
        let result = decide(&memories, &state, (2026, 7, 4), None, Knob::Normal).expect("fires");
        assert_eq!(result.memory_date, "2026-06-04");
        assert!(result.message.contains("ちょうどひと月前"));
        assert!(result.message.contains("journal_read"));
        // 想起の様態を主張しない
        assert!(!result.message.contains("思い出した"));
    }

    #[test]
    fn decide_prefers_year_anniversary_over_month() {
        let memories = vec![
            memory("2026-06-04", "ひと月前。"),
            memory("2025-07-04", "一年前。"),
        ];
        let state = CallbackState::default();
        let result = decide(&memories, &state, (2026, 7, 4), None, Knob::Normal).expect("fires");
        assert_eq!(result.memory_date, "2025-07-04");
        assert!(result.message.contains("ちょうど一年前"));
    }

    #[test]
    fn decide_fires_latest_memory_after_long_absence() {
        let memories = vec![
            memory("2026-06-20", "古い記憶。"),
            memory("2026-06-28", "新しい記憶。"),
        ];
        let state = CallbackState::default();
        let shutdown = date_to_days("2026-06-30");
        let result =
            decide(&memories, &state, (2026, 7, 4), shutdown, Knob::Normal).expect("fires");
        assert_eq!(result.memory_date, "2026-06-28");
        assert!(result.message.contains("4日ぶりの起動"));
    }

    #[test]
    fn decide_short_gap_does_not_fire_absence() {
        let memories = vec![memory("2026-06-28", "新しい記憶。")];
        let state = CallbackState::default();
        let shutdown = date_to_days("2026-07-03");
        assert!(decide(&memories, &state, (2026, 7, 4), shutdown, Knob::Normal).is_none());
    }

    #[test]
    fn decide_respects_global_min_gap() {
        let memories = vec![memory("2026-06-04", "ひと月前の記憶。")];
        let state = CallbackState {
            last_fired_on: Some("2026-07-04".to_string()),
            fired: BTreeMap::new(),
        };
        assert!(decide(&memories, &state, (2026, 7, 4), None, Knob::Normal).is_none());
    }

    #[test]
    fn decide_skips_cooled_memory_and_falls_back() {
        let mut fired = BTreeMap::new();
        fired.insert("2026-06-04".to_string(), "2026-06-25".to_string());
        let memories = vec![
            memory("2026-06-04", "ひと月前だが最近発火済み。"),
            memory("2026-06-28", "新しい記憶。"),
        ];
        let state = CallbackState {
            last_fired_on: Some("2026-06-25".to_string()),
            fired,
        };
        // 節目候補は cooldown 中 → 久しぶり候補（直近の記憶）へ譲る。
        let shutdown = date_to_days("2026-06-30");
        let result =
            decide(&memories, &state, (2026, 7, 4), shutdown, Knob::Normal).expect("fires");
        assert_eq!(result.memory_date, "2026-06-28");
    }

    #[test]
    fn decide_rare_widens_gates() {
        let memories = vec![memory("2026-06-28", "新しい記憶。")];
        let state = CallbackState::default();
        // gap 4 日は normal なら発火、rare（7 日）なら沈黙。
        let shutdown = date_to_days("2026-06-30");
        assert!(decide(&memories, &state, (2026, 7, 4), shutdown, Knob::Normal).is_some());
        assert!(decide(&memories, &state, (2026, 7, 4), shutdown, Knob::Rare).is_none());
    }

    #[test]
    fn read_state_survives_broken_file() {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-callback-state-{}-broken.json",
            std::process::id()
        ));
        std::fs::write(&tmp, "{ こわれた json").expect("write");
        let state = read_state(&tmp);
        assert!(state.last_fired_on.is_none());
        assert!(state.fired.is_empty());
        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn days_from_civil_roundtrips_with_civil_from_days() {
        for date in ["1970-01-01", "2000-02-29", "2026-07-04", "2026-12-31"] {
            let (y, m, d) = parse_date(date).expect("parse");
            let days = days_from_civil(y, m, d);
            assert_eq!(super::super::cohabitation::civil_from_days(days), (y, m, d));
        }
    }

    #[test]
    fn evaluate_on_boot_writes_and_cleans_pending() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = std::env::temp_dir().join(format!(
            "charminal-callback-boot-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&home).expect("mkdir");
        std::env::set_var("HOME", &home);

        // ひと月前の記憶を仕込む → 発火して pending が書かれる。
        super::super::append_memory("2026-06-04", "ひと月前の記憶。").expect("memory");
        evaluate_on_boot_at((2026, 7, 4)).expect("boot eval");
        let pending = home.join(".charminal/journal/callback-pending.txt");
        let content = std::fs::read_to_string(&pending).expect("pending exists");
        assert!(content.contains("2026-06-04"));

        // 同日にもう一度起動 → 全体 gate で沈黙し、古い pending は消える。
        evaluate_on_boot_at((2026, 7, 4)).expect("boot eval 2");
        assert!(!pending.exists());

        // 状態ファイルには日付のみで本文が残らない。
        let state_text =
            std::fs::read_to_string(home.join(".charminal/journal/callback-state.json"))
                .expect("state");
        assert!(state_text.contains("2026-06-04"));
        assert!(!state_text.contains("ひと月前の記憶"));

        let _ = std::fs::remove_dir_all(&home);
    }
}
