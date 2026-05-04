//! Journal ファイルシステム I/O。
//!
//! `~/.charminal/journal/` 配下の構造:
//! - `daily/` — 住人の日誌（MCP tool で書き込む）
//! - `memories.md` — 印象に残ったことのインデックス（system prompt に注入）
//!
//! MCP tool (`journal_write` / `journal_read`) から呼ばれる Rust 完結の実装。

pub mod cohabitation;

use std::path::PathBuf;

use serde::Serialize;

/// journal エントリ 1 日分。
#[derive(Debug, Clone, Serialize)]
pub struct JournalEntry {
    pub date: String,
    pub content: String,
}

/// `~/.charminal/journal/` のパスを返す。
fn journal_root() -> Result<PathBuf, String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    Ok(PathBuf::from(home).join(".charminal").join("journal"))
}

/// 住人の書き込み先 `~/.charminal/journal/daily/` を返す。
fn daily_dir() -> Result<PathBuf, String> {
    Ok(journal_root()?.join("daily"))
}

/// `memories.md` のパスを返す。
fn memories_path() -> Result<PathBuf, String> {
    Ok(journal_root()?.join("memories.md"))
}

/// `memories.md` に一行追記する。印象に残ったことだけ選択的に記録される。
pub fn append_memory(date: &str, summary: &str) -> Result<(), String> {
    let path = memories_path()?;
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|e| format!("journal ディレクトリの作成に失敗: {}", e))?;

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
    use std::sync::Mutex;

    static ENV_LOCK: Mutex<()> = Mutex::new(());

    fn tmp_home(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-journal-{}-{}-{}",
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

    #[test]
    fn write_creates_new_entry() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("write-new");
        std::env::set_var("HOME", &home);

        write_entry("2026-05-04", "今日は静かな一日だった。").expect("write ok");

        let path = home.join(".charminal/journal/daily/2026-05-04.md");
        assert!(path.exists());
        let content = fs::read_to_string(&path).expect("read");
        assert!(content.contains("今日は静かな一日だった。"));
        assert!(content.ends_with('\n'));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn write_appends_to_existing_entry() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("write-append");
        std::env::set_var("HOME", &home);

        write_entry("2026-05-04", "朝の記録。").expect("write 1");
        write_entry("2026-05-04", "夜の記録。").expect("write 2");

        let path = home.join(".charminal/journal/daily/2026-05-04.md");
        let content = fs::read_to_string(&path).expect("read");
        assert!(content.contains("朝の記録。"));
        assert!(content.contains("夜の記録。"));
        assert!(content.contains("\n\n"));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn read_entry_returns_none_when_missing() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("read-missing");
        std::env::set_var("HOME", &home);

        let result = read_entry("2026-01-01").expect("read ok");
        assert!(result.is_none());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn read_entry_returns_content_when_present() {
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
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
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let home = tmp_home("read-recent-empty");
        std::env::set_var("HOME", &home);

        let entries = read_recent(7).expect("read recent ok");
        assert!(entries.is_empty());

        let _ = fs::remove_dir_all(&home);
    }
}
