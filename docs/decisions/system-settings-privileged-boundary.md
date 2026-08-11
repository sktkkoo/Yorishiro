# System settings UI の privileged boundary

**Status**: active
**Last updated**: 2026-08-12

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
| `@tauri-apps/api/core` の `import_vrm` | file import + host write | privileged のまま。picker、copy、VRM validation、保存先をまとめた host-mediated API が未設計 |
| `@tauri-apps/plugin-dialog` | native file picker | privileged のまま。任意 file picker を UI Pack capability として開けない |
| updater / process relaunch | network update、署名検証、app replace、再起動 | system-only。Pack API にしない |
| `src/components/RestoreConfirmDialog` | app-level modal / reload UX | settings からの直接 import を除去。`ctx.history.restore()` の host-owned confirmation として維持し、Pack 向け component ABI にしない |
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

## なぜそう決めたか

設定画面はアプリ更新、復元、ファイル import といった app lifecycle の責務を持つ。
見た目が Pack であることを理由に、これらを全 UI Pack へ公開すると、Pack API が実質的な
Tauri passthrough になり permission 境界を失う。一方、読み取り専用 metadata と制約付き
external link、既に確認 UX を内蔵する history は host-mediated capability として再利用できる。

## 検討したが却下した代替案

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

- 2026-08-12: 初版。settings の privileged/internal import を監査し、app version、制約付き HTTPS open、HistoryAPI を public UI Pack capability として切り出した。
