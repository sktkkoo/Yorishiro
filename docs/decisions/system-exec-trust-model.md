# system.exec の trust model と設計判断

> このファイルは「**amenity pack の system.exec の安全性 / 権限 / 監査**」を考える時に読む。対象：dev / AI / OSS reviewer。

**Status**: active
**Last updated**: 2026-06-03

## TL;DR

user amenity pack の `ctx.system.exec()` は `sh -c` 経由で任意の shell command を実行できる。これは local user pack（`trusted-main-thread-js`）のみに許可される。community pack からは TS 層で明示的に block する。全呼び出しを pack id 付きで audit log に記録する。

## 何を決めたか

### 1. local user pack のみ exec を許可

| Pack source | system.exec | 理由 |
|---|---|---|
| `local` | **許可** | ユーザーが自分のマシンに置いた code。VS Code extension / Emacs package と同じ trust model |
| `bundled` | 許可 | Charminal 本体の code |
| `curated` | 許可 | publisher review 済み |
| `community` | **block** | `isolated-js` + capability RPC + permission UI が前提。TS 層で throw |

enforcement は `amenity-activation.ts` の `createUserAmenityContextFactory` 内で `source === "community"` を検査して throw する。将来 community pack が `isolated-js` で動く場合、exec は capability RPC 経由で host が検証する（[`pack-execution-classes.md`](pack-execution-classes.md) §3 の gate 設計に従う）。

### 2. `sh -c` による shell 実行

exec は `sh -c "<command>"` で実行する（Windows は `cmd /C`）。argv 方式ではなく shell string を受ける。

理由：
- 主要 use case（`osascript -e '...'`、`git status --short`、`find ... -name '*.mp3'`）が shell の引用符やパイプを必要とする
- user pack は `trusted-main-thread-js` であり、pack code 自体が信頼されている前提
- shell injection は「pack code が悪意を持つ場合」に起きるが、その場合 exec に限らず任意の browser API を実行できるため、exec 層で防いでも実質的な安全性は変わらない

community pack 向けの将来設計では argv 方式 + command allowlist を [`pack-execution-classes.md`](pack-execution-classes.md) が規定している。local user pack の `sh -c` とは別経路として設計する。

### 3. audit log（全呼び出しを記録）

Rust 側の `system_exec` Tauri command が、呼び出しごとに stderr へ記録する：

```
[system-exec] pack=music-shelf cmd=osascript -e 'tell application "Music" to play'
[system-exec] pack=music-shelf exit=0 duration=120ms
```

記録する情報：
- 呼び出し元 pack id
- 実行コマンド（120 文字で truncate）
- 実行結果（exit code / duration）
- エラー時はエラーメッセージ

audit log は stderr 出力であり、Tauri の devtools console に表示される。将来ファイル出力や structured log に移行する余地はあるが、MVP では stderr で十分。

### 4. timeout default 30 秒

`ExecOptions.timeoutMs` 未指定時は 30 秒で kill する。amenity pack が指定すれば上書き可能。暴走プロセスの防止が目的であり、security gate ではない。

### 5. Charminal の PATH を継承

exec は Charminal プロセスの PATH（`build_path_env()` で構築、Homebrew 等のディレクトリを含む）を継承する。agent adapter の extra path dirs も含まれる。これにより `osascript`、`git`、`brew` 等のコマンドが user pack から使える。

## なぜそう決めたか

- **trust model は VS Code / Emacs と同じ**: ローカルに install された拡張は full access を持つ。per-exec の承認 UI は UX を破壊し、security theater になる（ユーザーは全部 allow する）
- **XSS → RCE リスクは exec 固有ではない**: webview に XSS があった場合、`system_exec` が RCE vector になるが、exec を外しても `trusted-main-thread-js` の pack は Tauri IPC を直接叩ける。exec を gate しても根本対策にならない。XSS 防止は CSP と input sanitization の層で行う
- **community pack は別 track**: `isolated-js` + capability RPC + permission UI で構造的に隔離する設計が [`pack-execution-classes.md`](pack-execution-classes.md) に記載済み。local user pack の exec を制限するのではなく、community pack の実行環境を分離することで対処する

## 検討したが却下した代替案

- **per-exec 承認ダイアログ**: UX 破壊 + security theater。VS Code が extension の `child_process.exec` に毎回ダイアログを出さないのと同じ理由
- **command allowlist（local user pack 向け）**: user が自分で書いた pack のコマンドを自分で allowlist する意味がない。community pack 向けには必要（別 track）
- **Tauri shell plugin 経由**: plugin の scoped command model は宣言的で安全だが、`osascript -e '...'` のような動的コマンド構築に向かない。local user pack の自由度を優先
- **exec を入れない**: amenity の実用価値が大幅に下がる。音楽操作、git 操作、システム情報取得など、exec なしでは CLI wrapper 以下の機能しか提供できない

## この決定の implication

- local user pack は任意の shell command を実行できる。ユーザーが pack を install する時点でこの信頼を与えている
- community pack は `system.exec` を呼べない（TS 層で throw）。将来 `isolated-js` + capability RPC が実装されるまで、community amenity pack は公開しない（[`pack-execution-classes.md`](pack-execution-classes.md) MVP 推奨 §6）
- audit log は devtools console に出力される。production でも記録は残るが、ユーザーが明示的に見に行く必要がある

## Bundled amenity の default-off 方針

`system.exec` を使う bundled amenity は **登録時に `enable()` を呼ばない** ことで default-off を実現する。`disabledPacks` は使わない（config migration の問題を避けるため）。

| pack | 登録時 enable | 理由 |
|---|---|---|
| pomodoro | **する** | system 権限なし。初回体験の核。pomodoro-ui が依存 |
| music-shelf | **しない** | `system.exec` あり。macOS 専用。明示的 opt-in |

有効化の手段：
- MCP `enable_pack("music-shelf")` を呼ぶ
- 設定画面の on/off トグル（別 scope で実装予定）

`disabledPacks` で default-off を表現しない理由：
- 既存ユーザーの config に `disabledPacks` がある場合、新規 default-disabled pack が漏れる
- config migration が必要になり、parse/serialize の複雑さが増す
- 登録時 enable 制御の方が単純で確実

## 関連 reference

- [`pack-execution-classes.md`](pack-execution-classes.md) — execution class / source / sandbox 設計
- [`mcp-trust-tiers.md`](mcp-trust-tiers.md) — MCP trust tier（Tier 3 = community pack の gate）
- [`critical-constraints.md`](critical-constraints.md) — PTY write 禁止（exec とは別の不可侵境界）
- source: `src-tauri/src/lib.rs` — `system_exec` Tauri command
- source: `src/runtime/user-pack-loader/amenity-activation.ts` — source gate + context factory
- source: `src/bindings/tauri-commands.ts` — TS binding

## 改訂履歴

- 2026-06-03: 初版。system.exec 実体化に伴い trust model / audit log / community block の設計判断を記録。
