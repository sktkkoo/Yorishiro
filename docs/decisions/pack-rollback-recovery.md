# Pack rollback — recovery を背骨に、heavy sandbox は trust model 移行まで deferred

> このファイルは「**pack の作成 / 変更が失敗したとき前の状態に戻す仕組みを、sandbox とどう棲み分けて設計するか**」を考える時に読む。対象：dev / AI / pack 作者。詳細 spec は非公開 design-record: `2026-06-02-pack-rollback-sandbox-design.md`。

**Status**: active（P1 実装済、storage は git2 に移行済）
**Last updated**: 2026-06-30

## TL;DR

「失敗したら戻す」の仕組みは **recovery（事後の rollback）を背骨**にし、**軽量 dry-run gate（機械的失敗の事前検出）を添える**。**heavy な実行隔離（`isolated-js` sandbox）は MVP では作らない**。

根拠は trust model。Charminal の MVP は **信頼ローカルコード**（bundled=不可侵 first-party、user pack=本人＋in-loop AI の作、単一テナント）。heavy sandbox が正当化される3条件（①非信頼な第三者の作者 ②貴重な対象上で動く ③共有資源の配給）をどれも満たさない。信頼ローカル陣営（Emacs / Neovim / Obsidian / NixOS）は一様に sandbox ではなく **recovery + opt-in gate + 再現性** に投資している。

Charminal で最も痛い失敗は **主観的・挙動的退行**（感触が違う）で、validator/sandbox では検出不能・**戻す以外に救えない**。感触は帰納的に詰めるので authoring loop が要求するのは安価な可逆性＝recovery。

**MVP は known-good 自動判定を載せない（rev.5）**：主観退行は known-good で検出できないため、auto-known-good が救えるのは既に手当て済みの機械的破損だけ。複雑さの誤配分なので、MVP は **timeline undo**（「直前 snapshot に戻す」）に割り切り、health は advisory（`startupClean?`）に留める。現行 storage は `~/.charminal/.charminal-snapshots/` の git2 store で、旧 full-copy `.history/` からは移行済み。ReloadResult[]・hash 照合・startup composite validation・dry-run gate・自動 known-good は **P4 の堅い目標**に後退、軽量 manual `mark_good`（snapshot を pin して restore 候補強調）は P3。MVP（P1）の health は startup 自動の `startupClean?` advisory のみ。`mark_good` は「機械が出せない主観の良さを人間/AI が供給する」手動シグナルで、重い auto-known-good 機構とは独立。詳細は design-record `2026-06-02-pack-rollback-sandbox-design.md` §0、実装は `2026-06-02-pack-rollback-p1-plan.md`。

## 何を決めたか

> **MVP（P1）と later（P2〜P4）の線引き**：本節の決定の多くは **later（P2〜P4）の robust 設計**を述べる。**MVP（P1）の権威ある定義は design-record §0**。本節で「dry-run」「自動 known-good」と書かれた箇所は later 目標。storage は 2026-06-06 に full-copy から git2 へ移行済み。
> - **MVP（P1）**：git2-backed timeline undo（起動時 baseline ＋ 手動 snapshot）、full-replace restore、watcher filter、exclusions、restore path allowlist。prune API は互換 no-op（一覧は最新 50 件）。health は startup advisory のみ。
> - **P2**：watcher 駆動の自動 snapshot、MCP/SDK 公開、自動「直前に戻す」提案、advisory `startupClean?`。
> - **P3**：~~content-addressed store~~（git2 移行で解決済）、manual `mark_good`（pin→restore 候補強調）、diff preview。
> - **P4**：dry-run gate、ReloadResult[]、auto-known-good、bisect。

### 1. 重心は recovery、prevention は軽量 dry-run まで

- **recovery（背骨）**：`~/.charminal/{packs,config.json,init.js}` の whole-tree generation を **watcher 駆動で確定状態ごとに自動取得**（writer-agnostic。`/charm` 直編集・外部 Codex・外部エディタ・MCP write すべてに効く）し、**手動 restore**（system は勝手に戻さない）。保存は git2 の commit/tree/blob による content-addressed dedup。NixOS generations / Obsidian File Recovery の系譜。
- **prevention（軽量・Charminal-routed のみ）**：staging 経路を通せる flow（`/charm` を MCP bracket 化・MCP write・将来 install）で、既存 loader/validator を**使い捨て registry に対して**走らせる dry-run gate。通れば live に atomic swap、落ちれば **live の registry は無傷**。ただし `import()` は module top-level を即実行するため、検出できるのは**機械的失敗（transpile/import/validate）のみ**で、top-level 副作用（timer/global/DOM/Tauri）は隔離されない。true な host 隔離には side-effect-free authoring 契約（soft）か isolated-js が要る。

### 2. heavy sandbox（`isolated-js`）は trust model 移行時まで deferred

`SES（in-process）は無限ループ/OOM を止められない`（Hardened JS 公式: "does not protect the availability of a program"）。よって「とりあえず SES」は安全の実利ゼロで認知負荷だけ増える。正直な選択肢は「信頼ローカル（何もしない）」か「フル heavyweight（Worker+SES+RPC or QuickJS-WASM）」の二択で、現条件では前者が正解。これは `scene-execution-sandbox.md`「isolated-js は future」「community の trusted-main-thread-js は配布しない」と整合し、`pack-execution-classes.md` の executionClass 設計を前提にする。

### 3. snapshot の対象と単位

- 含む：`packs/**`、`config.json`、`init.js`。除外：**`journal/` / `memories.md`（住人の経験・不可侵）**、`cohabitation.json`（同棲時間 runtime state）、`last-startup.json`、`sdk.d.ts`、`.history/`、`.charminal-snapshots/`、`.staging/`、`tmp`。
- 単位：whole-tree の atomic generation（config↔pack の整合は一括でしか保証できない）。**契機は watcher 駆動の確定状態ごと**（write primitive は `/charm` 等に迂回されるため。後述）。file 単位の**部分復元**も機構側で提供（lazy.nvim `:Lazy restore <pack>` 流）。
- **restore は full-scope 完全置換**：`discover_user_pack_entries` は FS スキャンなので、overlay copy では残った壊れ pack が再発見される。restore は「対象 scope を generation と bitwise 一致」させ、**generation に無い in-scope path は削除**する（手順は dir rename 不可＝ENOTEMPTY のため **per-file atomic write + 深さ優先削除**）。`journal/` `memories.md` `cohabitation.json` は常に preserve。
- **config.json は restart-to-apply**：config は起動時1回読みなので、外部編集・restore による config 変更は runtime に hot-apply されない。Charminal 自身の UI/MCP からの config 変更は write 時に registry へ即同期される（＝外部編集・restore のみの論点）。restore 後に config を registry へ reconcile して restart 不要化するのは **P2 候補**。
- **init.js は watcher hot reload**：watcher は `packs/**` と `init.js` を trigger 対象にし、`init.js` は保存 / 復元後に `reloadInitScript()` で再実行される。restore UX は full-replace 後の整合性のためアプリ再読み込みを選べるが、通常の init.js 編集は再起動も手動 reload も不要。
- **hot-reload は structured 結果を返す**：現行 `reloadPack` は `Promise<void>`・dev-log のみで、`last-startup.json` は startup だけが書く。watcher 駆動 generation の known-good 判定には、hot-reload を `Promise<ReloadResult[]>` 化して generation に結合し、`reloadResults` を manifest に保存する（hot-reload 失敗の犯人名指しもここから。startup 専用 report と decouple）。撮影→reload→known-good は serialize＋hash 検証して race を防ぐ。
- **known-good の確定元は変更種別で分かれる**：`packs/**` 変更＝hot-reload の `reloadResults`、`init.js` 変更＝init reload の結果、**config を含む変更＝次 startup の validation**。config は起動時1回読みなので、その generation は `knownGood=false`/`loadOk=null`（未確認）とし、startup が clean なら known-good 化する。
- **known-good は「その generation が捉えた tree の load 結果」**で付与（別 mutation 後の load を前 generation に誤帰属させない）。watcher 駆動では generation＝確定後 tree＝直後 load の対象なので時点ずれが構造的に消える。
- 履歴は `~/.charminal/.charminal-snapshots/` の git dir（watch 外・load されない＝編集面の外。pack が自分を壊しても履歴は生存。旧 `.history/` は移行せず、存在しても snapshot 対象外）。**watcher の Rust callback で `.history/` `.charminal-snapshots/` `.staging/` `tmp` を drop**（event flood と snapshot→watcher→snapshot 無限ループを防ぐ）。

### 4. rollback は「宣言 / 内容」のハイブリッド

`config.json` は既に宣言的 single source of truth（`single-active-config-picks.md`）なので restore は宣言を戻す。`packs/**` / `init.js` は手続き的・内容なのでバイト列を materialize で戻す。**ただし `journal/` と `cohabitation.json` は宣言の外に置き、再現も reset もしない**——presence は「宣言から再現できない歴史的状態」に依存する（`feedback_journal_emotional_not_mechanical`、living-system 連続性）。Charminal は「設定は宣言的・経験は歴史的」の非対称を意図的に持つ。

### 5. 対称性 — user にも AI にも公開

snapshot/restore は Rust commands を choke point に、**SDK `ctx.history.*` ＋ MCP `history_*` ＋ `/charm:history`** へ等しく公開（`SELF_REFERENTIAL_MCP`）。「住人 AI が自分で壊して自分で戻す」が killer use case。

### 6. marketplace 移行の seam（計画済だが先・審査モデル未定）

trust model が非信頼マーケットプレイスに移行する計画を考慮し、**安く焼ける seam だけ今入れる**（sandbox 本体は移行時に実装）：

- `executionClass × source` 軸分離を維持（curated/open 両対応）。dry-run はこの軸で dispatch し、**「常に in-host load」と実装しない**（非信頼コードを検証目的で in-host 実行する穴を防ぐ）。
- install/update/uninstall を snapshot trigger に含める。
- `pack-lock.json` provenance（version + content hash + review id）の接続口を snapshot index に持つ（`pack-execution-classes.md` の registry integrity に接続）。完全性レイヤは rollback と直交し、registry 時代に有効化。

## なぜこの形か（rationale の核）

- **trust model が安全予算の使い道を決める**。信頼ローカルでは recovery が正解、非信頼では isolation が正解。Charminal は現状前者、将来後者へ——だから「今 recovery、seam を保って sandbox は移行時」。
- **large-diff-must-pay / cognitive-load**：snapshot store は自社コードで end-to-end に読める1層、毎日の authoring loop で即座に元が取れる。heavy sandbox は存在しない脅威への大差分。
- **production-over-dev**：git2 vendored（libgit2 静的リンク）でシステム git 非依存。git dir は `~/.charminal/.charminal-snapshots/` に分離（将来の pack 共有 repo と衝突しない）。詳細は [`git2-embedded-snapshot-store.md`](git2-embedded-snapshot-store.md)。

## 関連

- `pack-execution-classes.md`（executionClass × source の軸）
- `scene-execution-sandbox.md`（local trusted / isolated-js は future）
- `bundled-pack-immutability.md`（復旧対象は `~/.charminal` のみ）
- `single-active-config-picks.md` / `explicit-over-implicit-ugc.md`（config＝宣言的 source of truth）
- `living-system-core-shell.md`（固い核と生きた表層 / 関係の連続性）
- `presence-contract-loud-unavailable.md`（壊れは loud に legible に）
- `cognitive-load-design-lens.md` / `mcp-trust-tiers.md`

## 改訂履歴

- 2026-06-30 rev.10: init.js hot reload 実装に合わせ、config.json と init.js の apply 方針を分離。通常の init.js 保存 / 復元は watcher hot reload 対象、config.json は引き続き startup validation 対象。
- 2026-06-06 rev.9: storage を full-copy から git2（libgit2 vendored）に移行。content-addressed store（P3 目標）が解決。cohabitation を config.json から `cohabitation.json` に分離（baseline skip の正確化）。config.json は git 追跡するが watcher trigger 対象外（設定変更のノイズ防止）。prune は互換 no-op、一覧を最新 50 件に制限。詳細は `git2-embedded-snapshot-store.md`。
- 2026-06-02 rev.8: P1 plan 5次レビュー反映。「何を決めたか」冒頭に MVP（P1）と later（P2〜P4）の線引きバナーを追加（本文の robust 設計記述を later 目標として明示）。
- 2026-06-02 rev.7: manual mark_good を P3 に復活（軽量版：pin して prune 保護＋restore 候補強調。auto-known-good＝P4 とは独立）。
- 2026-06-02 rev.6: phasing 調整。content-addressed store を P3 に繰り上げ、manual mark_good を一旦廃止。P1 実装計画を作成。
- 2026-06-02 rev.5: MVP を簡素化。known-good 自動判定・content-addressed store・dry-run gate を P4 に後退させ、MVP は full-copy の timeline byte-history undo（health は advisory）に割り切る。restore full-replace・watcher filter・exclusions・path guard・restart-required・destructive 確認 は維持。
- 2026-06-02 rev.4: 3次 review 反映。hot-reload 失敗の犯人名指しを最新 generation の `reloadResults` に（R3-F1）、撮影→reload→known-good を serialize＋hash 検証（R3-F2）、config/init-only generation は startup validation で known-good 確定（R3-F3）、restore に path-type conflict 解消ステップ（R3-F4）。
- 2026-06-02 rev.3: 2次 review 反映。hot-reload を `Promise<ReloadResult[]>` 化し generation に load 結果を結合（R2-F1）、当時の config/init apply 方針と config-reconcile P2 候補を明記（R2-F2、rev.10 で init.js は watcher hot reload 前提に更新）、staging commit 後の手動 apply 経路（R2-F3）、full-restore を per-file atomic + 深さ優先削除に（R2-F4）。
- 2026-06-02 rev.2: external code review 反映。snapshot 機構を watcher 駆動の確定状態 generation（writer-agnostic）に pivot、保存を content-addressed 化、restore を full-scope 完全置換に、known-good を捉えた tree の load 結果に再定義、dry-run「live 無傷」→「registry 無傷」+ side-effect 注記、watcher 除外を Rust 側 filter に、当時の init.js restore apply 方針を明記（rev.10 で hot reload 前提に更新）。
- 2026-06-02 rev.1: 初版。recovery 背骨 + 軽量 dry-run、heavy sandbox は trust model 移行まで deferred を決定。詳細 spec は design-record `2026-06-02-pack-rollback-sandbox-design.md`。
