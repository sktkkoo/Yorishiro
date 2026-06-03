//! ~/.charminal/.history/ の full-copy snapshot store（MVP / spec §0）。
//! known-good 自動判定・content-addressed は P4。ここは素朴な timeline undo。

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::path::Component;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const HISTORY_DIRNAME: &str = ".history";
const INDEX_FILE: &str = "index.json";
const GENERATIONS_DIR: &str = "generations";

/// snapshot に含める ~/.charminal 相対パス。
const SNAPSHOT_INCLUDES: &[&str] = &["packs", "config.json", "init.js"];

/// prune で残す世代の既定件数。watcher-settled / baseline の自動 snapshot 後に
/// この件数まで間引いて履歴の単調増加を防ぐ（spec §0「prune は直近 N 件だけ残す」）。
pub(crate) const DEFAULT_KEEP: usize = 50;

/// snapshot_create / snapshot_prune の read-modify-write（index.json の更新）を
/// プロセス内で直列化する lock。watcher / baseline / Tauri command が並走しても
/// 同一 seq を採番しないようにする（Finding #2）。Charminal は単一プロセスなので
/// file-lock までは不要。
static SNAPSHOT_LOCK: Mutex<()> = Mutex::new(());

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct SnapshotEntry {
    pub seq: u64,
    pub ts_ms: u64,
    pub trigger: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    /// 直前 startup が clean だったかの advisory ラベル（spec §0）。startup-baseline
    /// にだけ付く。古い index.json は field 不在なので default で None。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub startup_clean: Option<bool>,
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

/// generations/ 配下の実在 dir 名（`000001` 形式）から最大 seq を返す。
/// index.json と乖離していても（partial write / 手動削除）既存世代を上書きしない
/// ための belt-and-suspenders。`<seq>.tmp` のような非数値名は parse 失敗で無視。
fn max_existing_gen_seq(home_root: &Path) -> u64 {
    let gens_root = history_root(home_root).join(GENERATIONS_DIR);
    let Ok(entries) = std::fs::read_dir(&gens_root) else {
        return 0;
    };
    let mut max = 0u64;
    for entry in entries.flatten() {
        if let Some(seq) = entry
            .file_name()
            .to_str()
            .and_then(|n| n.parse::<u64>().ok())
        {
            max = max.max(seq);
        }
    }
    max
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
    // index の read-modify-write を直列化（Finding #2）。poison しても続行する。
    let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let charminal = charminal_dir(home_root);
    let mut index = read_index(home_root)?;
    // index と generations/ の実在 dir 両方から採番し、どちらとも衝突しない seq を採る。
    let seq = next_seq(&index).max(max_existing_gen_seq(home_root) + 1);

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
        startup_clean: None,
    });
    write_index(home_root, &index)?;
    Ok(seq)
}

pub(crate) fn snapshot_list_impl(home_root: &Path) -> Result<Vec<SnapshotEntry>, String> {
    let mut snaps = read_index(home_root)?.snapshots;
    snaps.sort_by(|a, b| b.seq.cmp(&a.seq));
    Ok(snaps)
}

fn remove_path(p: &Path) -> Result<(), String> {
    match std::fs::symlink_metadata(p) {
        Ok(meta) if meta.file_type().is_dir() && !meta.file_type().is_symlink() => {
            std::fs::remove_dir_all(p).map_err(|e| format!("rmdir {}: {}", p.display(), e))
        }
        Ok(_) => std::fs::remove_file(p).map_err(|e| format!("rm {}: {}", p.display(), e)),
        Err(ref e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("metadata {}: {}", p.display(), e)),
    }
}

fn path_is_file_like(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|meta| !meta.file_type().is_dir() || meta.file_type().is_symlink())
        .unwrap_or(false)
}

fn path_is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|meta| meta.file_type().is_dir() && !meta.file_type().is_symlink())
        .unwrap_or(false)
}

/// 単一ファイルを atomic（同一 dir の .tmp→rename）で配置する。
fn atomic_copy_file(src: &Path, dst: &Path) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir parent: {}", e))?;
    }
    let file_name = dst
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("restore");
    let tmp = dst.with_file_name(format!(".{}.resttmp", file_name));
    let _ = remove_path(&tmp);
    std::fs::copy(src, &tmp).map_err(|e| format!("copy {}: {}", src.display(), e))?;
    if let Err(e) = std::fs::rename(&tmp, dst) {
        let _ = remove_path(&tmp);
        return Err(format!("rename {}: {}", dst.display(), e));
    }
    Ok(())
}

/// src 配下の全相対 file path を収集する。
fn collect_rel_files(base: &Path, cur: &Path, out: &mut BTreeSet<PathBuf>) -> Result<(), String> {
    for entry in std::fs::read_dir(cur).map_err(|e| format!("read_dir {}: {}", cur.display(), e))? {
        let entry = entry.map_err(|e| format!("entry: {}", e))?;
        let path = entry.path();
        let ty = entry.file_type().map_err(|e| format!("file_type: {}", e))?;
        if ty.is_dir() {
            collect_rel_files(base, &path, out)?;
        } else {
            let rel = path
                .strip_prefix(base)
                .map_err(|e| format!("strip: {}", e))?;
            out.insert(rel.to_path_buf());
        }
    }
    Ok(())
}

/// root から target の親までを浅い順に検査し、file 化した ancestor を削除する。
fn clear_conflicting_ancestors(root: &Path, target: &Path) -> Result<(), String> {
    let rel = match target.strip_prefix(root) {
        Ok(rel) => rel,
        Err(_) => return Ok(()),
    };
    let comps: Vec<_> = rel.components().collect();
    let mut cur = root.to_path_buf();
    for comp in comps.iter().take(comps.len().saturating_sub(1)) {
        cur = cur.join(comp.as_os_str());
        if path_is_file_like(&cur) {
            remove_path(&cur)?;
        }
    }
    Ok(())
}

/// dst 配下の空 dir を再帰的に削除する（dst 自身は残す）。
fn remove_empty_dirs(dst: &Path) -> Result<(), String> {
    fn walk(dir: &Path, root: &Path) -> Result<(), String> {
        let entries: Vec<_> = std::fs::read_dir(dir)
            .map_err(|e| format!("read_dir {}: {}", dir.display(), e))?
            .filter_map(|e| e.ok())
            .collect();
        for entry in &entries {
            let path = entry.path();
            if path_is_real_dir(&path) {
                walk(&path, root)?;
            }
        }
        if dir != root
            && std::fs::read_dir(dir)
                .map(|mut entries| entries.next().is_none())
                .unwrap_or(false)
        {
            let _ = std::fs::remove_dir(dir);
        }
        Ok(())
    }
    if path_is_real_dir(dst) {
        walk(dst, dst)?;
    }
    Ok(())
}

/// live dst を src と一致させる。src に無い live file は削除し、空 dir も掃除する。
fn mirror_dir(src: &Path, dst: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dst).map_err(|e| format!("mkdir {}: {}", dst.display(), e))?;

    let mut src_files = BTreeSet::new();
    collect_rel_files(src, src, &mut src_files)?;
    for rel in &src_files {
        let from = src.join(rel);
        let to = dst.join(rel);
        clear_conflicting_ancestors(dst, &to)?;
        if path_is_real_dir(&to) {
            remove_path(&to)?;
        }
        atomic_copy_file(&from, &to)?;
    }

    let mut dst_files = BTreeSet::new();
    if path_is_real_dir(dst) {
        collect_rel_files(dst, dst, &mut dst_files)?;
    }
    let mut extras: Vec<PathBuf> = dst_files.difference(&src_files).cloned().collect();
    extras.sort_by_key(|rel| std::cmp::Reverse(rel.components().count()));
    for rel in extras {
        remove_path(&dst.join(rel))?;
    }
    remove_empty_dirs(dst)?;
    Ok(())
}

/// generation の scope entry を live に full-replace する。
fn restore_scope_entry(gen_dir: &Path, charminal: &Path, rel: &str) -> Result<(), String> {
    let src = gen_dir.join(rel);
    let dst = charminal.join(rel);
    clear_conflicting_ancestors(charminal, &dst)?;

    if src.exists() {
        if path_is_real_dir(&src) && path_is_file_like(&dst) {
            remove_path(&dst)?;
        }
        if path_is_file_like(&src) && path_is_real_dir(&dst) {
            remove_path(&dst)?;
        }
        if path_is_real_dir(&src) {
            mirror_dir(&src, &dst)?;
        } else {
            atomic_copy_file(&src, &dst)?;
        }
    } else {
        remove_path(&dst)?;
    }
    Ok(())
}

/// restore を許す相対 path か。allowlist：packs / packs/<...> / config.json / init.js のみ。
fn is_restorable_rel(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return false;
    }
    let comps: Vec<_> = path.components().collect();
    if comps.is_empty()
        || comps
            .iter()
            .any(|comp| !matches!(comp, Component::Normal(_)))
    {
        return false;
    }

    match comps[0] {
        Component::Normal(seg) if seg == "config.json" || seg == "init.js" => comps.len() == 1,
        Component::Normal(seg) if seg == "packs" => true,
        _ => false,
    }
}

pub(crate) fn snapshot_restore_impl(
    home_root: &Path,
    seq: u64,
    paths: Option<Vec<String>>,
) -> Result<(), String> {
    let charminal = charminal_dir(home_root);
    let gen_dir = history_root(home_root)
        .join(GENERATIONS_DIR)
        .join(gen_dirname(seq));
    if !gen_dir.exists() {
        return Err(format!("generation {} not found", seq));
    }
    let scope: Vec<String> = match paths {
        Some(paths) if !paths.is_empty() => paths,
        _ => SNAPSHOT_INCLUDES.iter().map(|s| s.to_string()).collect(),
    };

    // 破壊的 restore なので、scope 全体を検証してから live に触る。
    for rel in &scope {
        if !is_restorable_rel(rel) {
            return Err(format!("restore path not allowed: {}", rel));
        }
    }

    // 破壊的 restore の前に現状を 1 枚撮り、restore 自体を undo 可能にする（可逆性の土台・Scope A）。
    // pre-restore は whole-home（SNAPSHOT_INCLUDES）を撮るので、部分 restore でも安全網は全体に効く。
    // 撮影失敗は recovery を止めない（best-effort・log のみ。crash 復旧を pre-restore 失敗で塞がない）。
    if let Err(e) = snapshot_create_impl(home_root, "pre-restore", None) {
        eprintln!("[history] pre-restore snapshot failed: {}", e);
    }

    for rel in &scope {
        restore_scope_entry(&gen_dir, &charminal, rel)?;
    }
    Ok(())
}

/// seq の新しい順に keep_n 件だけ残し、古い generation dir と index entry を削除する。
pub(crate) fn snapshot_prune_impl(home_root: &Path, keep_n: usize) -> Result<(), String> {
    let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_index(home_root)?;
    index.snapshots.sort_by(|a, b| b.seq.cmp(&a.seq));
    if index.snapshots.len() <= keep_n {
        return Ok(());
    }

    let gens_root = history_root(home_root).join(GENERATIONS_DIR);
    let removed: Vec<SnapshotEntry> = index.snapshots.split_off(keep_n);
    for entry in &removed {
        let _ = std::fs::remove_dir_all(gens_root.join(gen_dirname(entry.seq)));
    }
    write_index(home_root, &index)?;
    Ok(())
}

/// 直前 startup が clean だったか（last-startup.json の load error 有無）を返す。
/// report 不在なら None（未確認）、failed が 1 件でもあれば Some(false)、無ければ Some(true)。
pub(crate) fn is_last_startup_clean(home_root: &Path) -> Option<bool> {
    let text = crate::read_last_startup_report_impl(home_root).ok()?;
    if text.is_empty() {
        return None;
    }
    let parsed: serde_json::Value = serde_json::from_str(&text).ok()?;
    let results = parsed.get("loadResults")?.as_array()?;
    let any_failed = results
        .iter()
        .any(|item| item.get("status").and_then(|v| v.as_str()) == Some("failed"));
    Some(!any_failed)
}

/// index の seq に一致する entry に startup_clean を付ける（advisory・spec §0）。
/// 一致なしは no-op。index の read-modify-write は SNAPSHOT_LOCK で直列化する。
pub(crate) fn tag_startup_clean(home_root: &Path, seq: u64, clean: bool) -> Result<(), String> {
    let _guard = SNAPSHOT_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut index = read_index(home_root)?;
    if let Some(entry) = index.snapshots.iter_mut().find(|e| e.seq == seq) {
        entry.startup_clean = Some(clean);
        write_index(home_root, &index)?;
    }
    Ok(())
}

#[tauri::command]
pub fn snapshot_create(trigger: String, label: Option<String>) -> Result<u64, String> {
    let home = crate::home_dir_or_err()?;
    snapshot_create_impl(&home, &trigger, label.as_deref())
}

#[tauri::command]
pub fn snapshot_list() -> Result<Vec<SnapshotEntry>, String> {
    let home = crate::home_dir_or_err()?;
    snapshot_list_impl(&home)
}

#[tauri::command]
pub fn snapshot_restore(seq: u64, paths: Option<Vec<String>>) -> Result<(), String> {
    let home = crate::home_dir_or_err()?;
    snapshot_restore_impl(&home, seq, paths)
}

#[tauri::command]
pub fn snapshot_prune(keep_n: usize) -> Result<(), String> {
    let home = crate::home_dir_or_err()?;
    snapshot_prune_impl(&home, keep_n)
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
            startup_clean: None,
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
    fn restore_takes_pre_restore_snapshot_first() {
        let home = tmp_home("pre-restore");
        let charminal = home.join(".charminal");
        fs::create_dir_all(charminal.join("packs/foo")).unwrap();
        fs::write(charminal.join("config.json"), "{\"v\":1}").unwrap();

        // seq 1: 元の状態。
        let seq1 = snapshot_create_impl(&home, "manual", None).unwrap();
        assert_eq!(seq1, 1);

        // live を変更（壊す想定）。
        fs::write(charminal.join("config.json"), "{\"v\":2}").unwrap();

        // seq 1 に戻す。戻す前に pre-restore が 1 枚撮られるはず。
        snapshot_restore_impl(&home, seq1, None).unwrap();

        // index に "pre-restore" entry がある（= restore 自体が undo 可能）。
        let snaps = snapshot_list_impl(&home).unwrap();
        assert!(
            snaps.iter().any(|s| s.trigger == "pre-restore"),
            "pre-restore snapshot must exist after restore"
        );
        // live は seq1 の内容（v:1）に戻っている。
        let restored = fs::read_to_string(charminal.join("config.json")).unwrap();
        assert_eq!(restored, "{\"v\":1}");

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

    #[test]
    fn restore_full_replace_removes_extra_pack() {
        let home = tmp_home("restore-extra");
        let charminal = home.join(".charminal");
        fs::create_dir_all(charminal.join("packs/foo")).unwrap();
        fs::write(charminal.join("packs/foo/effect.js"), "v1").unwrap();
        fs::write(charminal.join("config.json"), "{\"a\":1}").unwrap();

        let seq = snapshot_create_impl(&home, "base", None).unwrap();

        // snapshot 後に壊れた pack を追加し、既存も改変する。
        fs::create_dir_all(charminal.join("packs/bad")).unwrap();
        fs::write(charminal.join("packs/bad/effect.js"), "boom").unwrap();
        fs::write(charminal.join("packs/foo/effect.js"), "v2-broken").unwrap();

        snapshot_restore_impl(&home, seq, None).unwrap();

        assert!(!charminal.join("packs/bad").exists());
        assert_eq!(
            fs::read_to_string(charminal.join("packs/foo/effect.js")).unwrap(),
            "v1"
        );
        assert_eq!(
            fs::read_to_string(charminal.join("config.json")).unwrap(),
            "{\"a\":1}"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_resolves_path_type_conflict() {
        let home = tmp_home("restore-conflict");
        let charminal = home.join(".charminal");
        // snapshot 時: effect.js は file。
        fs::create_dir_all(charminal.join("packs/foo")).unwrap();
        fs::write(charminal.join("packs/foo/effect.js"), "real").unwrap();
        let seq = snapshot_create_impl(&home, "base", None).unwrap();

        // 外部直編集で effect.js が directory になってしまった。
        fs::remove_file(charminal.join("packs/foo/effect.js")).unwrap();
        fs::create_dir_all(charminal.join("packs/foo/effect.js")).unwrap();
        fs::write(charminal.join("packs/foo/effect.js/inner"), "x").unwrap();

        snapshot_restore_impl(&home, seq, None).unwrap();

        let p = charminal.join("packs/foo/effect.js");
        assert!(p.is_file());
        assert_eq!(fs::read_to_string(&p).unwrap(), "real");

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_resolves_nested_ancestor_conflict() {
        let home = tmp_home("restore-nested-conflict");
        let charminal = home.join(".charminal");
        // snapshot 時: packs/foo/assets/a.png は file（packs/foo は dir）。
        fs::create_dir_all(charminal.join("packs/foo/assets")).unwrap();
        fs::write(charminal.join("packs/foo/assets/a.png"), "img").unwrap();
        let seq = snapshot_create_impl(&home, "base", None).unwrap();

        // 外部直編集で packs/foo を file にしてしまった（上位 ancestor が file）。
        fs::remove_dir_all(charminal.join("packs/foo")).unwrap();
        fs::write(charminal.join("packs/foo"), "oops-file").unwrap();

        snapshot_restore_impl(&home, seq, None).unwrap();

        assert!(charminal.join("packs/foo").is_dir());
        assert_eq!(
            fs::read_to_string(charminal.join("packs/foo/assets/a.png")).unwrap(),
            "img"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_partial_scope_only_touches_given_path() {
        let home = tmp_home("restore-partial");
        let charminal = home.join(".charminal");
        fs::create_dir_all(charminal.join("packs/foo")).unwrap();
        fs::write(charminal.join("packs/foo/effect.js"), "v1").unwrap();
        fs::write(charminal.join("config.json"), "orig").unwrap();
        let seq = snapshot_create_impl(&home, "base", None).unwrap();

        fs::write(charminal.join("packs/foo/effect.js"), "v2").unwrap();
        fs::write(charminal.join("config.json"), "changed").unwrap();

        // packs だけ restore。config は触らない。
        snapshot_restore_impl(&home, seq, Some(vec!["packs".to_string()])).unwrap();

        assert_eq!(
            fs::read_to_string(charminal.join("packs/foo/effect.js")).unwrap(),
            "v1"
        );
        assert_eq!(
            fs::read_to_string(charminal.join("config.json")).unwrap(),
            "changed"
        );

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn restore_rejects_disallowed_paths() {
        let home = tmp_home("restore-guard");
        let charminal = home.join(".charminal");
        fs::write(charminal.join("config.json"), "{}").unwrap();
        // 対象外 path を確実に live に置く（消されないことを確認するため）。
        fs::create_dir_all(charminal.join("journal")).unwrap();
        fs::write(charminal.join("journal/memo.md"), "keep").unwrap();
        let seq = snapshot_create_impl(&home, "base", None).unwrap();

        for bad in [
            ".history",
            ".staging",
            "tmp",
            "journal",
            "memories.md",
            "sdk.d.ts",
            "last-startup.json",
            "..",
            "/etc",
        ] {
            let r = snapshot_restore_impl(&home, seq, Some(vec![bad.to_string()]));
            assert!(r.is_err(), "should reject {}", bad);
        }
        // journal は無傷。
        assert!(charminal.join("journal/memo.md").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn prune_keeps_last_n() {
        let home = tmp_home("prune");
        let charminal = home.join(".charminal");
        fs::write(charminal.join("config.json"), "{}").unwrap();
        for _ in 0..5 {
            snapshot_create_impl(&home, "x", None).unwrap();
        }
        snapshot_prune_impl(&home, 2).unwrap();

        let list = snapshot_list_impl(&home).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].seq, 5);
        assert_eq!(list[1].seq, 4);
        // 古い gen dir は消えている。
        assert!(!charminal.join(".history/generations/000001").exists());
        assert!(charminal.join(".history/generations/000005").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn is_last_startup_clean_reflects_load_results() {
        let home = tmp_home("startup-clean");
        let charminal = home.join(".charminal");
        // report 不在 → None（未確認）。
        assert_eq!(is_last_startup_clean(&home), None);
        // failed が 1 件でもあれば Some(false)。
        fs::write(
            charminal.join("last-startup.json"),
            r#"{"loadResults":[{"id":"a","kind":"effect","status":"loaded"},{"id":"b","kind":"persona","status":"failed"}]}"#,
        )
        .unwrap();
        assert_eq!(is_last_startup_clean(&home), Some(false));
        // 全 loaded なら Some(true)。
        fs::write(
            charminal.join("last-startup.json"),
            r#"{"loadResults":[{"id":"a","kind":"effect","status":"loaded"}]}"#,
        )
        .unwrap();
        assert_eq!(is_last_startup_clean(&home), Some(true));

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn tag_startup_clean_sets_field_on_matching_seq() {
        let home = tmp_home("tag-clean");
        let charminal = home.join(".charminal");
        fs::write(charminal.join("config.json"), "{}").unwrap();
        let seq = snapshot_create_impl(&home, "startup-baseline", None).unwrap();
        assert_eq!(snapshot_list_impl(&home).unwrap()[0].startup_clean, None);

        tag_startup_clean(&home, seq, true).unwrap();
        assert_eq!(
            snapshot_list_impl(&home).unwrap()[0].startup_clean,
            Some(true)
        );
        // 存在しない seq は no-op（エラーにしない）。
        tag_startup_clean(&home, 999, false).unwrap();

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn snapshot_create_skips_seq_of_orphan_generation_dir() {
        let home = tmp_home("orphan-seq");
        let charminal = home.join(".charminal");
        fs::write(charminal.join("config.json"), "{}").unwrap();
        // index には無いが generations/000003 が実在する（前回 crash 後の残骸を模す）。
        fs::create_dir_all(charminal.join(".history/generations/000003")).unwrap();

        let seq = snapshot_create_impl(&home, "x", None).unwrap();
        // 空 index の next_seq=1 ではなく、実在 dir 000003 の次の 4 を採る。
        assert_eq!(seq, 4);
        // orphan dir は温存される（上書きしない）。
        assert!(charminal.join(".history/generations/000003").exists());
        assert!(charminal.join(".history/generations/000004").exists());

        let _ = fs::remove_dir_all(&home);
    }

    #[test]
    fn concurrent_snapshot_creates_get_unique_seqs() {
        let home = std::sync::Arc::new(tmp_home("concurrent"));
        let charminal = home.join(".charminal");
        fs::write(charminal.join("config.json"), "{}").unwrap();

        let mut handles = Vec::new();
        for _ in 0..8 {
            let home = home.clone();
            handles.push(std::thread::spawn(move || {
                snapshot_create_impl(&home, "x", None).unwrap()
            }));
        }
        let mut seqs: Vec<u64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        seqs.sort_unstable();
        let unique = {
            let mut s = seqs.clone();
            s.dedup();
            s.len()
        };
        // 8 件すべて unique な seq（lock が無いと同 seq 衝突で < 8 になり得る）。
        assert_eq!(unique, 8, "all seqs unique: {:?}", seqs);

        let list = snapshot_list_impl(&home).unwrap();
        assert_eq!(list.len(), 8);

        let _ = fs::remove_dir_all(home.as_path());
    }
}
