# Avatar (VRM) import の検証境界

**Status**: active
**Last updated**: 2026-08-15

## TL;DR

`import_vrm` は source を (1) symlink・非 regular file を拒否、(2) GLB header と最大 4 MiB の先頭 JSON chunk、VRM 0.x / 1.0 meta を検証、(3) 検証済みの file handle をそのまま temporary file へコピーして `sync_all` 後に同一 directory 内で rename する。任意ファイルの吸い出し、検証後すり替え（TOCTOU）、同名 avatar の上書きを塞ぐための境界である。chooser のサムネイルは別 command が AppData 内の catalog ID だけを受け、埋め込み PNG/JPEG を上限付きで遅延取得する。

## 何を決めたか

`import_vrm`（`src-tauri/src/lib.rs`）が受け取った `src` path に対し、コピー前に以下を強制する：

- **symlink 拒否 / regular file のみ**：`symlink_metadata` で種別を確認し、symlink と非 regular file（dir / device / fifo 等）を拒否する
- **GLB content 検証**：先頭 12 byte を読み、magic == `glTF`、version == 2、宣言長 == 実ファイルサイズ を確認。拡張子だけ `.vrm` の偽装ファイルを弾く
- **VRM metadata 検証**：先頭 chunk が JSON type で 4 MiB 以下であることを確認し、`extensions.VRM.meta` または `extensions.VRMC_vrm.meta` の object だけを読む。catalog 時は同じ JSON から埋め込み thumbnail の image/bufferView 参照だけを解決し、画像 bytes は読まない
- **TOCTOU-safe copy**：検証で開いた file handle を rewind して `std::io::copy` でコピーする。`std::fs::copy(path, ...)` のように path を再オープンしない
- **非上書き・atomic finalize**：同一 directory の `.tmp-<pid>-<nonce>.vrm` へ copy / `sync_all` した後、no-clobber rename で publish する。同名との競合時は検証済み temporary copy と既存 file を size + 固定長 buffer で完全比較し、同一なら既存 path を返す。内容が異なる場合だけ `name (2).vrm`、`name (3).vrm` と再試行し、失敗時は temporary を cleanup する

`list_vrm_avatars` は `$APPDATA/avatars/` 直下の `.vrm` だけを決定的な basename 順で返す。symlink、非 regular file、破損 file は追跡・除外せず理由付き invalid row とし、temporary file と他拡張子は列挙しない。metadata の欠落は `NotSpecified`、未知 enum は `Unknown` として、許可扱いしない。raw enum も残し、アプリは法的判断を代行しない。

`read_vrm_thumbnail` は catalog の basename ID だけを受ける。`$APPDATA/avatars` 直下の regular file に再制限し、外部/data URI と symlink を拒否する。埋め込み BIN の PNG/JPEG だけを最大 2 MiB・最大辺 2048px・宣言範囲内で読み、magic と画像 header を確認して raw bytes を返す。catalog response には画像 bytes を含めず、chooser が可視候補と選択中候補だけを遅延取得する。

`remove_vrm_avatar` も raw path ではなく同じ catalog basename ID だけを受け、`$APPDATA/avatars` 直下の対象だけを `remove_file` する。directory は削除せず、symlink は追跡せず link 自体だけを削除する。UI は bundled Yori と使用中 avatar を削除対象にせず、imported avatar の選択後に不可逆な file 削除であることを確認する。保存済み active path が存在しない場合は、「見つからないため一覧から削除した」と通知し、stale localStorage 参照を Yori へ自動復帰する。実在するが破損・読取不能な file は自動削除せず invalid row として残し、利用者に判断させる。

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
- **header だけ正しい generic GLB は import / probe できない**。2026-08-15 以降は parse 可能な VRM 0.x / 1.0 metadata object と 4 MiB 以下の JSON chunk を必須とする。これは利用条件をApply前に提示するための意図的な互換性変更であり、metadataを持たないGLBや極端に大きいJSONを「VRM」として受け入れる旧挙動には戻さない
- 将来 symlink 許可や非準拠 GLB の受容が必要になったら、緩める前に「任意ファイル吸い出し経路が再び開く」ことを再評価する

## 関連 reference

- `src-tauri/src/lib.rs` — `open_vrm_import_source` / `read_vrm_document` / `read_vrm_thumbnail` / `remove_vrm_avatar_in_dir` / `list_vrm_avatars_in_dir` / `import_vrm_into_dir`
- [`voice-clip-resolution.md`](voice-clip-resolution.md) — pack-local ref の `.`/`..` 拒否（同じく asset 解決の security 境界）
- `docs/security.md`「Current enforcement status」
