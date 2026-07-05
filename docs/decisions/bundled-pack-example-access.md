# Bundled pack ソースの参照経路

> production build で bundled pack のソースが参照できない問題と、その解決。対象：dev / AI。

**Status**: active
**Last updated**: 2026-06-16

## 問題

bundled-packs/ のソースコードは vite build で minify され、source map なしで配布される。production app では bundled pack の実装を読む手段がない。

一方、pack 作成フロー（`/yori:create`、MCP 経由の住人 AI）は「既存 pack を参考にする」前提で設計されている。型情報は `~/.yorishiro/sdk.d.ts`（起動時に自動配布）で補えるが、動く実装例が不在では pack authoring の成功率が下がる。

## 検討した選択肢

### A. `~/.yorishiro/examples/` にソースを書き出す

`include_str!` でバイナリ埋め込み → 起動時に disk へ展開。sdk.d.ts と同じパターン。

- 利点：エディタで自然に browsing できる
- 欠点：上書きセマンティクス、所有権の曖昧さ（「これは誰のファイル？」）、multi-file pack の flatten、disk footprint

### B. MCP tool で on-demand 返却（採用）

`include_str!` でバイナリ埋め込みは同じ。disk には書かず、Tauri command + MCP tool で id 指定で返す。

- 利点：ファイルシステム管理ゼロ、常に app version と同期、Agentic UGC 前提に最適
- 欠点：エディタ browsing は不可（AI 経由または GitHub で代替）

### C. `/yori:create` のシステムプロンプトに inline 例

新インフラゼロだがソース二重管理で drift する。`/yori:create` 以外の文脈で参照不可。

## 決定

**B を採用**。理由：

1. Yorishiro の pack authoring は Agentic UGC（AI が primary author）前提。AI はファイルでなく API でソースを読む
2. `sdk.d.ts` が disk に書かれるのは IDE 型解決にファイルパスが必要だから。例は「読む」だけでパスが不要
3. discovery は既存 `list_packs` で完結。新 MCP tool は `bundled_example_read` の1つだけ
4. C（create.md 充実）は B と排他でなく補完。create.md には「まず `bundled_example_read` で例を読め」と指示を追加

## 実装

- `build.rs`: bundled-packs/ を walk → `bundled_examples_gen.rs` を自動生成（`include_str!` で全テキストファイル埋め込み）
- Tauri command: `read_bundled_pack_source(id)` / `list_bundled_pack_sources()`
- MCP tool: `bundled_example_read` — markdown 形式で返却
- 除外対象: `.test.ts`、`tsconfig*.json`、`hmr.ts`、バイナリアセット

## セキュリティ注記

examples は `~/.yorishiro/packs/`（runtime loader の scan 対象）の外に位置する概念であり、disk に書き出さないため実行経路に一切影響しない。local pack は引き続き `trusted-main-thread-js` として sandbox なしで実行される。sandbox ラダー（`declarative` → `isolated-js` → wasm → native）は公開配布解禁時に別途実装予定（[pack-execution-classes.md](pack-execution-classes.md)、[pack-sandbox-strategy.md](pack-sandbox-strategy.md)）。
