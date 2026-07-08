//! 同棲時間（cohabitation hours）の追跡。
//!
//! アプリ起動時に開始時刻を記録し、終了時に累計時間を cohabitation.json に書き出す。
//! persona ごとの累計と全体の累計を保持する。
//!
//! cohabitation.json の構造:
//! ```json
//! {
//!   "total_hours": 42.5,
//!   "last_shutdown": "2026-05-04T12:34:56Z",
//!   "per_persona": {
//!     "clai": 40.0,
//!     "other": 2.5
//!   }
//! }
//! ```

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;
use std::time::Instant;

const COHABITATION_FILE: &str = "cohabitation.json";

#[derive(Debug, Default, Serialize, Deserialize)]
struct CohabitationState {
    #[serde(default)]
    total_hours: f64,
    #[serde(default)]
    last_shutdown: Option<String>,
    #[serde(default)]
    per_persona: BTreeMap<String, f64>,
}

/// 起動時に呼ぶ。開始時刻を記録して返す。
pub fn start_tracking() -> Instant {
    Instant::now()
}

fn read_cohabitation(path: &Path) -> Result<CohabitationState, String> {
    if !path.exists() {
        return Ok(CohabitationState::default());
    }
    let text = std::fs::read_to_string(path)
        .map_err(|e| format!("{} 読み込み失敗: {}", COHABITATION_FILE, e))?;
    serde_json::from_str(&text).map_err(|e| format!("{} パース失敗: {}", COHABITATION_FILE, e))
}

fn write_cohabitation_atomic(path: &Path, state: &CohabitationState) -> Result<(), String> {
    let serialized = serde_json::to_string_pretty(state)
        .map_err(|e| format!("{} シリアライズ失敗: {}", COHABITATION_FILE, e))?;
    let tmp_path = path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &serialized)
        .map_err(|e| format!("{}.tmp 書き込み失敗: {}", COHABITATION_FILE, e))?;
    std::fs::rename(&tmp_path, path)
        .map_err(|e| format!("{} rename 失敗: {}", COHABITATION_FILE, e))
}

/// 終了時に呼ぶ。経過時間を cohabitation.json に書き出す。
///
/// - `total_hours` に経過時間を加算
/// - `per_persona[active_persona_id]` に経過時間を加算
/// - `last_shutdown` に現在の ISO 8601 タイムスタンプを記録
pub fn save_hours(start: Instant, active_persona_id: &str) -> Result<(), String> {
    let yorishiro_dir = crate::yorishiro_home_path()?;
    save_hours_impl(start, active_persona_id, &yorishiro_dir)
}

/// テスト用に yorishiro_dir を引数化した実装本体。
fn save_hours_impl(
    start: Instant,
    active_persona_id: &str,
    yorishiro_dir: &Path,
) -> Result<(), String> {
    let elapsed_hours = start.elapsed().as_secs_f64() / 3600.0;
    std::fs::create_dir_all(yorishiro_dir).map_err(|e| format!("~/.yorishiro/ 作成失敗: {}", e))?;

    let cohabitation_path = yorishiro_dir.join(COHABITATION_FILE);
    let mut state = read_cohabitation(&cohabitation_path)?;

    let current_total = state.total_hours;
    state.total_hours += elapsed_hours;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| format!("SystemTime エラー: {}", e))?;
    state.last_shutdown = Some(format_iso8601_utc(now.as_secs()));

    let current_persona_hours = state
        .per_persona
        .get(active_persona_id)
        .copied()
        .unwrap_or_default();
    state.per_persona.insert(
        active_persona_id.to_string(),
        current_persona_hours + elapsed_hours,
    );

    write_cohabitation_atomic(&cohabitation_path, &state)?;

    eprintln!(
        "[cohabitation] 保存完了: +{:.4}h (total: {:.2}h, persona '{}': {:.2}h)",
        elapsed_hours,
        current_total + elapsed_hours,
        active_persona_id,
        current_persona_hours + elapsed_hours
    );

    Ok(())
}

/// Unix timestamp（秒）を簡易 ISO 8601 UTC 文字列に変換する。
/// chrono に依存しないよう手動計算する。
fn format_iso8601_utc(epoch_secs: u64) -> String {
    // 簡易実装: days since epoch → year/month/day を計算
    let secs_in_day: u64 = 86400;
    let time_secs = epoch_secs % secs_in_day;
    let days = epoch_secs / secs_in_day;

    let hours = time_secs / 3600;
    let time_rem = time_secs % 3600;
    let minutes = time_rem / 60;
    let seconds = time_rem % 60;

    // Civil date from days since 1970-01-01 (算法は Howard Hinnant のアルゴリズム)
    let (year, month, day) = civil_from_days(days as i64);

    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hours, minutes, seconds
    )
}

/// Howard Hinnant の civil_from_days アルゴリズム。
/// days は 1970-01-01 からの経過日数。
pub(crate) fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fresh_dir(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "yorishiro-cohabitation-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("create tmp dir");
        tmp
    }

    #[test]
    fn format_iso8601_utc_known_date() {
        // 2026-05-04T00:00:00Z = 1777680000 (approx)
        // 2024-01-01T00:00:00Z = 1704067200
        let result = format_iso8601_utc(1704067200);
        assert_eq!(result, "2024-01-01T00:00:00Z");
    }

    #[test]
    fn default_state_has_expected_shape() {
        let c = CohabitationState::default();
        assert_eq!(c.total_hours, 0.0);
        assert!(c.last_shutdown.is_none());
        assert!(c.per_persona.is_empty());
    }

    #[test]
    fn save_hours_creates_cohabitation_file_without_config() {
        let dir = fresh_dir("save-new");
        let start = Instant::now();
        // 即座に save するので経過時間はほぼ 0
        save_hours_impl(start, "clai", &dir).expect("save ok");

        assert!(!dir.join("config.json").exists());
        let text = fs::read_to_string(dir.join(COHABITATION_FILE)).expect("read");
        let parsed: CohabitationState = serde_json::from_str(&text).expect("parse");

        assert!(parsed.total_hours >= 0.0);
        assert!(parsed.last_shutdown.is_some());
        assert!(parsed.per_persona["clai"] >= 0.0);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_hours_accumulates_on_existing_cohabitation_file() {
        let dir = fresh_dir("save-accumulate");
        fs::write(
            dir.join(COHABITATION_FILE),
            r#"{
              "total_hours": 10.0,
              "last_shutdown": "2026-05-01T00:00:00Z",
              "per_persona": {
                "clai": 8.0
              }
            }"#,
        )
        .expect("write");

        let start = Instant::now();
        save_hours_impl(start, "clai", &dir).expect("save ok");

        let text = fs::read_to_string(dir.join(COHABITATION_FILE)).expect("read");
        let cohabitation: CohabitationState = serde_json::from_str(&text).expect("parse");

        // total_hours は 10.0 以上（加算されているはず）
        assert!(cohabitation.total_hours >= 10.0);
        // per_persona.clai は 8.0 以上
        assert!(cohabitation.per_persona["clai"] >= 8.0);
        assert!(!dir.join("config.json").exists());

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_hours_adds_new_persona() {
        let dir = fresh_dir("save-new-persona");
        fs::write(
            dir.join(COHABITATION_FILE),
            r#"{
              "total_hours": 5.0,
              "last_shutdown": null,
              "per_persona": {
                "clai": 5.0
              }
            }"#,
        )
        .expect("write");

        let start = Instant::now();
        save_hours_impl(start, "other-persona", &dir).expect("save ok");

        let text = fs::read_to_string(dir.join(COHABITATION_FILE)).expect("read");
        let parsed: CohabitationState = serde_json::from_str(&text).expect("parse");

        // 新しい persona が追加される
        assert!(parsed.per_persona.contains_key("other-persona"));
        // 既存 persona は保持される
        assert_eq!(parsed.per_persona["clai"], 5.0);

        let _ = fs::remove_dir_all(&dir);
    }
}
