# Pack execution classes

> このファイルは「**公開配布 pack の安全な実行方式 / sandbox / amenity と scene の境界**」を考える時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-05-16

**Implementation note**: `pack` の public registry / community 公開配布機能と `/charm:prepare-publish` はまだ準備中であり、現行 release で利用できる機能ではない。この文書の publish flow / registry review / machine checker は、公開配布を解禁する前に満たすべき設計要件として扱う。

## TL;DR

Pack `type` は product semantics であり、security boundary ではない。公開配布では `persona` / `scene` / `effect` / `amenity` / `ui` とは別に、`executionClass` を manifest に持たせる。

| executionClass | 実行速度 | 自由度 | セキュリティ | 公開配布の基本方針 |
|---|---:|---:|---:|---|
| `declarative` | 高 | 低-中 | 高 | MVP default。data-only、JS 評価なし |
| `isolated-js` | 中 | 中 | 中-高 | Amenity 公開配布の前提。killable boundary + SES + capability RPC |
| `trusted-main-thread-js` | 最高 | 最高 | 低 | bundled / local / curated のみ。sandbox 済みと表示しない |

Amenity pack は将来的にユーザー配布可能にする。ただし公開配布する amenity は `isolated-js` を default とし、`system.exec` / `fs` / `net` / `notify` などは host mediated capability として実行する。MVP 時点で isolated runtime と permission UX が間に合わない場合、**公開 amenity は MVP から外す**。

`source` も security policy の入力である。`executionClass` は「どう実行するか」、`source` は「どこから来たか」を表す別軸として扱う。

| source | 定義 | `trusted-main-thread-js` |
|---|---|---|
| `bundled` | Charminal 本体に同梱され、release build と一緒に review / ship される pack | 許可 |
| `local` | user が `~/.charminal/packs/` に直接置く pack。`/charm:create` が作る pack もここ | 許可。ただし公開配布済みとは表示しない |
| `curated` | Charminal 側で publisher / hash / review metadata を allowlist した配布 pack | 条件付き許可。sandbox 済みとは表示しない |
| `community` | public registry / third-party / unknown publisher 由来の pack | block |

`source` は MCP trust tier とは違う軸である。MCP tier は host tool caller の信頼度、pack source は pack artifact の provenance を扱う。

## 何を決めたか

### 1. Pack type と execution class を分離する

`scene` / `effect` / `persona` / `amenity` / `ui` は「その pack が Charminal で何を意味するか」を表す。JavaScript の実行権限は制限しない。

main thread で `dynamic import()` する任意 JS は、module top-level で network access、timer、DOM access、global mutation、prototype pollution、loader や runtime object への干渉を実行できる。

したがって「scene だから安全」「amenity だけ危険」という分類は成立しない。公開配布では、必ず `type` と別に `executionClass` を見る。

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

`declarative` は JS entry を拒否するだけでは足りない。host は hostile data として以下も reject / sanitize する：

- SVG は community `declarative` では原則禁止。許可する場合は script / event handler / external reference を削った sanitizer 済み subset のみ
- JSON object key の `__proto__` / `constructor` / `prototype` は schema validation で reject
- JSON.parse 後の object を host object に deep merge しない。必要なら null-prototype object か field-by-field copy を使う
- CSS free-form string は避け、color / opacity / blur / enum など structured primitive に寄せる
- CSS context の `url(...)` は reject するか asset resolver 経由に限定する
- remote URL は `net` permission と domain allowlist が実装されるまで default deny
- `data:` / `blob:` / `file:` / absolute filesystem path / path traversal (`../`) は default reject

この checklist は `declarative` pack の public registry review rule と loader schema の両方で enforcement する。文書上だけの注意書きにしない。

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

SES / Compartment は過去にも endowment や object graph まわりの escape が問題になり得るため、`isolated-js` は「SES が破れたら終わり」という設計にしない。想定する failure mode と残る防御：

- SES が bypass されても、pack は Worker / iframe / sidecar の外へ直接出られない
- Worker 内の RPC stub を直接呼べても、host dispatcher が permission / schema / rate limit / timeout / audit log で再検証する
- host object、DOM、Tauri IPC、Node builtin、raw `fetch` は Worker global / endowment に置かない
- host から返す値は structured-clone 可能な data のみ。function / class instance / live object reference は返さない
- panic / infinite loop / memory pressure は boundary kill と crash recovery で処理する

したがって防御は「SES による object capability 制限」+「killable boundary」+「host-side capability gate」の三重で考える。

### `isolated-js` 着手 gate

`isolated-js` が長期間空白になると、community pack 作者から `trusted-main-thread-js` 開放圧がかかる。以下のいずれかが起きたら、amenity 公開配布の前であっても `isolated-js` MVP に着手する：

- public registry で `declarative` だけでは表現できない pack request が継続的に出る
- curated `trusted-main-thread-js` 例外が増え、community と curated の境界が運用で曖昧になり始める
- pure compute / transform 系 pack の需要が出る（system capability は不要だが JS 実行が必要）
- permission UX の最小版、audit log、pack disable / kill UI の実装見込みが立つ

最小 MVP は Worker + host-mediated capability RPC + strict global removal から始めてよいが、SES なしの状態を `isolated-js` として安全表示しない。SES なし段階は `worker-js-experimental` 相当の internal milestone とし、community amenity 解禁 gate にはしない。

### Capability RPC validation

`isolated-js` の pack → host RPC は、message が structured clone 可能であることだけでは足りない。host dispatcher は method ごとに以下を検証する：

- capability / method name は allowlist に存在すること
- manifest permissions、user policy、pack hash / review metadata と一致すること
- request id / protocol version / pack id / execution instance id が現在の session と一致すること
- payload は method-specific schema に通すこと。unknown field は原則 reject
- string length、array length、object depth、payload byte size に上限を設けること
- `system.exec` は shell string ではなく argv。workspace scope と command allowlist を通すこと
- `fs` path は canonicalize して declared scope 内に閉じること
- `net` は domain allowlist、method allowlist、response size cap、timeout を通すこと
- unknown method、permission mismatch、schema failure、rate limit は audit log に残すこと

host は pack へ host object を渡さず、RPC result も serializable data のみにする。type confusion を避けるため、result も schema 化する。

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
| `scene` (R3F component) | bundled-only | `trusted-main-thread-js`。user pack 対応は別 spec | main thread React + Three.js context。R3F host integration 必須 |
| `effect` | `declarative` recipe or curated `trusted-main-thread-js` | renderer primitive が十分なら `declarative`、custom renderer は trusted | visual 表現力と security が衝突しやすい |
| `persona` | `declarative` persona data | handler JS が必要なら `isolated-js`、main thread は trusted | prompt / reflex mapping は data-only に寄せる |
| `amenity` | MVP では公開配布しない | `isolated-js` default | system capability を持つため permission UX 完成まで外す |
| `ui` | MVP では公開配布しない or curated only | 多くは `trusted-main-thread-js`、将来 isolated UI を検討 | React / DOM 直触りは安全境界にならない |
| `init.js` | 公開配布しない | 公開配布しない | local user の自由記述層。pack registry には載せない |

## Amenity pack の扱い

Amenity pack は将来的にユーザー配布可能にする。ただし amenity は functional automation であり、Presence Harness の表現層より危険度が高い。

公開 amenity の前提条件：

- `executionClass: "isolated-js"` が実装済み
- `system.exec` が shell string ではなく argv ベース
- `system.exec` は command allowlist / per-command approval / workspace scope を持つ
- `fs` は path scope と read/write/create/delete の粒度を持つ
- `net` は domain allowlist を持つ
- `notify` は low-risk capability として rate limit を持つ
- capability request / result が audit log に残る
- pack disable / kill / safe mode が UI と CLI の両方にある
- PTY write API は存在しないまま維持する。MCP tool としての `terminal_prefill` / `write_terminal_input` 相当も同様に当面禁止（[`mcp-trust-tiers.md`](mcp-trust-tiers.md) "PTY 系 tool の扱い" 参照）

これらが揃わないなら、MVP では公開 amenity を外す。

## Manifest design

`type` と `executionClass` は別 field にする。

```json
{
  "$schema": "https://charminal.dev/schemas/pack-manifest.schema.json",
  "id": "workspace-backup",
  "type": "amenity",
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
- user scene asset は pack-relative path のみ許可し、remote URL / `data:` / `file:` / absolute path / traversal / CSS `url(...)` を reject
- `/charm:create` / `/charm:update` は `.js` / `.tsx` pack を local-only `trusted-main-thread-js` として生成・編集し、公開 amenity / `isolated-js` / unsafe asset / PTY write を作らないよう prompt で明示

未実装：

- `declarative` artifact の data loader / schema registry
- `permissions` manifest schema と enforcement
- `/charm:prepare-publish` 相当の local trusted pack → public artifact 変換 flow
- Web Worker / iframe / sidecar + SES runtime
- capability RPC / audit log / rate limit
- install UX の permission diff / local responsibility notice

## `/charm:create` と公開配布の関係

`/charm:create` は user が自分の環境で素早く試すための authoring flow であり、生成物は default で `source: "local"` + `executionClass: "trusted-main-thread-js"` として扱う。これは「user が自分の `~/.charminal/packs/` に置いた code を自分で信頼して動かす」経路であり、community 公開配布の安全基準を満たすことを意味しない。

したがって `/charm:create` で作った pack を公開したい場合は、そのまま registry に載せず、別 flow で publish 用 artifact へ変換する。仮称は `/charm:prepare-publish` とする。

ただし `/charm:prepare-publish` と pack 公開 UI / registry submission はまだ未提供である。現時点では local authoring pack を公開可能形式へ自動変換・提出できないため、ここで定義する責務は公開配布機能を実装する際の acceptance criteria とする。

`prepare-publish` の責務：

1. local pack の manifest / entry / assets を読む
2. `trusted-main-thread-js` のまま community 公開できない理由を user に明示する
3. `declarative` に落とせる部分を検出する
4. publish 用 directory / artifact を生成する
5. manifest を public 用に変更する
6. JS entry、unsafe asset、remote URL、schema 外 field、prototype pollution key を reject する
7. schema validation と review rule を通す
8. artifact hash / size / permission diff / executionClass diff を表示する
9. registry review に送る前の checklist を出す

`prepare-publish` は machine-check first にする。人間 review は「機械で確定できない判断」に限定し、CLI / `/charm:prepare-publish` / registry CI で同じ checker を再利用する。checker は pure module として実装し、local で通った candidate が registry 側で別判定にならないようにする。

自動 checker の分類：

| category | hard reject | warning / info |
|---|---|---|
| Manifest / policy | schema invalid、`declarative` + JS entry、community `trusted-main-thread-js`、未実装 `isolated-js`、executionClass downgrade / unsafe change | description 欠落、古い `charminalVersion` range |
| Declarative data | unknown field、prototype pollution key、depth / array length / string length / file size cap 超過、CSS free-form / `url(...)` / unsafe URL | unused field candidate、値が default と同じ |
| Assets | pack dir 外参照、symlink escape、extension / MIME 不一致、size cap 超過、image dimension cap 超過、SVG 未許可、video MVP reject | unused asset、duplicate asset、圧縮余地 |
| JS / TS static scan | publish candidate に JS entry が残る、forbidden global / import / dynamic import / eval / DOM / Tauri / Node builtin / `fetch` / timer / AudioContext / React / Three.js 使用 | 変換不能理由の説明、manual rewrite suggestion |
| Integrity | artifact hash mismatch、lockfile mismatch、review metadata mismatch | hash diff / permission diff / size diff の user-visible 表示 |
| Future `isolated-js` | forbidden global、permission と capability request 不一致、bundle size cap 超過、dependency policy violation | dependency license / vulnerability warning |

JS / TS static scan は正規表現ではなく AST で行う。`import`, dynamic `import()`, `eval`, `Function`, `fetch`, `XMLHttpRequest`, `WebSocket`, `setTimeout`, `setInterval`, `requestAnimationFrame`, `document`, `window`, `localStorage`, `AudioContext`, `@tauri-apps/api`, `node:*`, `fs`, `child_process`, `process`, `Buffer`, JSX / React / Three.js / R3F usage を検出する。

機械チェックの限界：

- social engineering 的な文言
- deceptive UI
- 過剰に不快な演出
- 著作権 / ライセンス / ブランド類似
- review 回避のための難読化
- schema 上は valid だが意味的に危険な値

これらは registry review の対象に残す。hard reject が 0 でない pack は registry review に送れない。warning は user に説明し、可能なら `/charm:prepare-publish` が修正案を出す。

変換例：

| local authoring pack | public artifact | 備考 |
|---|---|---|
| `scene.js` | `scene.json` or manifest 内 `scene` field | JS を評価しない `declarative` scene に落とす |
| `persona.js` + `persona.md` | persona data JSON + `persona.md` | prompt / reflex mapping / world 設定だけを schema 化 |
| `effect.js` | effect recipe JSON | runtime primitive で表現できる演出だけ公開可能 |
| `amenity.js` | 将来の `isolated-js` bundle | capability permission と RPC API に合わせる。MVP では公開しない |
| `ui.js` / `ui.tsx` / `ambient-ui.js` | 原則変換不可 | 将来 isolated UI または curated trusted review が必要 |

`declarative` へ変換できないもの：

- custom JS logic
- React / DOM / Three.js / R3F component
- timer / event listener
- arbitrary `fetch`
- dynamic asset loading
- direct `AudioContext`
- `fs` / `net` / `system.exec` / Tauri IPC
- PTY write / terminal prefill 相当

公開配布の基本 UX は「local で自由に試す → publish 前に constrained artifact へ変換する」である。これは Figma / VRChat / MetaMask 的な「authoring は便利、distribution は制限」というバランスを取るための分離であり、local trusted pack を community trusted pack に昇格する抜け道にしない。

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

この model は registry が honest または compromise されていないことに依存する。registry 自体が review metadata / hash / publisher mapping を改竄できる状態では、client は単独で完全検出できない。

MVP ではこの限界を明示し、少なくとも以下を守る：

- install client は `pack-lock.json` に content hash / review id / registry metadata snapshot を pin する
- installed artifact の silent replacement はしない。hash diff は常に user visible にする
- registry compromise / rollback 疑いがある pack は yanked として disable できる運用を持つ

将来の hardening 候補：

- publisher signing key による artifact signature
- registry signing key と publisher signing key の二重検証
- review metadata の append-only log / transparency log
- client 側の gossip / consistency proof
- rollback protection と yanked version policy

## MVP 推奨

以下は未提供の公開配布機能を解禁する前の実装順序である。

1. `declarative` を先に実装する
2. `/charm:prepare-publish` で local trusted pack を publish 用 `declarative` artifact に変換できるようにする
3. `scripts/check-pack` 相当の machine checker を CLI / `/charm:prepare-publish` / registry CI で共有する
4. 公開 registry は `declarative` に限定する。運用余力があれば curated trusted visual を追加する
5. `isolated-js` は Web Worker + SES + capability RPC で始める
6. amenity 公開配布は `isolated-js` runtime と permission UX が完成してから解禁する

## Review rules

Registry は以下を reject / block する。

- `executionClass: "declarative"` なのに `entry` が `.js` / `.mjs` / `.ts` / `.tsx`
- `executionClass: "declarative"` なのに schema 外 field がある
- `executionClass: "declarative"` なのに `__proto__` / `constructor` / `prototype` key を含む
- `executionClass: "declarative"` なのに SVG / CSS `url(...)` / remote URL / `data:` / `file:` / absolute path / traversal を含む
- community pack の `executionClass: "trusted-main-thread-js"`
- `isolated-js` で DOM / Tauri / Node builtin / ambient fetch に依存している
- `isolated-js` の capability RPC payload が schema / size / depth / rate limit を超える
- permissions 宣言と code の capability request が一致しない
- hash が review 済み metadata と一致しない
- `/charm:create` 由来の local `trusted-main-thread-js` pack を変換なしで community publish しようとしている
- `prepare-publish` machine checker の hard reject が残っている
- `system.exec` が shell string を要求する
- PTY write 相当の API を要求する
- `terminal_prefill` / `write_terminal_input` 相当の MCP tool 呼び出しを要求する（[`mcp-trust-tiers.md`](mcp-trust-tiers.md) 参照）

## Self-referential MCP との関係

Charminal は自身の MCP server を実装し、内部の住人（Claude Code 経由の AI）や外部 client にあらゆる機能を tool として公開する計画である（思想は [docs/philosophy/SELF_REFERENTIAL_MCP.ja.md](../philosophy/SELF_REFERENTIAL_MCP.ja.md)）。

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

- philosophy: [docs/philosophy/SELF_REFERENTIAL_MCP.ja.md](../philosophy/SELF_REFERENTIAL_MCP.ja.md)（self-referential MCP 思想）
- 関連: [`mcp-trust-tiers.md`](mcp-trust-tiers.md)、[`critical-constraints.md`](critical-constraints.md)、[`explicit-over-implicit-ugc.md`](explicit-over-implicit-ugc.md)、[`separate-distinct-systems.md`](separate-distinct-systems.md)、[`effect-rendering-primitives.md`](effect-rendering-primitives.md)
- MetaMask Snaps execution environment: <https://docs.metamask.io/snaps/learn/about-snaps/execution-environment/>
- MetaMask Snaps permissions: <https://docs.metamask.io/snaps/how-to/request-permissions/>
- MetaMask Snaps files / `source.shasum`: <https://docs.metamask.io/snaps/learn/about-snaps/files/>
- SES / Endo docs: <https://docs.endojs.org/modules/ses.html>

## 改訂履歴

- 2026-05-16: source classification、declarative hostile data checklist、isolated-js 着手 gate、capability RPC validation、registry trust limitation、SES bypass 時の防御モデル、`/charm:create` と publish 用変換 flow、machine checker の関係、公開配布機能が未提供であることを追記。
- 2026-05-03: R3F scene pack class を追加。初期 scope は bundled-only、execution class は `trusted-main-thread-js`。
- 2026-04-24: 初版。実行速度・自由度・セキュリティの三軸で execution class を定義し、Amenity pack 公開配布を `isolated-js` 完成後の future scope として位置づけ。
- 2026-04-27: self-referential MCP 計画との整合を追記。PTY write 条項を MCP tool に拡張、`mcp-trust-tiers.md` を新規 decision として参照。Review rule に terminal_prefill 系 tool 要求を reject 条件として追加。
