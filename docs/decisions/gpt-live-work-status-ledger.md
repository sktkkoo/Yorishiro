# GPT Live Work Status Ledger — 作業状態の会話向け投影設計

**Status**: accepted — Phase 1 domain ledger implemented（Phase 2 / 3 は protocol 実測・追加設計待ち）
**Last updated**: 2026-08-01

## TL;DR

GPT Live（realtime voice）は会話・意図確認・進捗説明を担当する「受付」であり、作業の
状態は持たない。委任した仕事の実行上の正本は Main Agent / harness が持つ。host 所有の
**Work Status Ledger（作業状態台帳）** は、その状態を会話向けに投影し、安定した work ID・
状態遷移・構造化 event・sanitize 済みの短い自然言語要約だけを voice 層へ渡す。raw terminal
log は台帳に一切入れない。既存の app-server 共有・thread targeting・
approval ownership（[codex-realtime-voice.md](codex-realtime-voice.md)）は一切変更しない。

> **実装注記**: 設計承認前の prototype は human review 後に Phase 1 の下書きとして採用し、
> `src/runtime/work-status-ledger/` へ命名と境界を揃えて実装した。protocol adapter と
> GPT Live 配線は未実測の event を仮定せず、Phase 2 / 3 まで実装しない。

## 実測済みの protocol 挙動と、app 側提案の区別

本 doc は次の 2 種類の記述を厳密に区別する。

**【実測済み】** — Codex 0.145.0 / 0.146.0 で実測し [codex-realtime-voice.md](codex-realtime-voice.md)
に記録済みの protocol 挙動。本 doc はこれを前提として使うだけで、再検証も変更もしない。

- `thread/realtime/start` は呼び出し元 bridge client を対象 thread へ自動 subscribe する
- realtime transcript / handoff / 通常 turn event は TUI 相当 client と bridge client の双方へ届く
- approval request は全 subscriber へ同じ request ID で fan-out され、first-response-wins で解決する
- `thread/loaded/list` の配列順に active thread の意味はない
- Codex v2 Thread schema は subagent の場合だけ `parentThreadId` を設定する

**【提案】** — Work Status Ledger に関する記述は全て app 所有の新規設計であり、Codex protocol
には対応物がない。特に注意すべきは、**Codex protocol には「task」という粒度の event が
存在しない**ことである。protocol が持つのは thread / turn / item / approval であり、
「委任 task」への対応付けは全面的に app 側（protocol adapter）の解釈になる。turn event や
subagent thread event が task 追跡に十分な情報を運ぶかどうかは**未実測**であり、Phase 2 の
着手前に実測で確定する（§実装計画）。

## Goals / Non-goals

### Goals

- GPT Live から作業エージェントへ委譲した仕事に、生成時採番で lifecycle を通じて不変な
  **work ID** を与える
- created / running / approval-required / completed / failed / cancelled の状態機械と
  不変条件を固定する
- voice 層が GPT Live の応答生成 context として安全に渡せる形（sanitize 済み短文 +
  構造化 status）で publish する。完成した読み上げ文は生成しない
- approval ownership（TUI 正本）を壊さずに「承認待ちである」という事実を表現する
- protocol の観測と domain state を adapter で分離し、未確認の Codex event に依存しない

### Non-goals

- voice UI だけでの approval 確定（別 decision。台帳は保留の事実を写すだけ）
- 台帳からの作業の実行制御（agent の起動・中断・入力）。PTY observation-only 境界
  （[critical-constraints.md](critical-constraints.md) §1）は不変
- app-server / thread targeting / realtime start 手順の変更
- 再起動を跨ぐ task の永続化（v1 は process lifetime。§永続化）
- Claude / OpenCode / shell tab への拡張（GPT Live 自体が Codex Main Agent 限定）
- semantic expression / gesture との同期（`feat/realtime-performance-cues` の別トラック）

## なぜ GPT Live は受付で、作業状態台帳が必要なのか

GPT Live は realtime conversation であり、状態の保管庫として使えない。

1. **conversation history は状態機械ではない**。「さっき頼んだあれどうなった？」に答える
   ために転写履歴を検索するのは不確実で、model の要約は hallucination を含みうる。
   invariant 10「structured task state で自然な conversation history を置き換えない」の
   裏返しとして、**conversation で structured state を置き換えることもしない**。
2. **voice session は作業より短命**。stop / remote close / session 切替を跨いで作業は
   続く。再接続した GPT Live が正確に進捗を語るには、session の外に正本が要る。
3. **実行主体（Main Agent。現在のfirst-class実装はCodex）にも正本を置けない**。agent の内部状態は
   protocol 越しにしか観測できず、thread の粒度と「マスターが委任した仕事」の粒度は
   一致しない（agent team では 1 委任 = 複数 subagent thread になりうる【実測済み】）。

したがって、会話は GPT Live、実行とその正本は Main Agent / harness、**会話向けの作業状態は
host 所有の台帳**、という三分担にする。台帳は harness の実行状態を会話へ投影する read model
であり、実行上の正本を置き換えない。既存の host-owned store 群（WorkspaceAttentionStore 等）と
同じ層に置き、module registry key `work-status-ledger:store` の singleton とする【提案】。

## Domain model と安定 work ID

【提案】台帳の domain 型は protocol から完全に独立させる。thread ID・app-server message・
raw log は domain に持ち込まず、protocol 側の観測は adapter が work ID へ解決してから
反映する（prototype `types.ts` の構造を採用）。

```
DelegatedWork {
  id: string                 // 生成時採番、lifecycle を通じて不変（"work-1", "work-2", …）
  summary: string            // sanitize 済み・最大 120 字の人間可読要約
  status: WorkStatus
  note: string | null        // 最新の状態変化の短い注記（sanitize 済み・最大 200 字）
  sessionId: string | null   // 実行中の session（不明なら null）
  createdAt / updatedAt: number
  pendingApprovals: string[] // 未解決 approval の識別 key。非空 ⇔ status = approval-required
}
```

- **ID の安定性**: ID は `create()` 時に単調採番され、状態がどう変わっても不変。
  voice 層・adapter・将来の UI は全てこの ID で参照する。ID の scope は app process
  （§永続化）。thread ID を ID に流用しない — thread は subagent 分裂・unload で
  揺れる上、「委任の粒度」と一致しないため。
- **summary は必須**: sanitize 後に空になる summary（escape sequence だけ等）は
  委任として受理せず throw する。voice と UI が参照できる人間可読な task identity を
  必ず残すため。
- **task → thread の対応表は adapter の私物**: domain には置かない。protocol の形が
  変わっても domain と test が無傷で残るようにする。

## 状態遷移と不正遷移の扱い

【提案】基底状態は `created / running / completed / failed / cancelled` の 5 つ。
公開 status の `approval-required` は独立の基底状態ではなく、
**「running かつ pendingApprovals 非空」から毎回導出する overlay** とする。

```
created ──→ running ⇄ (approval-required)   ※導出。基底は running のまま
   │           │
   │           ├──→ completed ┐
   │           ├──→ failed    ├─ terminal（以後すべての変更を拒否）
   └──────────→├──→ cancelled ┘
   （created から直接 failed / cancelled も可：起動失敗・着手前取消）
```

- **approval-required を導出にする理由**: 基底状態にすると「approval 中に turn が
  終わった」「複数 approval が重なった」で遷移が組合せ爆発する。導出なら
  running への復帰は approval が全て下りた瞬間に自動で成立し、複数 approval も
  Set で自然に表現できる。
- **created → completed は許可しない**: running を経ない完了は観測の取りこぼしを
  隠すため。adapter は完了を観測したらまず `markRunning` を通す。
- **不正遷移の挙動**: terminal 以後の全変更・running でない task への approval 積み・
  存在しない ID への操作は、**throw せず `false` を返して無視**する。adapter は
  protocol event の遅延・重複・順序逆転を避けられない（subagent unload との競合は
  実測済みの現実）ので、不正遷移は「例外」ではなく「観測のずれ」として静かに落とし、
  台帳の一貫性を優先する。一方 `delegate()` の空 summary は呼び出し側の bug なので
  throw で即座に露出させる — この非対称は意図的。
- **重複 approval key は no-op**（積み増さない）。fan-out で同じ request を複数回
  観測しても状態が壊れないため【実測済みの fan-out 挙動への防御】。
- **terminal 到達時に pendingApprovals を同時に消す**: 終わった task の承認保留は
  意味を失い、放置すると「承認待ち n 件」の集計を汚すため。

### 書き込み権限の分離

【提案】adapter に台帳の全書き込み API を渡さず、**観測 port（3 操作）だけを見せる**:
`markRunning` / `holdApproval` / `releaseApproval`。work の作成（`create`）と終端
（`complete` / `fail` / `cancel`）の判断は host / voice 層に残す。protocol 観測が
「仕事が終わった」を確定できるかは未実測であり、確定できる event が実測で見つかった
段階で port を広げる方が、最初から全権を渡して後から狭めるより安全なため。

## Event / snapshot モデル

【提案】読み手の性質に合わせて二系統を publish する。

- **snapshot 購読**: `subscribe(listener)` は購読時に現在の snapshot を即時通知し、
  以後は変更ごとに通知する（repo の store 慣習に一致）。snapshot は publish ごとの
  runtime でも deep-freeze した不変 value object で、`work`（作成順）・`activeCount`
  （非 terminal 数）・`updatedAt` を持つ。work item、`pendingApprovals`、event も freeze し、
  一つの subscriber が後続 subscriber の観測値を書き換えられないようにする。
  **再接続した GPT Live はこれ 1 発で全体像を復元できる**。
- **work ID lookup**: `get(workId)` は保持中の個別 snapshot を返す。snapshot の work と
  event はどちらも同じ不変 `workId` で相関できる。
- **event 購読**: `subscribeEvents(listener)` は `work-created` と
  `work-updated { workId, work, previousStatus }` を流す。過去分の replay はしない —
  取りこぼしの補償は snapshot 側の責務であり、event 側に履歴 buffer を持つと
  raw log 排除の原則（§sanitize）に反する蓄積が始まるため。
- `previousStatus` は**公開 status**（導出後）で報告する。GPT Live が
  「承認待ちが解けて再開した」のような事実差分を、内部の基底状態を知らずに理解できる。

## 自然言語要約と構造化データの二層

【提案】voice 層へ渡すのは常に **構造化 status + sanitize 済み短文** の組であり、
どちらか片方ではない。ただし、これは完成した発話台本ではなく GPT Live が自然な応答を
組み立てるための事実 context である。

- 構造化側（`status` / `pendingApprovals` / `activeCount`）は、GPT Live が
  「今なにが動いてる？」に決定論的に答えるための骨格。集計・列挙・分岐は
  ここから機械的に決まる（決定論的な処理を AI 任せにしない）。
- 自然言語側（`summary` / `note`）は、骨格に載せる肉。「build を通す — 全 gate green」
  のような短い事実である。必要なら GPT Live が引用できるが、原文の読み上げを要求しない。
  文を書くのは委任時の呼び出し側と adapter であり、台帳は sanitize と上限だけを強制する。

voice 層は snapshot / event を受け取っても `voice_say` や別の TTS へ直結せず、イベントごとの
定型文も再生しない。会話に必要な範囲だけを GPT Live の非表示 context として提示し、
**話すかどうか・いつ話すか・どのように言い換えるかは GPT Live 自身が決める**。これにより
現在の realtime conversation の自然さを維持する。承認待ち等で能動的に割り込む方針は、
状態伝達方式と合わせて Phase 3 で別途決定する。

この二層により、invariant 10 の両面 — 会話の自然さは GPT Live が、事実の正確さは
構造化状態が担う — が同時に成立する。

## Raw terminal log の排除

【提案・issue #80 完了条件】台帳は「raw terminal log を voice 層へ流さない」**境界
そのもの**として設計する。

- 台帳が保持する自然文は summary（≤120 字）と note（≤200 字）の 2 欄だけ。
  terminal output の転記・全履歴・stack trace を入れる欄が存在しない。
- 全ての自然文は必ず sanitize（§security）を通ってから格納される。
- event に履歴 replay がないため、「event を溜めれば log になる」経路もない。

なぜ排除するか: raw log は (1) escape sequence / 制御文字で読み上げ・表示を壊す、
(2) realtime session の context を浪費する、(3) secrets や機微情報を無差別に運ぶ、
(4) GPT Live に「log の解釈」をさせて hallucination の種になる。log が見たければ
TUI がそこにある — それが TUI を残した理由である。

## Approval ownership と approval-required の表現

**【実測済み】** approval request は同一 thread の全 subscriber へ同じ request ID で
届き、first-response-wins で解決する。bridge は自動応答せず、承認 UI の正本は TUI
（[codex-realtime-voice.md](codex-realtime-voice.md) invariant 5）。

【提案】台帳はこの ownership に**一切割り込まない**:

- 台帳・観測 port・voice 層のどこにも「承認へ応答する」API を作らない。
- adapter は approval request の観測で `holdApproval(taskId, approvalKey)`、解決の
  観測（TUI が応答した結果の event）で `releaseApproval` を呼ぶ。台帳は
  **保留の事実を写す鏡**であり、解決の主体ではない。
- `approvalKey` は adapter 内で server request ID から導く識別子とする（具体の導出は
  Phase 2 で protocol 実測とともに確定）。domain は key を不透明文字列として扱い、
  protocol の request ID 形式に依存しない。
- GPT Live は approval-required を観測したら「TUI で承認待ちになっている」と**案内**
  できる。承認の代行はできない。voice からの承認確定は将来の別 decision
  （non-goal）であり、その際も first-response-wins との競合設計が先行条件になる。

## App-server / thread targeting 境界

【提案 = 現状不変の宣言】Work Status Ledger は接続 topology に何も足さない。

- app-server への**新しい client を追加しない**。adapter の観測は既存 bridge client が
  受ける event stream に相乗りする（bridge client は `thread/realtime/start` で対象
  thread へ自動 subscribe される【実測済み】）。`thread/resume` は追加しない —
  却下済みの二重 resume を台帳の都合で復活させない。
- thread targeting（top-level 選定・fail closed・subagent 除外）の手順に触れない。
  台帳は「どの thread と話すか」を知らないし、決めない。
- domain に thread ID を持たないため、targeting 仕様が変わっても台帳は無傷。
- voice が接続していない間の観測は**行わない**（v1）。bridge 非接続時に task が
  進んだ場合、台帳は次回接続時の観測まで古い状態を示す。常時観測用の別 client を
  立てるかは将来判断（§未解決の判断 6）。

## 永続化・lifetime・再接続・cancel

【提案】

- **永続化**: v1 はしない。台帳は in-memory singleton（hot-data 経由なので dev の
  hot reload は生き延びる）。app 再起動で消え、work ID の一意性 scope も process 内。
  委任作業自体が process 内の agent session に紐づくため、台帳だけ永続化しても
  再起動後に指す先がない — 永続化は「作業の再接続」を設計する時に一緒にやる。
- **retention**: terminal 状態の task は直近 20 件だけ snapshot に残し、超過分は
  古い順に破棄する。active な task は件数によらず破棄しない。voice の「さっきのあれ」
  に答える程度の記憶で十分で、履歴 DB にしないため（20 は暫定値、§未解決の判断 5）。
- **再接続**: GPT Live の stop / remote close / 再接続で台帳は何も変えない。
  再接続した voice 層は snapshot を読み直すだけで最新状態に追いつく。event の
  取りこぼし補償はしない（snapshot が正）。
- **cancel の意味**: 台帳の `cancel()` は**記帳のみ**であり、実行中の agent の作業を
  中断しない。作業の中断は TUI / 既存の session 操作の管轄で、台帳から実行制御への
  経路は作らない（observation-only の台帳版）。「voice で頼んだら実際に止まる」を
  作るかは別判断（§未解決の判断 3）。

## Security / text sanitize

【提案】台帳へ入る全自然文（summary / note）は単一の sanitize 関数を通す:

1. ECMA-48 escape sequence（7-bit / 8-bit CSI、control string、single-char escape）を除去。
   parameter byte は `0x30–0x3f` の全域（colon / private marker を含む）を扱う
2. C0 / C1 制御文字と DEL を空白化（改行・タブ含む）
3. 連続空白を畳んで一行化し、上限長（summary 120 / note 200）で "…" 丸め
4. 結果が空なら「情報なし」と扱う（summary は拒否、note は null）

これは表示崩れ対策であると同時に、**escape sequence smuggling への防御**でもある —
agent 出力由来の文字列が UI や読み上げへ渡る際に、端末制御・OSC による副作用を
持ち込ませない。加えて:

- 台帳は新しい network surface を作らない。app-server endpoint は引き続き Rust host
  内でのみ解決され、WebView / pack / LAN へ公開しない【既存 invariant 8 の継続】。
- 台帳 API を pack / persona へ公開しない（v1）。公開するなら MCP trust tier の
  枠組みで別途判断する。
- sanitize は機微情報の redaction では**ない**。秘密が summary に書かれれば残る。
  防御線は「raw log を入れない」構造側にあり、redaction が要る場合は将来の課題。

## 統合の縫い目（integration seams）

【提案】縫い目は 3 箇所で、依存方向は常に「protocol → adapter → domain → voice」:

1. **module registry**: `work-status-ledger:store` の singleton として `getOrInit` で生成する。
   prototype の旧 `task-coordinator:store` 名は採用せず rename した。
2. **protocol adapter（Phase 2、未実装）**: `CodexRealtimeClient` が受ける server
   notification を観測し、thread/turn/approval event を work ID へ解決して観測 port
   （3 操作）を呼ぶ。task ↔ thread の対応表は adapter 内部に閉じる。
   **どの event を使えるかは Phase 2 冒頭の実測で確定する**（protocol に task 粒度の
   event はない【前掲】）。
3. **voice 層（Phase 3、未実装）**: GPT Live の会話 pipeline が snapshot / event を
   完成した台本としてではなく、応答生成の事実 context として参照する。
   読み、進捗説明・承認待ち案内に使う。**realtime session への状態注入方法
   （conversation item として送るのか、応答生成時に参照させるのか）は未実測・未設計**
   であり、Phase 3 の設計判断とする。委任の起点（誰が `create()` を呼ぶか）も
   §未解決の判断 1 で承認を得てから配線する。

## 実装計画（phased）

- **Phase 0 — 本 doc の承認（完了）**: 状態機械・不変条件・§未解決の判断への回答を確定する。
  issue #80 の合意（設計 → 人間確認 → 実装）に基づき、**承認前に実装を進めない**。
  既存 prototype の扱い（採用 / 手直し / 破棄）もここで確定。
- **Phase 1 — domain 台帳（実装済み）**: `WorkStatusLedgerStore` + sanitize + unit test。
  実装は prototype を review し、Work Status Ledger / work ID 命名へ揃えた。gate:
  tsc / biome / vitest green。
- **Phase 2 — protocol adapter**: まず Codex 実測（turn / item / approval event が
  task 追跡に十分か、approvalKey の導出、subagent thread と委任の対応）。実測結果を
  本 doc に追記してから adapter を実装し、観測 port 経由で配線。fake protocol event
  での unit test + 実機で approval 保留 → TUI 解決 → running 復帰を確認。
- **Phase 3 — GPT Live 配線**: 委任の起点と読み上げ UX。realtime session への状態
  注入方法を実測・設計してから実装。実機で「委任 → 進捗質問 → 承認待ち案内 → 完了報告」
  の一連を確認（dev 検証だけで完了宣言しない）。
- **Phase 4 以降（scope 外の種）**: 永続化と作業再接続、voice approval、常時観測
  client、Voice Summary との音声 ownership 整理（既存 doc の未決事項）。

## Tests / invariants

unit test で固定する不変条件（prototype の test が既に大半を写している）:

1. ID は採番後不変で、terminal 到達後も `get` で参照できる
2. summary は sanitize され、可読文が残らない委任は throw で拒否される
3. created → running → completed が通り、terminal 以後は全操作が `false`
4. created から直接 cancel / fail できる（着手前取消・起動失敗）
5. approval-required は pendingApprovals から導出され、全解除で running へ自動復帰
6. running でない task へ approval を積めない／重複 key は no-op
7. terminal 到達で pendingApprovals が空になる
8. note の raw log（escape sequence / 改行）が sanitize される
9. event は `previousStatus` 付きで公開 status の遷移列を正しく報告する
10. snapshot / work / pendingApprovals / event は runtime deep-freeze され、購読時即時通知・
    変更毎通知・publish 毎に不変 value object。subscriber 間で mutation が伝播しない
11. terminal task は上限 20 で古い順に prune され、active は残る

adapter 実装時に追加する不変条件（Phase 2）: 重複 event で状態が壊れない、
未知 thread の event が無視される、approval 解決の観測漏れが snapshot 再同期で回復する。

## 未解決の判断（マスター承認が必要）

1. **委任の起点**: `create()` を呼ぶのは誰か。候補: (a) voice 層が GPT Live の
   委任発話を検出して host が記帳、(b) Main Agent が MCP tool（yorishiro-mcp）で
   自己申告、(c) 両方。(b) は agent に台帳書き込み面を公開することになり、
   MCP trust tier との整合確認が要る。推奨は「v1 は (a) のみ、(b) は需要が立ってから」。
2. **GPT Live への状態伝達方法**: snapshot を realtime session へどう見せるか
   （conversation item 注入 / 応答時参照 / 定期 context）。protocol 実測が先行条件。
   event の自動読み上げや定型文 TTS は採用せず、最終的な発話内容・タイミングは GPT Live に
   委ねる。そのうえで、承認待ち等の重要 event を応答開始の契機にするかは別途決める。
3. **cancel の実効性**: 台帳 cancel は記帳のみ（本 doc の提案）で良いか、
   「voice で止めてと言ったら実際に止まる」まで踏み込むか。後者は実行制御への
   経路を開くため、境界設計を別 decision に切るべきと考える。
4. **完了判定の主体**: `complete` / `fail` を観測 port に含めず host / voice 層判断に
   残す設計（本 doc の提案）で良いか。Phase 2 実測で「終了を確定できる protocol
   event」が見つかった場合に port へ昇格するか。
5. **感触値**: retention 20 件、summary 120 字、note 200 字は全て暫定。実機で
   読み上げてから帰納的に調整する（先に決め込まない）。
6. **常時観測**: voice 非接続時も台帳を追従させる観測専用 client を将来立てるか。
   v1 は「接続時のみ観測」で出す提案だが、「再接続したら台帳が古い」体験の許容度は
   実機で確認したい。
7. **prototype の扱い（解決済み）**: prototype を Phase 1 の下書きとして採用し、review で
   不正な `created → completed` を拒否するよう修正した。旧 Task Coordinator 命名は残さず、
   `src/runtime/work-status-ledger/` と `work-status-ledger:store` に統一した。

## 関連 reference

- [codex-realtime-voice.md](codex-realtime-voice.md) — 実測済み protocol 挙動と invariant の正本
- [critical-constraints.md](critical-constraints.md) §1 — PTY observation only
- issue #80 — feat(realtime): add a work status ledger for delegated work
- `src/runtime/work-status-ledger/` — Phase 1 domain ledger
- `src/runtime/codex-realtime/` — bridge client（adapter が相乗りする観測面）
- `src/runtime/workspace-attention/` — host-owned store の既存慣習
