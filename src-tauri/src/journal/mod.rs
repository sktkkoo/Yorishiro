//! Journal ファイルシステム I/O。
//!
//! `~/.yorishiro/journal/` 配下の構造:
//! - `personas/<persona-id>/daily/` — persona ごとの日誌（MCP tool で書き込む）
//! - `personas/<persona-id>/memories.md` — persona ごとの記憶インデックス（system prompt に注入）
//!
//! MCP tool (`journal_write` / `journal_read`) から呼ばれる Rust 完結の実装。

pub mod callback;
pub mod cohabitation;

use std::path::PathBuf;

use serde::Serialize;

const FALLBACK_PERSONA_ID_JA: &str = "yori-ja";
const FALLBACK_PERSONA_ID_EN: &str = "yori-en";

/// journal エントリ 1 日分。
#[derive(Debug, Clone, Serialize)]
pub struct JournalEntry {
    pub date: String,
    pub content: String,
}

/// `~/.yorishiro/journal/` のパスを返す。
fn journal_root() -> Result<PathBuf, String> {
    Ok(crate::yorishiro_home_path()?.join("journal"))
}

fn active_persona_id() -> String {
    let Ok(home) = crate::yorishiro_home_path() else {
        return FALLBACK_PERSONA_ID_JA.to_string();
    };
    let path = home.join("config.json");
    let Ok(text) = std::fs::read_to_string(path) else {
        return FALLBACK_PERSONA_ID_JA.to_string();
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
        return FALLBACK_PERSONA_ID_JA.to_string();
    };
    if let Some(id) = value
        .get("primaryPersona")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
    {
        return id.to_string();
    }
    match value.get("language").and_then(|v| v.as_str()) {
        Some("en") => FALLBACK_PERSONA_ID_EN.to_string(),
        _ => FALLBACK_PERSONA_ID_JA.to_string(),
    }
}

/// config.json の language を読む（不在 / 壊れは None）。
fn config_language() -> Option<String> {
    let home = crate::yorishiro_home_path().ok()?;
    let text = std::fs::read_to_string(home.join("config.json")).ok()?;
    let value = serde_json::from_str::<serde_json::Value>(&text).ok()?;
    value
        .get("language")
        .and_then(|v| v.as_str())
        .map(String::from)
}

/// persona 交代（お別れ経路）で、去る側の memories.md にお別れの事実を
/// 機械的に一行残す。**config の primaryPersona 更新前に呼ぶこと**（active が
/// まだ去る側を指しているうちに書く）。
///
/// 住人の自筆ではないため、感情は書かず事実だけを記録する。戻ってきたとき
/// 既存の想起（recent / 久しぶりの起動）がこの行を拾い、「一度離れたこと」を
/// 覚えている状態になる。
pub fn record_farewell(to_persona_id: &str) -> Result<(), String> {
    let (y, m, d) = callback::local_today()?;
    let date = format!("{:04}-{:02}-{:02}", y, m, d);
    let line = match config_language().as_deref() {
        Some("en") => format!(
            "Handed this vessel over to \"{}\" and parted.",
            to_persona_id
        ),
        _ => format!("「{}」に器を譲って、お別れをした。", to_persona_id),
    };
    append_memory(&date, &line)
}

fn encode_persona_path_component(id: &str) -> String {
    let mut encoded = String::new();
    for b in id.bytes() {
        if b.is_ascii_alphanumeric() || b == b'-' || b == b'_' {
            encoded.push(char::from(b));
        } else {
            encoded.push_str(&format!("%{:02X}", b));
        }
    }
    if encoded.is_empty() {
        "_".to_string()
    } else {
        encoded
    }
}

fn persona_root(persona_id: &str) -> Result<PathBuf, String> {
    Ok(journal_root()?
        .join("personas")
        .join(encode_persona_path_component(persona_id)))
}

/// 住人の書き込み先 `~/.yorishiro/journal/personas/<persona>/daily/` を返す。
fn daily_dir() -> Result<PathBuf, String> {
    daily_dir_for_persona(&active_persona_id())
}

fn daily_dir_for_persona(persona_id: &str) -> Result<PathBuf, String> {
    Ok(persona_root(persona_id)?.join("daily"))
}

/// `memories.md` のパスを返す。
fn memories_path() -> Result<PathBuf, String> {
    memories_path_for_persona(&active_persona_id())
}

fn memories_path_for_persona(persona_id: &str) -> Result<PathBuf, String> {
    Ok(persona_root(persona_id)?.join("memories.md"))
}

/// `date` が `YYYY-MM-DD` 形式であることを検証する。
///
/// journal の `date` は MCP tool 引数（住人 AI が制御）としてファイル名・
/// `memories.md` の本文に組み込まれるため、`..` や `/` `\` を構造的に排除して
/// `~/.yorishiro/journal/` 外への path traversal を防ぐ。`read_recent` の
/// 走査側 filter（`len() == 10`）と同じ形式に揃える。
fn validate_journal_date(date: &str) -> Result<(), String> {
    let ok = date.len() == 10
        && date.as_bytes().iter().enumerate().all(|(i, &b)| match i {
            4 | 7 => b == b'-',
            _ => b.is_ascii_digit(),
        });
    if ok {
        Ok(())
    } else {
        Err(format!(
            "不正な日付形式です（YYYY-MM-DD のみ許可）: {}",
            date
        ))
    }
}

/// `memories.md` に一行追記する。印象に残ったことだけ選択的に記録される。
pub fn append_memory(date: &str, summary: &str) -> Result<(), String> {
    validate_journal_date(date)?;
    let path = memories_path()?;
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("journal ディレクトリの作成に失敗: {}", e))?;

    // 住人が summary の先頭に日付を含めてくると `2026-06-27: 2026-06-27: ...` と
    // 二重になるため、先頭の `{date}:` は剥がしてから前置する。
    let summary = summary
        .trim_start()
        .strip_prefix(&format!("{}:", date))
        .map(str::trim_start)
        .unwrap_or(summary);
    let line = format!("{}: {}\n", date, summary);

    let mut content = if path.exists() {
        let existing = std::fs::read_to_string(&path)
            .map_err(|e| format!("memories.md の読み取りに失敗: {}", e))?;
        let mut s = existing;
        if !s.ends_with('\n') && !s.is_empty() {
            s.push('\n');
        }
        s
    } else {
        String::new()
    };

    content.push_str(&line);
    std::fs::write(&path, &content).map_err(|e| format!("memories.md の書き込みに失敗: {}", e))?;

    Ok(())
}

/// `memories.md` の全文を読み取る。ファイルが無ければ空文字列。
pub fn read_memories() -> Result<String, String> {
    let path = memories_path()?;
    if !path.exists() {
        return Ok(String::new());
    }
    std::fs::read_to_string(&path).map_err(|e| format!("memories.md の読み取りに失敗: {}", e))
}

/// journal エントリを書き込む。`daily/{date}.md` に出力。既存ファイルには空行を挟んで追記する。
pub fn write_entry(date: &str, content: &str) -> Result<(), String> {
    validate_journal_date(date)?;
    let dir = daily_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("journal ディレクトリの作成に失敗: {}", e))?;

    let path = dir.join(format!("{}.md", date));

    if path.exists() {
        let existing = std::fs::read_to_string(&path)
            .map_err(|e| format!("既存 journal の読み取りに失敗: {}", e))?;
        let mut merged = existing;
        if !merged.ends_with('\n') {
            merged.push('\n');
        }
        merged.push('\n');
        merged.push_str(content);
        if !merged.ends_with('\n') {
            merged.push('\n');
        }
        std::fs::write(&path, merged).map_err(|e| format!("journal の書き込みに失敗: {}", e))?;
    } else {
        let mut body = content.to_string();
        if !body.ends_with('\n') {
            body.push('\n');
        }
        std::fs::write(&path, body).map_err(|e| format!("journal の書き込みに失敗: {}", e))?;
    }

    Ok(())
}

/// 指定日付の journal を読み取る。ファイルが無ければ `None`。
pub fn read_entry(date: &str) -> Result<Option<String>, String> {
    validate_journal_date(date)?;
    let path = daily_dir()?.join(format!("{}.md", date));
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path)
        .map(Some)
        .map_err(|e| format!("journal の読み取りに失敗: {}", e))
}

/// 最新 N 日分の journal を読み取る（日付降順）。
pub fn read_recent(days: usize) -> Result<Vec<JournalEntry>, String> {
    let dir = daily_dir()?;
    if !dir.exists() {
        return Ok(Vec::new());
    }

    let read_dir = std::fs::read_dir(&dir)
        .map_err(|e| format!("journal ディレクトリの読み取りに失敗: {}", e))?;

    let mut entries = Vec::new();

    for entry in read_dir.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Some(date) = file_name.strip_suffix(".md") else {
            continue;
        };
        if date.len() != 10 {
            continue;
        }
        let content = std::fs::read_to_string(entry.path())
            .map_err(|e| format!("journal の読み取りに失敗: {}", e))?;
        entries.push(JournalEntry {
            date: date.to_string(),
            content,
        });
    }

    entries.sort_by(|a, b| b.date.cmp(&a.date));
    entries.truncate(days);

    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_home(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "yorishiro-journal-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).expect("mkdir");
        tmp
    }

    fn persona_daily_path(home: &std::path::Path, persona_id: &str, date: &str) -> PathBuf {
        home.join(".yorishiro/journal/personas")
            .join(encode_persona_path_component(persona_id))
            .join("daily")
            .join(format!("{}.md", date))
    }

    #[test]
    fn write_creates_new_entry() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("write-new");
        std::env::set_var("HOME", &home);

        write_entry("2026-05-04", "今日は静かな一日だった。").expect("write ok");

        let path = persona_daily_path(&home, FALLBACK_PERSONA_ID_JA, "2026-05-04");
        assert!(path.exists());
        let content = fs::read_to_string(&path).expect("read");
        assert!(content.contains("今日は静かな一日だった。"));
        assert!(content.ends_with('\n'));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_appends_to_existing_entry() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("write-append");
        std::env::set_var("HOME", &home);

        write_entry("2026-05-04", "朝の記録。").expect("write 1");
        write_entry("2026-05-04", "夜の記録。").expect("write 2");

        let path = persona_daily_path(&home, FALLBACK_PERSONA_ID_JA, "2026-05-04");
        let content = fs::read_to_string(&path).expect("read");
        assert!(content.contains("朝の記録。"));
        assert!(content.contains("夜の記録。"));
        assert!(content.contains("\n\n"));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn read_entry_returns_none_when_missing() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("read-missing");
        std::env::set_var("HOME", &home);

        let result = read_entry("2026-01-01").expect("read ok");
        assert!(result.is_none());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn read_entry_returns_content_when_present() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("read-present");
        std::env::set_var("HOME", &home);

        write_entry("2026-05-04", "テスト内容。").expect("write");
        let result = read_entry("2026-05-04").expect("read ok");
        assert!(result.is_some());
        assert!(result.unwrap().contains("テスト内容。"));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn read_recent_returns_entries_in_descending_order() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("read-recent");
        std::env::set_var("HOME", &home);

        write_entry("2026-05-01", "1日目。").expect("write");
        write_entry("2026-05-03", "3日目。").expect("write");
        write_entry("2026-05-02", "2日目。").expect("write");

        let entries = read_recent(2).expect("read recent ok");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].date, "2026-05-03");
        assert_eq!(entries[1].date, "2026-05-02");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn read_recent_returns_empty_when_no_journal_dir() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("read-recent-empty");
        std::env::set_var("HOME", &home);

        let entries = read_recent(7).expect("read recent ok");
        assert!(entries.is_empty());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_entry_rejects_path_traversal() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("write-traversal");
        std::env::set_var("HOME", &home);

        // `date` に traversal を含めても scope 外に書けてはならない。
        let result = write_entry("../../../../evil", "悪意のある内容");
        assert!(result.is_err(), "traversal を含む date は拒否されるべき");

        // daily ディレクトリにファイルが 1 つも作られていないこと。
        let daily = home
            .join(".yorishiro/journal/personas")
            .join(FALLBACK_PERSONA_ID_JA)
            .join("daily");
        let count = fs::read_dir(&daily).map(|d| d.count()).unwrap_or(0);
        assert_eq!(count, 0, "traversal 時にファイルが作られてはならない");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn read_entry_rejects_path_traversal() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("read-traversal");
        std::env::set_var("HOME", &home);

        let result = read_entry("../../../../../etc/passwd");
        assert!(result.is_err(), "traversal を含む date は拒否されるべき");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn append_memory_strips_duplicated_date_prefix() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("memory-dup-date");
        std::env::set_var("HOME", &home);

        append_memory("2026-06-27", "2026-06-27: 花火を見た日。").expect("append ok");
        append_memory("2026-06-28", "普通の一行。").expect("append ok");

        let content = fs::read_to_string(
            home.join(".yorishiro/journal/personas")
                .join(FALLBACK_PERSONA_ID_JA)
                .join("memories.md"),
        )
        .expect("read");
        assert!(content.contains("2026-06-27: 花火を見た日。"));
        assert!(!content.contains("2026-06-27: 2026-06-27:"));
        assert!(content.contains("2026-06-28: 普通の一行。"));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn append_memory_rejects_invalid_date() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("memory-invalid-date");
        std::env::set_var("HOME", &home);

        // memories.md に注入される date は形式を強制する。
        let result = append_memory("../../evil", "勝手な行");
        assert!(result.is_err(), "不正な date は拒否されるべき");

        let memories = home
            .join(".yorishiro/journal/personas")
            .join(FALLBACK_PERSONA_ID_JA)
            .join("memories.md");
        assert!(
            !memories.exists(),
            "拒否された append で memories.md が作られてはならない"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_entry_accepts_valid_date() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("write-valid-date");
        std::env::set_var("HOME", &home);

        // 正規の YYYY-MM-DD は通ること（validation が正常系を壊さない回帰防止）。
        write_entry("2026-06-10", "正常な記録。").expect("valid date は通るべき");
        assert!(persona_daily_path(&home, FALLBACK_PERSONA_ID_JA, "2026-06-10").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_entry_uses_configured_primary_persona() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("write-primary-persona");
        std::env::set_var("HOME", &home);
        let config_dir = home.join(".yorishiro");
        fs::create_dir_all(&config_dir).expect("mkdir config dir");
        fs::write(
            config_dir.join("config.json"),
            r#"{"primaryPersona":"my.persona/unsafe"}"#,
        )
        .expect("write config");

        write_entry("2026-06-10", "persona 固有の記録。").expect("write");
        assert!(home
            .join(".yorishiro/journal/personas/my%2Epersona%2Funsafe/daily/2026-06-10.md")
            .exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_entry_uses_english_fallback_persona_when_language_is_en() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("write-language-en");
        std::env::set_var("HOME", &home);
        let config_dir = home.join(".yorishiro");
        fs::create_dir_all(&config_dir).expect("mkdir config dir");
        fs::write(config_dir.join("config.json"), r#"{"language":"en"}"#).expect("write config");

        write_entry("2026-06-10", "English fallback record.").expect("write");
        assert!(persona_daily_path(&home, FALLBACK_PERSONA_ID_EN, "2026-06-10").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn record_farewell_writes_fact_line_to_departing_persona() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("record-farewell");
        std::env::set_var("HOME", &home);
        let config_dir = home.join(".yorishiro");
        fs::create_dir_all(&config_dir).expect("mkdir config dir");
        fs::write(
            config_dir.join("config.json"),
            r#"{"primaryPersona":"old-resident"}"#,
        )
        .expect("write config");

        record_farewell("new-resident").expect("record");

        let memories =
            fs::read_to_string(home.join(".yorishiro/journal/personas/old-resident/memories.md"))
                .expect("departing persona memories exists");
        assert!(
            memories.contains("「new-resident」に器を譲って、お別れをした。"),
            "{memories}"
        );
        // 行頭は YYYY-MM-DD: の日付前置（想起の突き合わせ対象になる）。
        let line = memories.lines().last().expect("line");
        assert_eq!(&line[4..5], "-");
        assert_eq!(&line[7..8], "-");
        assert_eq!(&line[10..12], ": ");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn record_farewell_uses_english_line_when_language_is_en() {
        let _guard = crate::TEST_HOME_ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("record-farewell-en");
        std::env::set_var("HOME", &home);
        let config_dir = home.join(".yorishiro");
        fs::create_dir_all(&config_dir).expect("mkdir config dir");
        fs::write(
            config_dir.join("config.json"),
            r#"{"primaryPersona":"old-resident","language":"en"}"#,
        )
        .expect("write config");

        record_farewell("new-resident").expect("record");

        let memories =
            fs::read_to_string(home.join(".yorishiro/journal/personas/old-resident/memories.md"))
                .expect("departing persona memories exists");
        assert!(
            memories.contains("Handed this vessel over to \"new-resident\" and parted."),
            "{memories}"
        );

        let _ = fs::remove_dir_all(&home);
    }
}
