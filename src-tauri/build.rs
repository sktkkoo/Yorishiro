use std::collections::BTreeMap;
use std::fmt::Write as FmtWrite;
use std::path::{Path, PathBuf};

/// bundled-packs/ の plural ディレクトリ名から pack の kind（singular）を返す。
/// `shared/` は pack ではないが、独立 kind として格納する。
fn plural_to_kind(dir_name: &str) -> Option<&'static str> {
    match dir_name {
        "effects" => Some("effect"),
        "personas" => Some("persona"),
        "scenes" => Some("scene"),
        "amenities" => Some("amenity"),
        "ui" => Some("ui"),
        "ambient-ui" => Some("ambient-ui"),
        "shared" => Some("shared"),
        _ => None,
    }
}

/// 埋め込み対象のテキスト拡張子か。
fn is_embeddable_ext(ext: &str) -> bool {
    matches!(ext, "ts" | "tsx" | "json" | "md")
}

/// 除外すべきファイル名パターンか。
fn is_excluded(file_name: &str) -> bool {
    file_name.ends_with(".test.ts")
        || file_name.ends_with(".test.tsx")
        || file_name.starts_with("tsconfig")
        || file_name == "hmr.ts"
}

/// `dir` を再帰 walk し、embeddable なファイルの相対パス一覧を返す。
fn collect_files(dir: &Path, base: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            dirs.push(path);
        } else if path.is_file() {
            let file_name = path.file_name().unwrap_or_default().to_string_lossy();
            let ext = path
                .extension()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string();
            if is_embeddable_ext(&ext) && !is_excluded(&file_name) {
                if let Ok(rel) = path.strip_prefix(base) {
                    files.push(rel.to_path_buf());
                }
            }
        }
    }
    // ディレクトリをソートして再帰（決定的順序）
    dirs.sort();
    for d in dirs {
        files.extend(collect_files(&d, base));
    }
    files.sort();
    files
}

/// pack ID と kind ごとにファイルをグループ化した構造体。
struct PackGroup {
    id: String,
    kind: String,
    /// pack ルートからの相対パス（例: "effect.ts", "lib/lights.tsx"）
    relative_paths: Vec<String>,
    /// bundled-packs/ からの相対パス（include_str! 用）
    full_relative_paths: Vec<String>,
}

/// bundled-packs/ を走査して PackGroup のリストを構築する。
fn collect_pack_groups(bundled_packs_dir: &Path) -> Vec<PackGroup> {
    let mut groups: BTreeMap<(String, String), (Vec<String>, Vec<String>)> = BTreeMap::new();

    let Ok(top_entries) = std::fs::read_dir(bundled_packs_dir) else {
        return Vec::new();
    };

    let mut top_dirs: Vec<_> = top_entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .collect();
    top_dirs.sort_by_key(|e| e.file_name());

    // bundled-packs/README.md 等の top-level ファイルを __meta__ に格納
    let top_files = collect_files(bundled_packs_dir, bundled_packs_dir);
    let top_only: Vec<_> = top_files
        .iter()
        .filter(|p| p.components().count() == 1)
        .collect();
    if !top_only.is_empty() {
        let key = ("__meta__".to_string(), "meta".to_string());
        let entry = groups.entry(key).or_default();
        for rel in &top_only {
            entry.0.push(rel.to_string_lossy().to_string());
            entry.1.push(rel.to_string_lossy().to_string());
        }
    }

    for top_entry in top_dirs {
        let dir_name = top_entry.file_name().to_string_lossy().to_string();
        let Some(kind) = plural_to_kind(&dir_name) else {
            continue;
        };

        let kind_dir = top_entry.path();

        if kind == "shared" {
            // shared/ はパックではない。shared ディレクトリ内の全ファイルを
            // id=`__shared__`, kind="shared" としてまとめる。
            let files = collect_files(&kind_dir, &kind_dir);
            if !files.is_empty() {
                let key = ("__shared__".to_string(), "shared".to_string());
                let entry = groups.entry(key).or_default();
                for rel in &files {
                    let rel_str = rel.to_string_lossy().to_string();
                    let full_rel = format!("{}/{}", dir_name, rel_str);
                    entry.0.push(rel_str);
                    entry.1.push(full_rel);
                }
            }
            continue;
        }

        // kind ディレクトリ内の各 pack を列挙
        let Ok(pack_entries) = std::fs::read_dir(&kind_dir) else {
            continue;
        };
        let mut pack_dirs: Vec<_> = pack_entries
            .flatten()
            .filter(|e| e.path().is_dir())
            .collect();
        pack_dirs.sort_by_key(|e| e.file_name());

        for pack_entry in pack_dirs {
            let pack_id = pack_entry.file_name().to_string_lossy().to_string();
            let pack_dir = pack_entry.path();
            let files = collect_files(&pack_dir, &pack_dir);

            if files.is_empty() {
                continue;
            }

            // personas/clai-shared は manifest.json を持たない shared module。
            // kind="shared" ではなく、親ディレクトリの kind をそのまま使って
            // id=clai-shared として格納する。
            let key = (pack_id.clone(), kind.to_string());
            let entry = groups.entry(key).or_default();
            for rel in &files {
                let rel_str = rel.to_string_lossy().to_string();
                let full_rel = format!("{}/{}/{}", dir_name, pack_id, rel_str);
                entry.0.push(rel_str);
                entry.1.push(full_rel);
            }
        }
    }

    groups
        .into_iter()
        .map(
            |((id, kind), (relative_paths, full_relative_paths))| PackGroup {
                id,
                kind,
                relative_paths,
                full_relative_paths,
            },
        )
        .collect()
}

/// PackGroup リストから bundled_examples_gen.rs のソースコードを生成する。
fn generate_rust_source(groups: &[PackGroup]) -> String {
    let mut out = String::new();
    writeln!(
        out,
        "// bundled-packs/ のソースを binary に埋め込むための自動生成ファイル。"
    )
    .unwrap();
    writeln!(out, "// build.rs が生成する — 手動編集しないこと。").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "/// bundled pack 内の 1 ファイル。").unwrap();
    writeln!(out, "pub struct BundledExampleFile {{").unwrap();
    writeln!(out, "    pub path: &'static str,").unwrap();
    writeln!(out, "    pub content: &'static str,").unwrap();
    writeln!(out, "}}").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "/// 1 pack 分のファイル群。").unwrap();
    writeln!(out, "pub struct BundledExamplePack {{").unwrap();
    writeln!(out, "    pub id: &'static str,").unwrap();
    writeln!(out, "    pub kind: &'static str,").unwrap();
    writeln!(out, "    pub files: &'static [BundledExampleFile],").unwrap();
    writeln!(out, "}}").unwrap();
    writeln!(out).unwrap();
    writeln!(out, "#[rustfmt::skip]").unwrap();
    writeln!(
        out,
        "pub static BUNDLED_EXAMPLES: &[BundledExamplePack] = &["
    )
    .unwrap();

    for group in groups {
        writeln!(out, "    BundledExamplePack {{").unwrap();
        writeln!(out, "        id: {:?},", group.id).unwrap();
        writeln!(out, "        kind: {:?},", group.kind).unwrap();
        writeln!(out, "        files: &[").unwrap();
        for (rel, full_rel) in group
            .relative_paths
            .iter()
            .zip(group.full_relative_paths.iter())
        {
            writeln!(out, "            BundledExampleFile {{").unwrap();
            writeln!(out, "                path: {:?},", rel).unwrap();
            writeln!(
                out,
                "                content: include_str!(\"../../bundled-packs/{}\"),",
                full_rel
            )
            .unwrap();
            writeln!(out, "            }},").unwrap();
        }
        writeln!(out, "        ],").unwrap();
        writeln!(out, "    }},").unwrap();
    }

    writeln!(out, "];").unwrap();
    out
}

fn main() {
    // bundled-packs/ 変更時のみ再生成する
    println!("cargo:rerun-if-changed=../bundled-packs");

    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set");
    let bundled_packs_dir = Path::new(&manifest_dir).join("..").join("bundled-packs");
    let gen_path = Path::new(&manifest_dir)
        .join("src")
        .join("bundled_examples_gen.rs");

    let groups = collect_pack_groups(&bundled_packs_dir);
    let source = generate_rust_source(&groups);

    // 内容が同一なら write をスキップ（不要な再 compile を避ける）
    if let Ok(existing) = std::fs::read_to_string(&gen_path) {
        if existing == source {
            tauri_build::build();
            return;
        }
    }

    std::fs::write(&gen_path, &source).expect("bundled_examples_gen.rs の書き出しに失敗");

    tauri_build::build()
}
