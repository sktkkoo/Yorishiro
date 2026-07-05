# git2 (libgit2 vendored) による snapshot store

> **Status:** accepted (2026-06-06)
> **Supersedes:** full-copy snapshot store (`~/.yorishiro/.history/`)

## 決定

`~/.yorishiro/` の `packs/` / `config.json` / `init.js` の状態管理を、独自の full-copy snapshot store から `git2` crate（libgit2 vendored 静的リンク）に移行する。ユーザーのシステム git には依存しない。

## 背景

Yorishiro は `~/.yorishiro/packs/` と `init.js` の変更を自動検知し、watcher-settled snapshot として保存する。ユーザーや AI（住人）が pack を壊しても、設定画面やクラッシュ画面から以前の時点に戻せる。

初期実装（spec §0）は「とにかく動くもの」として、世代ごとに対象ディレクトリを丸ごとコピーする full-copy 方式を採った。`~/.yorishiro/.history/generations/<seq>/` に packs / config.json / init.js を full-copy し、`index.json` でメタデータを管理する。

## 問題

full-copy 方式を運用する中で以下の問題が顕在化した:

1. **ディスク消費**: 50 世代 × packs 全体のコピー。pack にアセットが含まれると急速に肥大化する
2. **自前ロジックの肥大**: burst dedup（同一変更の短時間連打を抑制）、baseline skip（連続 reload の重複排除）、.DS_Store filter、snapshot 対象外 state の除外——これらを全て手書きで実装し、コードが増え続けていた
3. **diff が出ない**: 「何が変わったか」を示すには独自の manifest diff を設計・実装する必要がある。snapshot の `changed` フィールドに pack ID を入れる仕組みを作り込んでいたが、ファイルレベルの差分は見えない
4. **content dedup が無い**: 同一内容のファイルが世代ごとに別コピーとして保存される

これらは git の content-addressed storage + `.gitignore` + diff API で自然に解決する。独自実装を磨くほど git の再発明に近づく構造だった。

## なぜ git2 (libgit2 vendored) か

### 外部 git コマンドではなく libgit2 を組み込む理由

- **システム git 非依存**: Yorishiro のユーザーは開発者に限らない（Claude Code が非開発者にも CLI を広げた）。git がインストールされていない環境でも動く必要がある
- **`git2` crate の `vendored-libgit2` feature** で libgit2 を静的リンクし、Tauri バイナリに含める。外部依存ゼロ
- 同じ構成（Tauri + git2 vendored）は GitButler が実績を持つ

### gitoxide (gix) ではなく git2 を選ぶ理由

- `git2` は 10 年以上の実績。Cargo 自体が依存している
- API が安定（1.x）。`gix` はまだ 0.x で破壊的変更がある
- Yorishiro が使う操作（init / add / commit / checkout / revwalk / notes）は `git2` で十分にカバーされている
- ライセンス: libgit2 は GPLv2 with linking exception。静的リンクしても Yorishiro に GPL が伝播しない。`gix` は MIT/Apache-2.0 でよりクリーンだが、API 安定性を優先した

### git dir と work tree の分離

`~/.yorishiro/` に `.git/` を置かない。git dir は `~/.yorishiro/.yorishiro-snapshots/` に隔離する。

理由: 将来 `packs/<id>/` が自前の git repo を持つ（pack の共有・配布）ときに、親の `.git` と衝突しないため。`git2::RepositoryInitOptions::workdir_path` で work tree を `~/.yorishiro/`、git dir を `.yorishiro-snapshots/` に分離する。

## ユーザー・AI からの不可視性

git はインフラとして完全に隠蔽する:

- **ユーザー**: 設定画面の restore 一覧は `seq` / `changeText` / `timeText` しか見えない。git の概念（commit, branch, hash）は一切露出しない
- **AI（住人）**: MCP ツールは `history_snapshot(label)` / `history_list` / `history_restore(seq)` の 3 つ。中身が full-copy か git かを知る必要がない
- **Pack 開発者**: SDK の `ctx.history.snapshot(label)` / `ctx.history.restore(seq)` は型が変わらない

## 得られるもの

- **content dedup**: 同一ファイルは 1 blob。世代数に比例するディスク消費が消える
- **diff**: `git2` の diff API でファイルレベルの差分が取れる（P3 の diff preview が自然に実装できる）
- **削除の自然な反映**: index を live 状態に同期するだけで、削除されたファイルも正しく commit に反映される
- **自前ロジックの削減**: `.gitignore` で `journal/` / `cohabitation.json` / `sdk.d.ts` / `last-startup.json` / `.history/` / `.yorishiro-snapshots/` / `.DS_Store` を除外。`config.json` は snapshot に含めるが watcher trigger にはしない。burst dedup は git の content-addressing が自然に吸収する（同一 tree なら no-op commit を検知できる）

## トレードオフ

- **ビルド時間**: libgit2 の C コンパイルが加わる。ただし Tauri 自体が重いので全体への影響は小さい
- **バイナリサイズ**: 数百 KB 増加
- **pack/delta 圧縮**: libgit2 は system git の `git gc --auto` 相当を自動では走らせない。loose object は蓄積する。blob dedup は効くが delta 圧縮は将来必要になったら `Packbuilder` API で対応する
- **マイグレーション**: 旧 `.history/` の履歴は移行しない。git 移行後の最初の commit が新しい履歴の起点になる
- **prune**: 公開 API 互換のため `snapshot_prune` は残すが、commit 削除はしない。restore 一覧は最新 50 件に制限し、object 圧縮は将来必要になった時に git2 側で扱う

## 改訂履歴

- 2026-06-06: 初版。full-copy → git2 移行を決定
- 2026-06-06: cohabitation を config.json から `cohabitation.json` に分離（baseline skip の正確化）。config.json は git 追跡するが watcher trigger 対象外
- 2026-06-06: snapshot 対象 / 除外 state / prune 互換 no-op を現行実装に合わせて明記
