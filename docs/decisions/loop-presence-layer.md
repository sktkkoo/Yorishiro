# Loop Presence Layer — 自律ループを「住まわせる」観察基盤

> このファイルは「**自律 agent loop（自動実行 / Loop Engineering）を Charminal にどう取り込むか・どこまでやるか**」を考える時に読む。対象：dev / AI。

**Status**: active（scope 確定 / phase 1 実装中）
**Last updated**: 2026-06-09

## TL;DR

Charminal は自律 coding loop（Claude Code / Codex 等の long-horizon 自動実行）を **観察・可視化する presence layer** として取り込む。ループを **駆動する orchestrator にはしない**。進行・停滞・危険操作・検証結果を住人の身体／空間／ログとして「読める」状態にするのが価値。

phase 1 の scope は 2 つだけ：(1) **観察源の抽象化**（loop の構造化 stream を PTY 出力と同格の `ObservedEvent` として ingest）、(2) **loop-lifecycle event 語彙**（6 phase を trigger が match できる first-class event として SDK と MCP に対称公開、CC/Codex 両対応）。

## 何を決めたか

### 1. positioning：execution engine ではなく presence layer

Charminal はループ実行を所有しない。実行は既存の harness（Claude Code / Codex / ralph 系 / `/loop` / 外部）が回し、Charminal はその **構造化 stream を観察**して presence に変換する。長時間ループが「どこで何をしているか分からない黒箱」になる問題を、居住空間として読める状態にするのが狙い。単なる monitoring dashboard に mascot を乗せる方向（= "CLI を可愛くする"）は明示的に避ける（[presence-over-spectacle.md](presence-over-spectacle.md)）。

### 2. loop event は agent-declared（host 推論ではない）

loop の lifecycle は host が PTY/hook から推論せず、**agent 自身が MCP tool `loop_announce` で自己申告**する。ループ境界（goal 単位の start / iteration / completion）を正しく知るのは agent 自身だけであり、turn ≠ loop iteration なので hook からの推論は意味的に誤る。agent が tool を呼ばなければ Charminal は loop を観察しない（**graceful absence**。観察境界の通り、Charminal は agent の reasoning loop の内部に手を伸ばさない＝[critical-constraints §1](critical-constraints.md)）。self-referential MCP「経路の有無が境界になる」と一致する。

### 3. CC/Codex 両対応は `mcp_injection` に乗せる（`lifecycle_hooks` ではない）

Codex は `lifecycle_hooks: false`（[agent-adapter.md](agent-adapter.md)）。loop を hook 由来にすると Claude Code 専用化する。両 agent とも `mcp_injection: true` なので、**MCP `loop_announce` を唯一の ingest 経路にすることで CC/Codex を統一**する。tool は両 agent で同一。差異は「どの agent が報告したか」の attribution だけで、これは host 側で stamp する。

### 4. 観察源は `ObservedEvent` 同格で足す（formal な `ObservationSource` trait は deferred）

`LoopLifecycleEvent` を `PtyOutputEvent` と並ぶ `ObservedEvent` の sibling として追加し、`Perception` の ingest method 経由で同じ EventBus pipeline に流す。これで「PTY と同格の observable source」が型レベルで実現する。全 producer（PTY reader / hook bridge / idle timer / loop announcer）を共通 interface に括る refactor は **しない**——「2 case は enum、3 case で trait」（[agent-adapter.md](agent-adapter.md) の論法）と同じく、formal な `ObservationSource` 抽象は 3 本目以降の structured stream が現れた時の投資。今は YAGNI。

### 5. 対称公開：`ctx.loop.announce`（SDK / amenity）+ `loop_announce`（MCP）

[Symmetry principle](../../CLAUDE.md) に従い、同じ primitive を pack 作者（SDK）と住人 AI（MCP）に出す。SDK 側は **AmenityContext のみ**に `loop: LoopAPI` を置く（announce は機能的な観察注入であり motion-free。persona は表現に専念）。MCP 側 `loop_announce` は両 agent から呼べる。

### 6. agent 種別は host が stamp（caller に詐称させない）

`LoopLifecycleEvent.agent` は caller が指定せず host が埋める。MCP 由来なら active terminalAgent（`"claude"` / `"codex"`）、SDK pack 由来なら `null`。`SyntheticEvent.source` が host-bound で改ざん不可なのと同じ原則。

## なぜそう決めたか

- **観察優先は Charminal の核**。実行 engine を内蔵すると PTY observation-only（[critical-constraints §1](critical-constraints.md)）の polarity が反転し、large diff も体験軸で割に合わない（[Working principles の large-diff 原則](../../CLAUDE.md)）。観察に閉じれば既存 architecture の素直な延長で済む。
- **away mode との相性**。ループ起動後に user が一歩下がる局面でこそ presence が「主たる interface」になる。観察源があれば住人が黒箱を felt にできる。
- **2/4/6 はいずれも「境界を作らず面を作らない」設計**（host 推論しない / hook 依存しない / 詐称させない）で、grey zone を残さない既存 discipline と一貫。

## 検討したが却下した代替案

- **host が PTY/hook から loop 境界を推論**：却下。CC 専用化 + heuristic 脆弱 + turn ≠ loop。
- **loop event を既存 `synthetic` event に流用**：却下。first-class kind の方が type-safe / discoverable で、MCP tool 側で phase enum を validation できる。
- **`ctx.loop` を PersonaContext にも置く**：却下。announce は機能的観察注入なので motion-free な amenity が正。
- **caller が agent 種別を指定**：却下。詐称可能。host stamp に統一。
- **Loop Run Record / orchestrated execution を今 phase で実装**：却下（下記 scope 外）。

## この決定の implication / 制約

- **scope 外（明示的に deferred）**：
  - **Loop Run Record**（goal / budget / stopCondition / iteration の runtime *制御* state）。stopCondition / budget は control 概念で、Charminal がそれを *enforce* すると観察から orchestration へ静かに越境する。今は持たない。
  - **Checkpoint / review-gate**（iteration ごとの復元点 + test/lint/build/diff gate）。
  - **Orchestrated execution**（Charminal が agent process / worktree / validation を起動・監督）。これは観察ではなく **所有**。stage 1–3（観察 + 可視化 + checkpoint）とは別 product 判断で、**default no**。「Charminal は観察する、実行ループを所有しない」境界は gradient ではなく **型レベルの categorical line** として保つ。
  - **formal `ObservationSource` trait**（§4）と **repo-scoped recovery UI**（下記）。
- **fearless recovery の分離**：loop event は `history_*`（`~/.charminal` 側の pack/config/init rollback）に **一切 couple しない**（observe するだけ。restore を起こさない・represent しない）。自律ループが対象 project repo を変更する場合の復旧単位は **git branch / worktree / commit / stash** であり、これは「Charminal 自身の復元」とは **別軸**。将来 recovery を載せる時は両者を **別表示**する。`event.detail` は将来の repo-scoped recovery のために repo 変更の手がかり（changed files / commit SHA 等）を載せられる *余地* を残すが、loop event 自体は restore を triggered しない。
- **PTY observation-only 不変**（[critical-constraints §1](critical-constraints.md)）：loop event は観察 stream に流れるだけで、PTY write 経路を生まない。`loop_announce` は read/announce であり、[input-prefill-boundary.md](input-prefill-boundary.md) の任意テキスト書込み禁止に抵触しない。
- **trust tier**：`loop_announce` は自己申告の benign announcement（destructive でも sensitive-read でもない）。[mcp-trust-tiers.md](mcp-trust-tiers.md) で `journal_write` 等と同列の announcement 系として扱う。
- phase 1 完了後、住人が `blocked-on-approval` / `failed` を felt に surface する persona reflex、away mode の attention 設計、repo-scoped recovery が次の検討対象になる（別 decision を起こす）。

## 関連 reference

- source（実装後）：`src/sdk/reaction.d.ts`（`LoopLifecycleEvent` / `LoopPhase`）、`src/sdk/context.d.ts`（`LoopAPI`）、`src/core/perception/perception.ts`（ingest）、`src/runtime/charminal-mcp/tool-handlers.ts`（`loop_announce` handler）、`src-tauri/src/mcp/tools.rs`（tool 登録）
- decision：[critical-constraints.md](critical-constraints.md) §1、[input-prefill-boundary.md](input-prefill-boundary.md)、[agent-adapter.md](agent-adapter.md)、[trigger-reaction-architecture.md](trigger-reaction-architecture.md)、[mcp-trust-tiers.md](mcp-trust-tiers.md)
- philosophy：`docs/philosophy/SELF_REFERENTIAL_MCP.ja.md`「経路の有無が境界になる」「対称性」、`docs/philosophy/INHABITED_CHARACTER_INTERFACE.ja.md`「観察の境界」

## 改訂履歴

- 2026-06-09: 初版。phase 1 scope（観察源の抽象化 + loop-lifecycle event 語彙 + CC/Codex 両対応）を確定。execution engine 化を scope 外に明示し、fearless recovery の二軸分離（Charminal 自身 vs 対象 repo）を forward note として記録。
