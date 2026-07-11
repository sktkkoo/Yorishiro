//! Journal callback — セッション開始時の記憶想起（P1）。
//!
//! agent session の spawn ごとに決定論的ルール（日付の節目・久しぶりの起動）で
//! 記憶を最大 1 件選び、`~/.yorishiro/journal/callback-pending.txt` に書く。
//! Claude の UserPromptSubmit hook script がワンショットで消費して削除する。
//! 口にするかどうかは住人（LLM）の判断で、黙って流してよい。
//! app 開きっぱなし運用でも、翌日の respawn / 新セッションで節目が評価される。
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
/// 「最近の記憶」として想起する window（日）。normal のみ。帰納的調整の対象。
const RECENT_WINDOW_DAYS_NORMAL: i64 = 7;
/// 同じ記憶を再発火させない cooldown（日）。
const MEMORY_COOLDOWN_DAYS_NORMAL: i64 = 21;
/// 同・rare。
const MEMORY_COOLDOWN_DAYS_RARE: i64 = 42;
/// fired 履歴の保持期間（日）。最長 cooldown を超えた記録は意味を持たないので
/// 書き込み時に掃除し、memories.md から消えた記憶の dead entry を残さない。
const FIRED_RETENTION_DAYS: i64 = 63;

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

    /// 「最近の記憶」想起の window（日）。0 は無効。rare は節目と久しぶりの
    /// 起動だけに絞り、日常の想起をしない。
    fn recent_window_days(self) -> i64 {
        match self {
            Knob::Normal => RECENT_WINDOW_DAYS_NORMAL,
            _ => 0,
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

/// 発火履歴。記憶のキーと発火日のみを持つ（本文は残さない）。
#[derive(Debug, Default, Serialize, Deserialize)]
struct CallbackState {
    /// 最後に callback を発火させた日（YYYY-MM-DD）。発火ペースの上限は
    /// user を callback の頻発から守る gate なので、persona を跨いで共有する。
    #[serde(default)]
    last_fired_on: Option<String>,
    /// `<persona>|<記憶の日付>` → その記憶を最後に発火させた日。
    /// 記憶は persona ごとの memories.md 由来なので、persona で namespace
    /// しないと別 persona の同日付の記憶と cooldown が干渉する。
    #[serde(default)]
    fired: BTreeMap<String, String>,
    /// 現在 pending file に載っている記憶のキー（`<persona>|<日付>`）。次の
    /// 評価時に pending がまだ残っていれば（= 未消費なら）cooldown を返金する。
    #[serde(default)]
    pending_memory: Option<String>,
}

/// fired / pending_memory のキー。persona ごとの記憶空間を分ける。
fn fired_key(persona: &str, memory_date: &str) -> String {
    format!("{persona}|{memory_date}")
}

/// 発火判定の結果。
#[derive(Debug, PartialEq)]
struct Decision {
    memory_date: String,
    message: String,
}

fn journal_dir() -> Result<PathBuf, String> {
    Ok(crate::yorishiro_home_path()?.join("journal"))
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

fn is_leap_year(y: i64) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

fn days_in_month(y: i64, m: u32) -> u32 {
    match m {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ => {
            if is_leap_year(y) {
                29
            } else {
                28
            }
        }
    }
}

/// 日番号を月の実在日数にクランプして `YYYY-MM-DD` を組み立てる。
/// 3/31 のひと月前は 2/28（うるう年は 2/29）、2/29 の一年前は 2/28 になる。
/// 文字列一致で "2026-02-31" のような非実在日付を作って静かに取りこぼさないため。
fn clamped_date_string(y: i64, m: u32, d: u32) -> String {
    format!("{:04}-{:02}-{:02}", y, m, d.min(days_in_month(y, m)))
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
/// 優先順位: 一年前の節目 > ひと月前の節目 > 久しぶりの起動（直近の記憶） >
/// 最近の記憶（normal のみ）。cooldown 中の記憶は次の候補に譲る。すべて
/// gate に落ちたら None。
fn decide(
    memories: &[MemoryLine],
    state: &CallbackState,
    today: (i64, u32, u32),
    last_shutdown_days: Option<i64>,
    knob: Knob,
    persona: &str,
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
            .get(&fired_key(persona, &memory.date))
            .and_then(|fired_on| date_to_days(fired_on))
            .is_some_and(|fired| today_days - fired < knob.memory_cooldown_days())
    };

    // 候補を優先順位順に集める。
    let mut candidates: Vec<(&MemoryLine, String)> = Vec::new();

    let year_ago = clamped_date_string(ty - 1, tm, td);
    let (my, mm) = if tm == 1 { (ty - 1, 12) } else { (ty, tm - 1) };
    let month_ago = clamped_date_string(my, mm, td);

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

    // 最近の記憶: 節目でも久しぶりでもない日の default 想起（normal のみ）。
    // 記念日は「たまに」だから効く——日常は昨日や数日前が受け持つ。
    // 今日書かれた行は「さっきのこと」なので対象外。最新 1 件だけを候補にし、
    // cooldown 中でも古い記憶へは遡らない（journal が途絶えたら window と
    // cooldown が自然に沈黙させ、次に口を開くのは節目だけになる）。
    let recent_window = knob.recent_window_days();
    if recent_window > 0 {
        if let Some(latest) = memories
            .iter()
            .filter(|m| (1..=recent_window).contains(&(today_days - m.days)))
            .max_by_key(|m| m.days)
        {
            let diff = today_days - latest.days;
            let reason = if diff == 1 {
                "昨日".to_string()
            } else {
                format!("{}日前", diff)
            };
            candidates.push((latest, reason));
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
    let value = crate::yorishiro_home_path()
        .ok()
        .and_then(|home| std::fs::read_to_string(home.join("config.json")).ok())
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|config| config.get("journalCallback")?.as_str().map(String::from));
    Knob::from_config_value(value.as_deref())
}

/// cohabitation.json の last_shutdown（ISO 8601）を日数に変換して返す。
fn last_shutdown_days() -> Option<i64> {
    let home = crate::yorishiro_home_path().ok()?;
    let text = std::fs::read_to_string(home.join("cohabitation.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    let iso = value.get("last_shutdown")?.as_str()?;
    date_to_days(iso)
}

/// 今日の日付を local time で返す。
///
/// 記憶の日付は住人（LLM）が体感の「今日」で書くため、突き合わせる側も local に
/// 揃える。UTC のままだと JST では毎朝 9 時間の窓で節目判定が 1 日ずれる。
/// chrono 非依存の方針のため unix では `date` コマンドに問い合わせ、
/// 失敗時と非 unix は UTC 日へフォールバックする。
fn local_today() -> Result<(i64, u32, u32), String> {
    #[cfg(unix)]
    {
        if let Ok(output) = std::process::Command::new("date").arg("+%Y-%m-%d").output() {
            if output.status.success() {
                if let Some(parsed) = std::str::from_utf8(&output.stdout)
                    .ok()
                    .and_then(|s| parse_date(s.trim()))
                {
                    return Ok(parsed);
                }
            }
        }
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("SystemTime エラー: {}", e))?;
    Ok(super::cohabitation::civil_from_days(
        (now.as_secs() / 86400) as i64,
    ))
}

/// agent session の spawn 時に呼ぶ。発火すれば pending file を書き、
/// しなければ古い pending を消す。
///
/// `can_deliver_callback` は「この agent に pending を届ける経路があるか」。
/// 現状の消費経路は Claude の UserPromptSubmit hook だけなので、呼び出し側は
/// adapter の lifecycle_hooks を渡す。経路のない agent（Codex 等）では評価
/// 自体を skip する——届かない発火で last_fired_on を焼くと、同日にあとから
/// 起動した hook 持ち agent の分まで global gate で潰してしまうため。
pub fn evaluate_on_session_spawn(can_deliver_callback: bool) -> Result<(), String> {
    if !can_deliver_callback {
        return Ok(());
    }
    evaluate_at(local_today()?)
}

fn evaluate_at(today: (i64, u32, u32)) -> Result<(), String> {
    let pending = pending_path()?;
    let knob = read_knob();
    // 記憶は active persona の memories.md 由来。fired キーも同じ persona で
    // namespace し、別 persona の同日付の記憶と cooldown が干渉しないようにする。
    let persona = super::active_persona_id();
    let memories_text = super::read_memories().unwrap_or_default();
    let memories = parse_memories(&memories_text);
    let state_file = state_path()?;
    let mut state = read_state(&state_file);
    let today_days = days_from_civil(today.0, today.1, today.2);

    // 前回の pending が未消費のまま残っていたら、その記憶の cooldown を返金する。
    // 選抜されただけで一度も届いていない記憶が 21 日焼かれるのを防ぐ
    // （fail-safe は「多めに出る」側に倒す方針）。全体 gate（last_fired_on）は
    // 発火ペースの上限なので返金しない。
    if pending.exists() {
        if let Some(unconsumed) = state.pending_memory.take() {
            state.fired.remove(&unconsumed);
        }
    }

    match decide(
        &memories,
        &state,
        today,
        last_shutdown_days(),
        knob,
        &persona,
    ) {
        Some(decision) => {
            let today_str = format!("{:04}-{:02}-{:02}", today.0, today.1, today.2);
            std::fs::create_dir_all(pending.parent().unwrap())
                .map_err(|e| format!("journal ディレクトリの作成に失敗: {}", e))?;
            std::fs::write(&pending, &decision.message)
                .map_err(|e| format!("callback-pending.txt 書き込み失敗: {}", e))?;
            let key = fired_key(&persona, &decision.memory_date);
            state.fired.insert(key.clone(), today_str.clone());
            state.last_fired_on = Some(today_str);
            state.pending_memory = Some(key);
            eprintln!("[journal-callback] fired: {}", decision.memory_date);
        }
        None => {
            // 前回消費されなかった pending は文脈が古いので捨てる（保留キューは作らない）。
            let _ = std::fs::remove_file(&pending);
            state.pending_memory = None;
        }
    }

    // 最長 cooldown を超えた fired 記録は判定に影響しないので掃除する。
    state.fired.retain(|_, fired_on| {
        date_to_days(fired_on).is_some_and(|fired| today_days - fired <= FIRED_RETENTION_DAYS)
    });
    write_state_atomic(&state_file, &state)?;
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
        let result = decide(&memories, &state, (2026, 7, 4), Some(0), Knob::Off, "yori");
        assert!(result.is_none());
    }

    #[test]
    fn decide_fires_on_month_anniversary() {
        let memories = vec![memory("2026-06-04", "ひと月前の記憶。")];
        let state = CallbackState::default();
        let result =
            decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").expect("fires");
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
        let result =
            decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").expect("fires");
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
        let result = decide(
            &memories,
            &state,
            (2026, 7, 4),
            shutdown,
            Knob::Normal,
            "yori",
        )
        .expect("fires");
        assert_eq!(result.memory_date, "2026-06-28");
        assert!(result.message.contains("4日ぶりの起動"));
    }

    #[test]
    fn decide_short_gap_does_not_fire_absence() {
        // recent window の外の記憶にして、久しぶり判定だけを見る。
        let memories = vec![memory("2026-06-20", "少し前の記憶。")];
        let state = CallbackState::default();
        let shutdown = date_to_days("2026-07-03");
        assert!(decide(
            &memories,
            &state,
            (2026, 7, 4),
            shutdown,
            Knob::Normal,
            "yori"
        )
        .is_none());
    }

    #[test]
    fn decide_fires_yesterdays_memory_as_recent() {
        let memories = vec![memory("2026-07-03", "夕方の散歩。")];
        let state = CallbackState::default();
        let result =
            decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").expect("fires");
        assert_eq!(result.memory_date, "2026-07-03");
        assert!(result.message.contains("昨日"));
    }

    #[test]
    fn decide_recent_reason_counts_days_ago() {
        let memories = vec![memory("2026-07-01", "雨上がりの虹。")];
        let state = CallbackState::default();
        let result =
            decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").expect("fires");
        assert_eq!(result.memory_date, "2026-07-01");
        assert!(result.message.contains("3日前"));
    }

    #[test]
    fn decide_recent_ignores_todays_entry() {
        let memories = vec![memory("2026-07-04", "書いたばかりの記憶。")];
        let state = CallbackState::default();
        assert!(decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").is_none());
    }

    #[test]
    fn decide_recent_window_boundary() {
        // window ちょうどは発火し、1 日超えたら沈黙する。
        // 帰納的調整（定数変更）に追従するよう、日付は定数から組み立てる。
        let today = (2026, 7, 4);
        let today_days = days_from_civil(today.0, today.1, today.2);
        let date_at = |diff: i64| {
            let (y, m, d) = super::super::cohabitation::civil_from_days(today_days - diff);
            format!("{:04}-{:02}-{:02}", y, m, d)
        };
        let inside = vec![memory(&date_at(RECENT_WINDOW_DAYS_NORMAL), "window 内。")];
        let state = CallbackState::default();
        assert!(decide(&inside, &state, today, None, Knob::Normal, "yori").is_some());
        let outside = vec![memory(
            &date_at(RECENT_WINDOW_DAYS_NORMAL + 1),
            "window 外。",
        )];
        assert!(decide(&outside, &state, today, None, Knob::Normal, "yori").is_none());
    }

    #[test]
    fn decide_rare_has_no_recent_recall() {
        let memories = vec![memory("2026-07-03", "夕方の散歩。")];
        let state = CallbackState::default();
        assert!(decide(&memories, &state, (2026, 7, 4), None, Knob::Rare, "yori").is_none());
    }

    #[test]
    fn decide_recent_does_not_fall_back_to_older_memories() {
        // 最新が cooldown 中なら黙る。古い記憶まで遡って埋め草を喋らない。
        let mut fired = BTreeMap::new();
        fired.insert(fired_key("yori", "2026-07-03"), "2026-07-03".to_string());
        let memories = vec![
            memory("2026-07-02", "一昨日の買い物。"),
            memory("2026-07-03", "夕方の散歩。"),
        ];
        let state = CallbackState {
            last_fired_on: Some("2026-07-03".to_string()),
            fired,
            ..CallbackState::default()
        };
        assert!(decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").is_none());
    }

    #[test]
    fn decide_prefers_anniversary_over_recent() {
        let memories = vec![
            memory("2026-07-03", "夕方の散歩。"),
            memory("2026-06-04", "ひと月前の記憶。"),
        ];
        let state = CallbackState::default();
        let result =
            decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").expect("fires");
        assert_eq!(result.memory_date, "2026-06-04");
        assert!(result.message.contains("ちょうどひと月前"));
    }

    #[test]
    fn decide_recent_fires_daily_with_fresh_memories() {
        // 毎日 journal が書かれていれば、翌日にはその「昨日」を想起できる。
        let mut fired = BTreeMap::new();
        fired.insert(fired_key("yori", "2026-07-02"), "2026-07-03".to_string());
        let memories = vec![
            memory("2026-07-02", "一昨日の買い物。"),
            memory("2026-07-03", "夕方の散歩。"),
        ];
        let state = CallbackState {
            last_fired_on: Some("2026-07-03".to_string()),
            fired,
            ..CallbackState::default()
        };
        let result =
            decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").expect("fires");
        assert_eq!(result.memory_date, "2026-07-03");
        assert!(result.message.contains("昨日"));
    }

    #[test]
    fn decide_respects_global_min_gap() {
        let memories = vec![memory("2026-06-04", "ひと月前の記憶。")];
        let state = CallbackState {
            last_fired_on: Some("2026-07-04".to_string()),
            ..CallbackState::default()
        };
        assert!(decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").is_none());
    }

    #[test]
    fn decide_skips_cooled_memory_and_falls_back() {
        let mut fired = BTreeMap::new();
        fired.insert(fired_key("yori", "2026-06-04"), "2026-06-25".to_string());
        let memories = vec![
            memory("2026-06-04", "ひと月前だが最近発火済み。"),
            memory("2026-06-28", "新しい記憶。"),
        ];
        let state = CallbackState {
            last_fired_on: Some("2026-06-25".to_string()),
            fired,
            ..CallbackState::default()
        };
        // 節目候補は cooldown 中 → 久しぶり候補（直近の記憶）へ譲る。
        let shutdown = date_to_days("2026-06-30");
        let result = decide(
            &memories,
            &state,
            (2026, 7, 4),
            shutdown,
            Knob::Normal,
            "yori",
        )
        .expect("fires");
        assert_eq!(result.memory_date, "2026-06-28");
    }

    #[test]
    fn decide_month_anniversary_clamps_to_short_month_end() {
        // 3/31 のひと月前 → 非実在の 2/31 ではなく 2/28 にクランプして一致させる。
        let memories = vec![memory("2026-02-28", "二月末の記憶。")];
        let state = CallbackState::default();
        let result =
            decide(&memories, &state, (2026, 3, 31), None, Knob::Normal, "yori").expect("fires");
        assert_eq!(result.memory_date, "2026-02-28");
    }

    #[test]
    fn decide_january_rolls_over_to_previous_december() {
        let memories = vec![memory("2025-12-31", "大晦日の記憶。")];
        let state = CallbackState::default();
        let result =
            decide(&memories, &state, (2026, 1, 31), None, Knob::Normal, "yori").expect("fires");
        assert_eq!(result.memory_date, "2025-12-31");
        assert!(result.message.contains("ちょうどひと月前"));
    }

    #[test]
    fn decide_leap_day_year_anniversary_clamps() {
        // うるう日 2028-02-29 の一年前 → 2027-02-28 にクランプ。
        let memories = vec![memory("2027-02-28", "二月末の記憶。")];
        let state = CallbackState::default();
        let result =
            decide(&memories, &state, (2028, 2, 29), None, Knob::Normal, "yori").expect("fires");
        assert_eq!(result.memory_date, "2027-02-28");
        assert!(result.message.contains("ちょうど一年前"));
    }

    #[test]
    fn decide_no_shutdown_and_no_anniversary_is_silent() {
        let memories = vec![memory("2026-06-20", "節目でない記憶。")];
        let state = CallbackState::default();
        assert!(decide(&memories, &state, (2026, 7, 4), None, Knob::Normal, "yori").is_none());
    }

    #[test]
    fn decide_rare_widens_gates() {
        let memories = vec![memory("2026-06-28", "新しい記憶。")];
        let state = CallbackState::default();
        // gap 4 日は normal なら発火、rare（7 日）なら沈黙。
        let shutdown = date_to_days("2026-06-30");
        assert!(decide(
            &memories,
            &state,
            (2026, 7, 4),
            shutdown,
            Knob::Normal,
            "yori"
        )
        .is_some());
        assert!(decide(
            &memories,
            &state,
            (2026, 7, 4),
            shutdown,
            Knob::Rare,
            "yori"
        )
        .is_none());
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

    fn tmp_home(label: &str) -> std::path::PathBuf {
        let home = std::env::temp_dir().join(format!(
            "charminal-callback-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&home).expect("mkdir");
        home
    }

    #[test]
    fn evaluate_writes_and_cleans_pending() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("spawn");
        std::env::set_var("HOME", &home);

        // ひと月前の記憶を仕込む → 発火して pending が書かれる。
        super::super::append_memory("2026-06-04", "ひと月前の記憶。").expect("memory");
        evaluate_at((2026, 7, 4)).expect("spawn eval");
        let pending = home.join(".yorishiro/journal/callback-pending.txt");
        let content = std::fs::read_to_string(&pending).expect("pending exists");
        assert!(content.contains("2026-06-04"));

        // 状態ファイルには日付のみで本文が残らない。
        let state_text =
            std::fs::read_to_string(home.join(".yorishiro/journal/callback-state.json"))
                .expect("state");
        assert!(state_text.contains("2026-06-04"));
        assert!(!state_text.contains("ひと月前の記憶"));

        // 同日にもう一度 spawn → 全体 gate で沈黙し、未消費の pending は消える。
        evaluate_at((2026, 7, 4)).expect("spawn eval 2");
        assert!(!pending.exists());

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn evaluate_refunds_unconsumed_pending_cooldown() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("refund");
        std::env::set_var("HOME", &home);

        super::super::append_memory("2026-06-04", "ひと月前の記憶。").expect("memory");
        evaluate_at((2026, 7, 4)).expect("eval 1");
        let pending = home.join(".yorishiro/journal/callback-pending.txt");
        assert!(pending.exists());

        // pending が消費されないまま翌日 spawn → cooldown が返金され、
        // 同じ記憶が「久しぶり」等の候補にまた入れる状態に戻る。
        // （翌日は節目でないので発火はしないが、fired から消えていることを確認）
        evaluate_at((2026, 7, 5)).expect("eval 2");
        let state_text =
            std::fs::read_to_string(home.join(".yorishiro/journal/callback-state.json"))
                .expect("state");
        let state: serde_json::Value = serde_json::from_str(&state_text).expect("json");
        let key = fired_key(super::super::FALLBACK_PERSONA_ID_JA, "2026-06-04");
        assert!(
            state["fired"].get(key.as_str()).is_none(),
            "未消費 pending の記憶は fired から返金されるべき: {}",
            state_text
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn evaluate_keeps_cooldown_when_pending_was_consumed() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("consumed");
        std::env::set_var("HOME", &home);

        super::super::append_memory("2026-06-04", "ひと月前の記憶。").expect("memory");
        evaluate_at((2026, 7, 4)).expect("eval 1");
        let pending = home.join(".yorishiro/journal/callback-pending.txt");
        // hook script による消費をシミュレート。
        std::fs::remove_file(&pending).expect("consume");

        evaluate_at((2026, 7, 5)).expect("eval 2");
        let state_text =
            std::fs::read_to_string(home.join(".yorishiro/journal/callback-state.json"))
                .expect("state");
        let state: serde_json::Value = serde_json::from_str(&state_text).expect("json");
        let key = fired_key(super::super::FALLBACK_PERSONA_ID_JA, "2026-06-04");
        assert_eq!(
            state["fired"][key.as_str()],
            "2026-07-04",
            "消費済みなら cooldown は維持されるべき"
        );

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn evaluate_skips_agents_without_delivery_path() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("nodelivery");
        std::env::set_var("HOME", &home);

        // 届ける経路（UserPromptSubmit hook）を持たない agent の spawn では
        // 評価自体を skip する——pending も state も一切書かない。届かない発火で
        // last_fired_on を焼くと、同日にあとから起動した hook 持ち agent の分まで
        // global gate で潰してしまうため。
        super::super::append_memory("2026-06-04", "ひと月前の記憶。").expect("memory");
        evaluate_on_session_spawn(false).expect("eval without delivery");
        assert!(!home
            .join(".yorishiro/journal/callback-pending.txt")
            .exists());
        assert!(!home.join(".yorishiro/journal/callback-state.json").exists());

        // 同日に hook 持ち agent が spawn すれば通常どおり発火する。
        evaluate_at((2026, 7, 4)).expect("eval with delivery");
        assert!(home
            .join(".yorishiro/journal/callback-pending.txt")
            .exists());

        let _ = std::fs::remove_dir_all(&home);
    }

    #[test]
    fn local_today_returns_valid_date() {
        let (y, m, d) = local_today().expect("local date");
        assert!((2020..2200).contains(&y));
        assert!((1..=12).contains(&m));
        assert!((1..=31).contains(&d));
    }
}
