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

fn gen_dirname(seq: u64) -> String {
    format!("{:06}", seq)
}

/// dir を再帰コピー（per-file）。walkdir 不使用。
fn copy_dir_all(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {}", dst.display(), e))?;
    for entry in std::fs::read_dir(src).map_err(|e| format!("read_dir {}: {}", src.display(), e))? {
        let entry = entry.map_err(|e| format!("dir entry: {}", e))?;
        let ty = entry.file_type().map_err(|e| format!("file_type: {}", e))?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("copy {}: {}", from.display(), e))?;
        }
    }
    Ok(())
}

/// live ~/.charminal の SNAPSHOT_INCLUDES を generations/<seq>/ に full copy し、index に追記。
pub(crate) fn snapshot_create_impl(
    home_root: &Path,
    trigger: &str,
    label: Option<&str>,
) -> Result<u64, String> {
    let charminal = charminal_dir(home_root);
    let mut index = read_index(home_root)?;
    let seq = next_seq(&index);

    // partial generation を残さない：<seq>.tmp にコピーし、成功後だけ可視化する。
    let gens_root = history_root(home_root).join(GENERATIONS_DIR);
    let final_dir = gens_root.join(gen_dirname(seq));
    let tmp_dir = gens_root.join(format!("{}.tmp", gen_dirname(seq)));
    let _ = std::fs::remove_dir_all(&tmp_dir);
    std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("mkdir gen tmp: {}", e))?;

    let copy_result: Result<(), String> = (|| {
        for rel in SNAPSHOT_INCLUDES {
            let src = charminal.join(rel);
            if !src.exists() {
                continue;
            }
            let dst = tmp_dir.join(rel);
            if src.is_dir() {
                copy_dir_all(&src, &dst)?;
            } else {
                if let Some(parent) = dst.parent() {
                    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {}", e))?;
                }
                std::fs::copy(&src, &dst).map_err(|e| format!("copy {}: {}", src.display(), e))?;
            }
        }
        Ok(())
    })();
    if let Err(e) = copy_result {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return Err(e);
    }

    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&tmp_dir, &final_dir).map_err(|e| format!("rename gen: {}", e))?;

    index.snapshots.push(SnapshotEntry {
        seq,
        ts_ms: now_ms(),
        trigger: trigger.to_string(),
        label: label.map(|s| s.to_string()),
    });
    write_index(home_root, &index)?;
    Ok(seq)
}

pub(crate) fn snapshot_list_impl(home_root: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let mut snaps = read_index(home_root)?.snapshots;
    snaps.sort_by(|a, b| b.seq.cmp(&a.seq));
    Ok(snaps)
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

    #[test]
    fn snapshot_create_copies_scope_and_excludes_journal() {
        let home = tmp_home("snap-create");
        let charminal = home.join(".charminal");
        // live tree を用意する。
        fs::create_dir_all(charminal.join("packs/foo")).unwrap();
        fs::write(charminal.join("packs/foo/effect.js"), "export default {}").unwrap();
        fs::write(charminal.join("config.json"), "{\"activeScene\":null}").unwrap();
        fs::write(charminal.join("init.js"), "// init").unwrap();
        // 対象外。
        fs::create_dir_all(charminal.join("journal/daily")).unwrap();
        fs::write(charminal.join("journal/daily/2026-06-02.md"), "secret").unwrap();
        fs::write(charminal.join("last-startup.json"), "[]").unwrap();

        let seq = snapshot_create_impl(&home, "manual", None).expect("snapshot");
        assert_eq!(seq, 1);

        let generation = charminal.join(".history/generations/000001");
        assert!(generation.join("packs/foo/effect.js").exists());
        assert!(generation.join("config.json").exists());
        assert!(generation.join("init.js").exists());
        // 対象外は含まれない。
        assert!(!generation.join("journal").exists());
        assert!(!generation.join("last-startup.json").exists());
        // index に 1 件。
        let idx = read_index(&home).unwrap();
        assert_eq!(idx.snapshots.len(), 1);
        assert_eq!(idx.snapshots[0].trigger, "manual");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn snapshot_list_returns_desc_by_seq() {
        let home = tmp_home("snap-list");
        let charminal = home.join(".charminal");
        fs::write(charminal.join("config.json"), "{}").unwrap();

        snapshot_create_impl(&home, "a", None).unwrap();
        snapshot_create_impl(&home, "b", Some("labelled")).unwrap();

        let list = snapshot_list_impl(&home).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].seq, 2);
        assert_eq!(list[0].label.as_deref(), Some("labelled"));
        assert_eq!(list[1].seq, 1);

        let _ = fs::remove_dir_all(&home);
    }
}
