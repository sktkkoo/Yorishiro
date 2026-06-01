//! ~/.charminal/.history/ の full-copy snapshot store（MVP / spec §0）。
//! known-good 自動判定・content-addressed は P4。ここは素朴な timeline undo。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const HISTORY_DIRNAME: &str = ".history";
const INDEX_FILE: &str = "index.json";
const GENERATIONS_DIR: &str = "generations";

/// snapshot に含める ~/.charminal 相対パス。
const SNAPSHOT_INCLUDES: &[&str] = &["packs", "config.json", "init.js"];

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct SnapshotEntry {
    pub seq: u64,
    pub ts_ms: u64,
    pub trigger: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub(crate) struct HistoryIndex {
    pub version: u32,
    pub snapshots: Vec<SnapshotEntry>,
}

impl Default for HistoryIndex {
    fn default() -> Self {
        HistoryIndex {
            version: 1,
            snapshots: Vec::new(),
        }
    }
}

fn charminal_dir(home_root: &Path) -> PathBuf {
    home_root.join(".charminal")
}

fn history_root(home_root: &Path) -> PathBuf {
    charminal_dir(home_root).join(HISTORY_DIRNAME)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn read_index(home_root: &Path) -> Result<HistoryIndex, String> {
    let path = history_root(home_root).join(INDEX_FILE);
    match std::fs::read_to_string(&path) {
        Ok(s) => serde_json::from_str(&s).map_err(|e| format!("index.json parse error: {}", e)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(HistoryIndex::default()),
        Err(e) => Err(format!("index.json read error: {}", e)),
    }
}

pub(crate) fn write_index(home_root: &Path, index: &HistoryIndex) -> Result<(), String> {
    let root = history_root(home_root);
    std::fs::create_dir_all(&root).map_err(|e| format!("mkdir .history: {}", e))?;
    let path = root.join(INDEX_FILE);
    let tmp = root.join(format!("{}.tmp", INDEX_FILE));
    let body =
        serde_json::to_string_pretty(index).map_err(|e| format!("index serialize: {}", e))?;
    std::fs::write(&tmp, body).map_err(|e| format!("write tmp index: {}", e))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename index: {}", e))?;
    Ok(())
}

pub(crate) fn next_seq(index: &HistoryIndex) -> u64 {
    index.snapshots.iter().map(|s| s.seq).max().unwrap_or(0) + 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn tmp_home(label: &str) -> PathBuf {
        let tmp = std::env::temp_dir().join(format!(
            "charminal-history-{}-{}-{}",
            label,
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join(".charminal")).expect("mkdir charminal");
        tmp
    }

    #[test]
    fn index_roundtrips_empty_then_appended() {
        let home = tmp_home("index-roundtrip");

        // 最初は空 index。
        let idx = read_index(&home).expect("read empty");
        assert_eq!(idx.snapshots.len(), 0);
        assert_eq!(next_seq(&idx), 1);

        // 1 件 append して書く。
        let mut idx = idx;
        idx.snapshots.push(SnapshotEntry {
            seq: 1,
            ts_ms: 123,
            trigger: "manual".into(),
            label: None,
        });
        write_index(&home, &idx).expect("write");

        // 読み直して一致。
        let reread = read_index(&home).expect("reread");
        assert_eq!(reread.snapshots.len(), 1);
        assert_eq!(reread.snapshots[0].seq, 1);
        assert_eq!(next_seq(&reread), 2);

        let _ = fs::remove_dir_all(&home);
    }
}
