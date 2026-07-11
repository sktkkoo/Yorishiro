# Avatar (VRM) import の検証境界

**Status**: active
**Last updated**: 2026-06-11

## TL;DR

`import_vrm` は source を (1) symlink・非 regular file を拒否、(2) GLB header（magic `glTF` / version 2 / 宣言長 == 実ファイルサイズ）を検証、(3) 検証済みの file handle をそのままコピー（path を再オープンしない）する。任意ファイルの吸い出しと検証後すり替え（TOCTOU）を塞ぐための境界で、symlink 経由 import と spec 違反 GLB を**意図的に**弾く。

## 何を決めたか

`import_vrm`（`src-tauri/src/lib.rs`）が受け取った `src` path に対し、コピー前に以下を強制する：

- **symlink 拒否 / regular file のみ**：`symlink_metadata` で種別を確認し、symlink と非 regular file（dir / device / fifo 等）を拒否する
- **GLB content 検証**：先頭 12 byte を読み、magic == `glTF`、version == 2、宣言長 == 実ファイルサイズ を確認。拡張子だけ `.vrm` の偽装ファイルを弾く
- **TOCTOU-safe copy**：検証で開いた file handle を rewind して `std::io::copy` でコピーする。`std::fs::copy(path, ...)` のように path を再オープンしない

## なぜそう決めたか

コピー先 `$APPDATA/avatars/` は assetProtocol scope（`$APPDATA/**`）配下で、webview から asset 経由で読める。検証なしだと：

- `~/.ssh/id_rsa` 等の任意ファイルを `.vrm` 拡張子（または symlink）で指定して avatars/ に複製 → webview から内容を読み出せる情報持ち出し経路になる
- path を検証した後、コピー時に再オープンする隙に source を差し替える TOCTOU が成立しうる

symlink・非 regular file・非 GLB を拒否し、検証した handle を直接コピーすることで、この経路を構造的に塞ぐ。

## 検討したが却下した代替案

- **拡張子チェックのみ**：`.vrm` 拡張子だけ確認する案。偽装ファイル・symlink・TOCTOU を防げない。初版（commit `8f59586`）はこれだったが不十分として強化した（`5e2871b`）
- **コピー先 basename の sanitize のみ**：`file_name()` が既に最後の component だけ取るため traversal は元から無い。本質は source 側の検証なので不採用

## この決定の implication / 制約

- **symlink 経由の VRM import は不可**。`~/Music/avatar.vrm` への symlink を選んでも弾かれる。UX より任意ファイル吸い出し防止を優先した意図的なトレードオフで、「symlink VRM が import できない」は仕様
- **GLB spec 違反のファイルは弾かれる**。宣言長 != 実サイズ（trailing padding 等）の VRM は reject。主要 exporter（VRoid / UniVRM / Blender VRM）は spec 準拠で通る。bundled `Yori.vrm`（22.7 MB）は宣言長 == 実サイズで通ることを確認済み
- 将来 symlink 許可や非準拠 GLB の受容が必要になったら、緩める前に「任意ファイル吸い出し経路が再び開く」ことを再評価する

## 関連 reference

- `src-tauri/src/lib.rs` — `open_vrm_import_source` / `validate_vrm_glb_header` / `has_vrm_extension`
- [`voice-clip-resolution.md`](voice-clip-resolution.md) — pack-local ref の `.`/`..` 拒否（同じく asset 解決の security 境界）
- `docs/security.md`「Current enforcement status」
