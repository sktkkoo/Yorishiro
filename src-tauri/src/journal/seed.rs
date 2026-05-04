//! Journal seed の初期化。
//!
//! 初回起動時に bundled の journal-seed ファイルを `~/.charminal/journal/` に
//! コピーする。前任者が残した日誌の断片として、user が初めて触れるコンテンツ。
//!
//! Philosophy: docs/philosophy/CHARMINAL.md

use std::path::Path;

use tauri::{AppHandle, Manager};

/// config.json から `journal_initialized` を読む。不在 / parse 失敗 → false。
fn is_journal_initialized(charminal_dir: &Path) -> bool {
    let config_path = charminal_dir.join("config.json");
    let Ok(text) = std::fs::read_to_string(&config_path) else {
        return false;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    parsed
        .get("journal_initialized")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

/// config.json に `journal_initialized: true` を書き込む。
/// 既存の config.json があればマージ、なければ新規作成。
fn mark_journal_initialized(charminal_dir: &Path) -> Result<(), String> {
    let config_path = charminal_dir.join("config.json");
    let mut config: serde_json::Value = if config_path.exists() {
        let text = std::fs::read_to_string(&config_path)
            .map_err(|e| format!("config.json 読み込み失敗: {}", e))?;
        serde_json::from_str(&text).map_err(|e| format!("config.json パース失敗: {}", e))?
    } else {
        serde_json::json!({})
    };

    config
        .as_object_mut()
        .ok_or_else(|| "config.json がオブジェクトではない".to_string())?
        .insert(
            "journal_initialized".to_string(),
            serde_json::Value::Bool(true),
        );

    let serialized = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("config.json シリアライズ失敗: {}", e))?;

    // atomic write: .tmp → rename
    let tmp_path = config_path.with_extension("json.tmp");
    std::fs::write(&tmp_path, &serialized)
        .map_err(|e| format!("config.json.tmp 書き込み失敗: {}", e))?;
    std::fs::rename(&tmp_path, &config_path)
        .map_err(|e| format!("config.json rename 失敗: {}", e))?;

    Ok(())
}

/// Bundled の journal-seed ファイルを一覧して destination にコピーする。
fn copy_seed_files(resource_dir: &Path, journal_dir: &Path) -> Result<(), String> {
    let seed_dir = resource_dir.join("resources").join("journal-seed");
    if !seed_dir.exists() {
        return Err(format!(
            "journal-seed リソースが見つからない: {}",
            seed_dir.display()
        ));
    }

    std::fs::create_dir_all(journal_dir)
        .map_err(|e| format!("~/.charminal/journal/ 作成失敗: {}", e))?;

    let entries =
        std::fs::read_dir(&seed_dir).map_err(|e| format!("journal-seed 読み取り失敗: {}", e))?;

    for entry in entries.flatten() {
        let src = entry.path();
        if !src.is_file() {
            continue;
        }
        let file_name = entry.file_name();
        let dest = journal_dir.join(&file_name);

        // 既に存在するファイルは上書きしない（user が編集した可能性）
        if dest.exists() {
            continue;
        }

        std::fs::copy(&src, &dest).map_err(|e| {
            format!(
                "seed ファイルコピー失敗: {} → {}: {}",
                src.display(),
                dest.display(),
                e
            )
        })?;
    }

    Ok(())
}

/// Journal seed を `~/.charminal/journal/` にコピーする（初回のみ）。
///
/// `config.json` の `journal_initialized` が true なら skip。コピー完了後に
/// `journal_initialized: true` を config.json に書き込む。
pub fn initialize_journal_seed(app_handle: &AppHandle) -> Result<(), String> {
    let home = std::env::var("HOME").map_err(|e| format!("HOME not set: {}", e))?;
    let charminal_dir = std::path::PathBuf::from(&home).join(".charminal");

    // 既に初期化済みなら何もしない
    if is_journal_initialized(&charminal_dir) {
        return Ok(());
    }

    // ~/.charminal/ 自体がなければ作る
    std::fs::create_dir_all(&charminal_dir)
        .map_err(|e| format!("~/.charminal/ 作成失敗: {}", e))?;

    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map_err(|e| format!("resource_dir 取得失敗: {}", e))?;

    let journal_dir = charminal_dir.join("journal").join("seed");

    copy_seed_files(&resource_dir, &journal_dir)?;
    mark_journal_initialized(&charminal_dir)?;

    eprintln!("[journal-seed] 初期化完了: {}", journal_dir.display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn fresh_dir(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-journal-seed-{}-{}-{}",
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
    fn is_journal_initialized_returns_false_when_no_config() {
        let dir = fresh_dir("no-config");
        assert!(!is_journal_initialized(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_journal_initialized_returns_false_when_field_missing() {
        let dir = fresh_dir("no-field");
        fs::write(dir.join("config.json"), r#"{"mcpPort": 18743}"#).expect("write");
        assert!(!is_journal_initialized(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn is_journal_initialized_returns_true_when_set() {
        let dir = fresh_dir("initialized");
        fs::write(dir.join("config.json"), r#"{"journal_initialized": true}"#).expect("write");
        assert!(is_journal_initialized(&dir));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mark_journal_initialized_creates_config_if_absent() {
        let dir = fresh_dir("mark-new");
        mark_journal_initialized(&dir).expect("mark ok");

        let text = fs::read_to_string(dir.join("config.json")).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("parse");
        assert_eq!(parsed["journal_initialized"], true);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn mark_journal_initialized_preserves_existing_fields() {
        let dir = fresh_dir("mark-existing");
        fs::write(dir.join("config.json"), r#"{"mcpPort": 12345}"#).expect("write");

        mark_journal_initialized(&dir).expect("mark ok");

        let text = fs::read_to_string(dir.join("config.json")).expect("read");
        let parsed: serde_json::Value = serde_json::from_str(&text).expect("parse");
        assert_eq!(parsed["mcpPort"], 12345);
        assert_eq!(parsed["journal_initialized"], true);

        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn copy_seed_files_copies_to_journal_dir() {
        let resource_root = fresh_dir("resources");
        let seed_dir = resource_root.join("resources").join("journal-seed");
        fs::create_dir_all(&seed_dir).expect("mkdir seed");
        fs::write(seed_dir.join("2025-11-03.md"), "テスト").expect("write seed");

        let journal_dir = fresh_dir("journal-dest");

        copy_seed_files(&resource_root, &journal_dir).expect("copy ok");

        let copied = fs::read_to_string(journal_dir.join("2025-11-03.md")).expect("read copied");
        assert_eq!(copied, "テスト");

        let _ = fs::remove_dir_all(&resource_root);
        let _ = fs::remove_dir_all(&journal_dir);
    }

    #[test]
    fn copy_seed_files_does_not_overwrite_existing() {
        let resource_root = fresh_dir("resources-no-overwrite");
        let seed_dir = resource_root.join("resources").join("journal-seed");
        fs::create_dir_all(&seed_dir).expect("mkdir seed");
        fs::write(seed_dir.join("2025-11-03.md"), "新しい内容").expect("write seed");

        let journal_dir = fresh_dir("journal-existing");
        fs::write(journal_dir.join("2025-11-03.md"), "既存の内容").expect("write existing");

        copy_seed_files(&resource_root, &journal_dir).expect("copy ok");

        let content = fs::read_to_string(journal_dir.join("2025-11-03.md")).expect("read");
        assert_eq!(content, "既存の内容");

        let _ = fs::remove_dir_all(&resource_root);
        let _ = fs::remove_dir_all(&journal_dir);
    }
}
