# Pack execution classes

> このファイルは「**公開配布 pack の安全な実行方式 / sandbox / harness と scene の境界**」を考える時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-04-24

## TL;DR

Pack `type` は product semantics であり、security boundary ではない。公開配布では `persona` / `scene` / `effect` / `harness` / `ui` とは別に、`executionClass` を manifest に持たせる。

| executionClass | 実行速度 | 自由度 | セキュリティ | 公開配布の基本方針 |
|---|---:|---:|---:|---|
| `declarative` | 高 | 低-中 | 高 | MVP default。data-only、JS 評価なし |
| `isolated-js` | 中 | 中 | 中-高 | Harness 公開配布の前提。killable boundary + SES + capability RPC |
| `trusted-main-thread-js` | 最高 | 最高 | 低 | bundled / local / curated のみ。sandbox 済みと表示しない |

Harness pack は将来的にユーザー配布可能にする。ただし公開配布する harness は `isolated-js` を default とし、`system.exec` / `fs` / `net` / `notify` などは host mediated capability として実行する。MVP 時点で isolated runtime と permission UX が間に合わない場合、**公開 harness は MVP から外す**。

## 何を決めたか

### 1. Pack type と execution class を分離する

`scene` / `effect` / `persona` / `harness` / `ui` は「その pack が Charminal で何を意味するか」を表す。JavaScript の実行権限は制限しない。

main thread で `dynamic import()` する任意 JS は、module top-level で network access、timer、DOM access、global mutation、prototype pollution、loader や runtime object への干渉を実行できる。

したがって「scene だから安全」「harness だけ危険」という分類は成立しない。公開配布では、必ず `type` と別に `executionClass` を見る。

### 2. `declarative` は data-only

`declarative` は「handler が無い JS object」ではない。**JS を評価しない data-only artifact** を指す。

許可する形式：

- `scene.json`
- manifest 内の `scene` field
- effect recipe JSON
- persona prompt / reflex mapping JSON
- schema validation 可能な static asset metadata

許可しない形式：

- `scene.js` が object を `export default` するだけの pack
- `persona.js` が static definition を export するだけの pack
- `effect.js` が declarative-looking な config を返すだけの pack

JS module を評価する時点で任意コード実行である。公開配布で data-only と呼ぶには、host が JSON / data を parse し、schema validation し、Charminal runtime が描画・登録・反応実行を担当する必要がある。

data-only でも、field の値は無条件に信用しない。remote URL は default deny、`url(...)` は asset resolver 経由、`javascript:` / `data:` / absolute filesystem path は reject、数値や enum は bounded value に寄せる。asset resolver と rendering primitive の粒度は [`effect-rendering-primitives.md`](effect-rendering-primitives.md) に従う。

### 3. `isolated-js` は killable boundary + SES + capability RPC

`isolated-js` は、pack JS を Charminal main thread / app realm と分離して実行する class である。

基本形：

- Web Worker / sandboxed iframe / Tauri sidecar process のどれかの killable boundary で動かす
- boundary の内部で SES / Hardened JavaScript の `lockdown()` + `Compartment` 相当を使う
- `lockdown()` は Charminal app realm ではなく isolated runtime 内でだけ実行する
- `fetch`, `fs`, `notify`, `system.exec`, DOM, Tauri IPC を ambient global として渡さない
- guest bundle を Worker module / `importScripts()` / dynamic import で直接実行しない
- host-controlled loader が bundle source を取得し、Compartment 内で評価する
- pack は JSON-RPC / message RPC で host に capability request を送る
- host は manifest permissions、user policy、pack hash、rate limit、timeout を検証して実行する
- pack へ host object を直接渡さず、serializable value だけを返す

SES は object graph の権限を絞るが、CPU 無限ループやメモリ大量確保を単独では止めない。必ず boundary の kill / timeout / crash recovery と組み合わせる。

### 4. `trusted-main-thread-js` は明示的な危険領域

Three.js / DOM / WebGL / React UI へ低レイテンシに触る pack は、性能上 main thread が必要になりうる。

その場合は sandbox で安全になったとは言わない。`trusted-main-thread-js` として扱い、以下のいずれかを必ず伴わせる：

- bundled
- local-only
- official curated
- verified publisher + allowlist
- unsafe confirm

`trusted-main-thread-js` のリスクは runtime 制限ではなく provenance と運用で下げる。

## Pack type ごとの default

| Pack type | MVP public default | 将来の公開配布 | 備考 |
|---|---|---|---|
| `scene` | `declarative` | `declarative` default。JS scene は `trusted-main-thread-js` | 既存 `scene.js` は local / legacy / trusted 扱い |
| `effect` | `declarative` recipe or curated `trusted-main-thread-js` | renderer primitive が十分なら `declarative`、custom renderer は trusted | visual 表現力と security が衝突しやすい |
| `persona` | `declarative` persona data | handler JS が必要なら `isolated-js`、main thread は trusted | prompt / reflex mapping は data-only に寄せる |
| `harness` | MVP では公開配布しない | `isolated-js` default | system capability を持つため permission UX 完成まで外す |
| `ui` | MVP では公開配布しない or curated only | 多くは `trusted-main-thread-js`、将来 isolated UI を検討 | React / DOM 直触りは安全境界にならない |
| `init.js` | 公開配布しない | 公開配布しない | local user の自由記述層。pack registry には載せない |

## Harness pack の扱い

Harness pack は将来的にユーザー配布可能にする。ただし harness は functional automation であり、Presence Harness の表現層より危険度が高い。

公開 harness の前提条件：

- `executionClass: "isolated-js"` が実装済み
- `system.exec` が shell string ではなく argv ベース
- `system.exec` は command allowlist / per-command approval / workspace scope を持つ
- `fs` は path scope と read/write/create/delete の粒度を持つ
- `net` は domain allowlist を持つ
- `notify` は low-risk capability として rate limit を持つ
- capability request / result が audit log に残る
- pack disable / kill / safe mode が UI と CLI の両方にある
- PTY write API は存在しないまま維持する。MCP tool としての `terminal_prefill` / `write_terminal_input` 相当も同様に当面禁止（[`mcp-trust-tiers.md`](mcp-trust-tiers.md) "PTY 系 tool の扱い" 参照）

これらが揃わないなら、MVP では公開 harness を外す。

## Manifest design

`type` と `executionClass` は別 field にする。

```json
{
  "$schema": "https://charminal.dev/schemas/pack-manifest.schema.json",
  "id": "workspace-backup",
  "type": "harness",
  "executionClass": "isolated-js",
  "version": "1.0.0",
  "charminalVersion": "^0.1.0",
  "entry": "bundle.js",
  "artifact": {
    "sha256": "sha256-...",
    "sizeBytes": 18432
  }
}
```

`declarative` pack は `entry` が JS を指してはならない。

## Implementation status

現在の実装は MVP gate であり、complete sandbox ではない。

実装済み：

- SDK manifest type に `executionClass` / `artifact` を追加
- Rust discovery が `manifest.json.executionClass` を TS へ渡す
- TS policy が `declarative` / `isolated-js` / `trusted-main-thread-js` を判定する
- `declarative` + JS-like entry を import 前に reject
- `isolated-js` は reserved / unsupported として止める
- `community` source の `trusted-main-thread-js` を default block

未実装：

- `declarative` artifact の data loader / schema registry
- `permissions` manifest schema と enforcement
- Web Worker / iframe / sidecar + SES runtime
- capability RPC / audit log / rate limit
- install UX の permission diff / local responsibility notice

## Integrity model

Hash は単独では trust root にならない。manifest と bundle が同時に差し替えられたら、manifest 内 hash だけでは検出できない。

公開 registry では以下を同じ chain として扱う：

1. 作者が artifact を publish する
2. registry が artifact hash を計算する
3. static review / AI quality review / manual review が hash に紐づく
4. registry が reviewed metadata を保存する
5. install client は registry の reviewed metadata と downloaded artifact hash を照合する
6. `pack-lock.json` は version だけでなく content hash と review id を保持する

更新時は permission diff と hash diff を表示する。auto-update が opt-in でも、permission 増加と execution class 変更は silent update しない。

## MVP 推奨

1. `declarative` を先に実装する
2. 公開 registry は `declarative` に限定する。運用余力があれば curated trusted visual を追加する
3. `isolated-js` は Web Worker + SES + capability RPC で始める
4. harness 公開配布は `isolated-js` runtime と permission UX が完成してから解禁する

## Review rules

Registry は以下を reject / block する。

- `executionClass: "declarative"` なのに `entry` が `.js` / `.mjs` / `.ts` / `.tsx`
- `executionClass: "declarative"` なのに schema 外 field がある
- community pack の `executionClass: "trusted-main-thread-js"`
- `isolated-js` で DOM / Tauri / Node builtin / ambient fetch に依存している
- permissions 宣言と code の capability request が一致しない
- hash が review 済み metadata と一致しない
- `system.exec` が shell string を要求する
- PTY write 相当の API を要求する
- `terminal_prefill` / `write_terminal_input` 相当の MCP tool 呼び出しを要求する（[`mcp-trust-tiers.md`](mcp-trust-tiers.md) 参照）

## Self-referential MCP との関係

Charminal は自身の MCP server を実装し、内部の住人（Claude Code 経由の AI）や外部 client にあらゆる機能を tool として公開する計画である（思想は `Charminal-design-record/specs/2026-04-17-self-referential-mcp.md`）。

これと pack-execution-classes は **layer が違う**：

- pack-execution-classes は配布される **pack の JS 実行**を扱う。host (Charminal) と guest (pack) の境界。
- self-referential MCP は Charminal **host が公開する tool 群** を扱う。host runtime の機能 surface。

両者の整合は [`mcp-trust-tiers.md`](mcp-trust-tiers.md) で定義する。trust tier 1（host runtime / bundled）/ 2（住人 = user's Claude Code）/ 3（外部 MCP client / community pack）に分け、各 tier ごとに tool category 別の access policy を持つ。

community pack が MCP tool を呼ぶ場合は **両 framework の交点** に立つ：

- pack の `executionClass` で sandbox を確保
- MCP の trust tier (Tier 3) で capability gate
- 二重防御で run time / control surface 双方の境界を保つ

外部 MCP server を install する場合は、community pack を install するときと同じ permissions diff / hash chain / review chain を経由する。詳細は [`mcp-trust-tiers.md`](mcp-trust-tiers.md) "pack-execution-classes との接続" 参照。

PTY 系 tool（`terminal_prefill` / `write_terminal_input` 等）は当面 **全 tier で禁止**。安全性 (whitelist validation + length cap + trust tier gate + content layer の social engineering 対策) が integrated に揃うまで開放しない。

## 関連 reference

- design-record: `../../../Charminal-design-record/specs/2026-04-20-pack-distribution-design.md`
- design-record: `../../../Charminal-design-record/specs/2026-04-17-self-referential-mcp.md`（self-referential MCP 思想）
- 関連: [`mcp-trust-tiers.md`](mcp-trust-tiers.md)、[`critical-constraints.md`](critical-constraints.md)、[`explicit-over-implicit-ugc.md`](explicit-over-implicit-ugc.md)、[`separate-distinct-systems.md`](separate-distinct-systems.md)、[`effect-rendering-primitives.md`](effect-rendering-primitives.md)
- MetaMask Snaps execution environment: <https://docs.metamask.io/snaps/learn/about-snaps/execution-environment/>
- MetaMask Snaps permissions: <https://docs.metamask.io/snaps/how-to/request-permissions/>
- MetaMask Snaps files / `source.shasum`: <https://docs.metamask.io/snaps/learn/about-snaps/files/>
- SES / Endo docs: <https://docs.endojs.org/modules/ses.html>

## 改訂履歴

- 2026-04-24: 初版。実行速度・自由度・セキュリティの三軸で execution class を定義し、Harness pack 公開配布を `isolated-js` 完成後の future scope として位置づけ。
- 2026-04-27: self-referential MCP 計画との整合を追記。PTY write 条項を MCP tool に拡張、`mcp-trust-tiers.md` を新規 decision として参照。Review rule に terminal_prefill 系 tool 要求を reject 条件として追加。
