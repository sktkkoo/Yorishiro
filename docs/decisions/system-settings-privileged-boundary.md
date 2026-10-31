# System settings UI の privileged boundary

**Status**: active
**Last updated**: 2026-10-31

## TL;DR

`yorishiro-settings` は Pack authoring の見本ではなく、アプリ本体に同梱される
system-owned UI である。通常の UI Pack は `@yorishiro/sdk` と明示された host shim
だけを使い、Tauri/plugin や `src/**` を直接 import しない。

設定画面に残る直接 import は、host 所有の更新・VRM import・表示部品・ローカライズを
組み立てるための監査済み例外である。例外を一般 Pack の権限へ広げるには、別途
permission / isolation 設計が必要であり、この decision だけでは許可しない。

## 何を決めたか

### 1. `yorishiro-settings` は system-owned exception

`bundled-packs/ui/yorishiro-settings` は次の条件をすべて満たす特別な UI とする。

- app と同じ release / review / signature 単位で配布する bundled code
- manifest で `executionClass: "trusted-main-thread-js"` を明示する
- user override と同じ API 互換を約束しない
- source 内の privileged / internal import は conformance test の allowlist で監査する
- allowlist 追加は「設定 UI に必要」だけでは不十分で、SDK 昇格不能な理由をこの文書へ追記する

同じ id の user pack は bundled source の authority を継承しない。id は capability token
ではない。user fork は通常の local trusted UI Pack として扱い、supported authoring surface
は `@yorishiro/sdk` と明示された host shim に限る。

### 2. 監査結果

| 使用箇所 | 分類 | 結論 |
|---|---|---|
| `@tauri-apps/api/core` の `list_vrm_avatars` / `read_vrm_thumbnail` / `import_vrm` / `remove_vrm_avatar` | scoped metadata read + bounded embedded thumbnail read + file import/removal | privileged のまま。AppData/avatars 直下の検証済み catalog ID に限定した system settings 用 command で、通常 Pack capability には昇格しない |
| `@tauri-apps/plugin-dialog` | native file picker | privileged のまま。任意 file picker を UI Pack capability として開けない |
| updater / process relaunch | network update、署名検証、app replace、再起動 | system-only。Pack API にしない |
| `src/components/RestoreConfirmDialog` | app-level modal / reload UX | settings からの直接 import を除去。`ctx.history.restore()` の host-owned confirmation として維持し、Pack 向け component ABI にしない |
| Auto workspace | 目的・対象の委任、音声／文字の相談、結果の判断 | `src/components/AutoWorkspace` を App host が所有。旧 `AutonomySettings` と設定 Pack の component import は撤去。mutable autonomy API は SDK に昇格しない |
| `src/i18n/strings` | app 固有 settings / recovery 文言 | system content。汎用 SDK にしない |
| `src/runtime/history/describe-snapshot` | app 固有の snapshot 表示文言 | system presentation。history 操作自体は `ctx.history` へ公開 |
| `src/runtime/language/language` | app language の optimistic UI 解決 | system presentation helper。設定値の正本は `ctx.app.getConfig()` / `setLanguage()` |
| `src/runtime/user-pack-loader/config` | bundled Yori persona と agent の app 規約 | system policy。Pack authoring API にしない |
| bundled `simple-room/manifest.json` | null config の app default 表示 | bundled topology。Pack 間 import の一般契約にしない |
| `@tauri-apps/api/app` の version read | read-only app metadata | settings の直接 import を除去し、`ctx.app.getVersion()` へ公開 |
| `@tauri-apps/plugin-opener` の URL open | external side effect | settings の直接 import を除去。scheme / credential / length を host が検証する `ctx.app.openExternal()` へ公開し、user gesture から呼ぶ authoring contract とする |
| `src/bindings/tauri-commands` の snapshot binding | reversible state management。restore は destructive | settings の直接 import を除去。既存 `HistoryAPI` を `ctx.history` として UI Pack にも公開し、restore confirmation は host が所有 |

### 3. 通常 UI Pack の authoring contract

通常の UI Pack は次を守る。

- Tauri API / plugin、`window.__TAURI_INTERNALS__`、`src/bindings/**` を直接使わない
- app component、runtime helper、別 bundled Pack の manifest を import しない
- app metadata / external link / history は `ctx.app` / `ctx.history` を使う
- `openExternal` は user の明示操作（link/button）からのみ呼ぶ。mount 時や timer から開かない
- updater、process relaunch、native file picker、任意 IPC が必要なら Pack 実装を止め、host capability を別途設計する

現状の local UI Pack は main WebView realm で動くため、これは runtime sandbox ではなく
supported API contract である。community 配布や隔離済み UI Pack を有効にする前には、
manifest permission、host-side gate、audit、rate limit、user approval を実装する必要がある。
特に `openExternal` の HTTPS validator は `ctx.app` 経路だけの contract であり、same-realm
code から raw Tauri opener / IPC へ到達できる現状の authority を狭めるものではない。

### 4. 自動作業は App host が所有する（2026-10-31）

Auto の入口と作業画面はタイトルバーと `AutoWorkspace` に集約する。設定 Pack から
`AutonomySettings` を取り除き、app component を組み込む例外を終了した。設定 Pack の
raw IPC allowlist は拡張しない。自動作業の開始・停止・契約・共有ドラフト・操作の承認は
App host と native boundary の責務であり、通常 SDK に公開しない。

`settings-privileged-boundary.test.ts` は設定 Pack に app component import と
`runtime/autonomy` import がないことを検査する。表示モードの変更は実行権限を変更しない。
委任と承認の現行契約は [auto-workspace.md](auto-workspace.md) と
[autonomous-document-work.md](autonomous-document-work.md) に記載する。

#### 旧設定 widget の追加監査（2026-10-24、移行済み）

以下は旧UIの監査記録。widget の公開例外と画面構成は2026-10-31に廃止し、現行の実装指針には用いない。

ユーザーの「設定画面から自動作業を On/Off する」操作は、host 所有の
`AutonomySettings` を同梱設定画面へ組み込んで提供する。今回追加する internal import は
この一つに限定し、設定 Pack の raw `invoke` command allowlist は変更しない。

- component の props は表示言語のみ。設定 Pack は目的・対象フォルダ・許可操作や
  書き込み callback を渡さず、`runtime/autonomy/client` を直接 import しない。
- Off は進行中と将来の自動実行を停止する。On は host が保持する既存の合意を原子的に
  有効化し、UI が読んだ古い scope を書き戻さない。未合意なら設定 dialog を開くだけである。
- dialog を開く UI event に権限はなく、範囲の作成・変更は host dialog 内の明示操作に残す。
- mount / status read は新たな合意を作らない。以前に有効化された作業の tick は、
  host の既存契約・予算・同時実行制御を通る。

この機能を一般 SDK の `setEnabled` や scope 更新 API にすると、任意 Pack に背景作業の
開始や許可範囲変更の入口を渡すことになる。Pack ごとの permission / approval 設計がない
現在は昇格せず、app と同じ review・release 単位の widget に閉じる。
これは上記と同じ supported authoring boundary であり、same-realm の悪意ある code を
隔離する sandbox ではない。`RestoreConfirmDialog` を一般公開しない既存判断も変更しない。

conformance test は唯一の component import を名前で固定し、raw IPC allowlist と public SDK
への未公開を検査する。widget の動作 test では、未合意の On が実行を開始しないこと、
Off が停止を呼ぶこと、既存 scope の On が toggle だけを送ること、失敗を On/Off の成功と
表示しないことを確認する。

## なぜそう決めたか

設定画面はアプリ更新、復元、ファイル import といった app lifecycle の責務を持つ。
見た目が Pack であることを理由に、これらを全 UI Pack へ公開すると、Pack API が実質的な
Tauri passthrough になり permission 境界を失う。一方、読み取り専用 metadata と制約付き
external link、既に確認 UX を内蔵する history は host-mediated capability として再利用できる。

## 検討したが却下した代替案

- **system-owned 例外の文書化だけで止め、汎用 API 昇格を見送る**: 変更量が最小で、
  settings の raw import をそのまま例外化できる。しかし、app version は副作用のない
  metadata read、external link は既存の HTTPS 2 件を同一 validator に集約でき、history は
  amenity 向けに既に公開済みで restore confirmation も host が所有している。これらまで
  settings 固有に留めると、通常 UI Pack が同じ用途で unsupported import を再発明し、特に
  restore で raw destructive binding と app component を複製する誘因になる。そのため、この
  3 件は supported contract に昇格し、updater / picker 等は例外のまま維持した。
- **設定 Pack の直接 import をすべて禁止する**: updater / VRM import / app modal を先に
  public ABI 化することになり、不要な権限拡張になる。
- **`system: true` のような manifest flag を追加する**: id や自己申告 field は authority の
  根拠にならない。bundled provenance と app release review が根拠である。
- **raw Tauri を local Pack の公式 API として記載する**: 現在技術的に到達可能でも、将来の
  isolation / community distribution と両立しない。
- **updater / picker を今回 SDK 化する**: permission declaration と user approval の設計が
  先に必要。今回の安全で明白な汎用 capability の範囲を超える。

## この決定の implication / 制約

- `yorishiro-settings` の allowlist 増加は security review を要する。
- Tauri capability file や Rust command permission は、この例外文書を理由に変更しない。
- settings の user fork parity は保証しない。必要な汎用機能は個別に host-mediated SDK へ昇格する。
- 将来 updater / picker を公開する場合は permission manifest と approval UX を伴う新 decision を作る。
- Tauri の `opener:default` 自体の narrow 化は今回実装しない。isolated/community UI を
  有効にする前の follow-up とし、raw plugin を guest realm から外した上で、manifest permission、
  user activation、URL policy、audit/rate limit を host capability RPC で強制する。

## 関連 reference

- `bundled-packs/ui/yorishiro-settings/ui.tsx`
- `bundled-packs/ui/yorishiro-settings/README.md`
- `src/sdk/ui-pack.d.ts`
- `src/sdk/settings-privileged-boundary.test.ts`
- [`pack-execution-classes.md`](pack-execution-classes.md)
- [`pack-provenance-boundary.md`](pack-provenance-boundary.md)
- [`pack-rollback-recovery.md`](pack-rollback-recovery.md)
- [`input-prefill-boundary.md`](input-prefill-boundary.md)
- [`../security.md`](../security.md)

## 改訂履歴

- 2026-10-31: 自動作業を App host の `AutoWorkspace` へ移し、設定 Pack の `AutonomySettings` import と widget 例外を撤去。通常 Pack の authority は拡張しない。
- 2026-10-24: 自動作業 On/Off 用 `AutonomySettings` だけを host-owned widget として追加監査。raw IPC allowlist と通常 Pack の公開面は維持。
- 2026-08-12: Fable review を反映。same-realm では SDK validation が sandbox/enforcement ではないこと、文書化だけの最小案を採らなかった理由、opener narrow 化の follow-up を明記。
- 2026-08-12: 初版。settings の privileged/internal import を監査し、app version、制約付き HTTPS open、HistoryAPI を public UI Pack capability として切り出した。
