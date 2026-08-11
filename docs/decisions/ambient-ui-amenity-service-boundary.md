# Ambient UI と Amenity service の境界

> このファイルは「Amenity の state / 操作を Ambient UI にどう公開するか」「共通 API をどこまで stable にするか」を判断する時に読む。対象：dev / AI / Pack author。

**Status**: active
**Last updated**: 2026-08-12

## TL;DR

Amenity は opt-in の `AmenityHandle.service` を公開でき、Ambient UI は `ctx.amenities.get(id)` からそれを利用する。共通 stable contract は `get(id)`、`getState()`、`execute(command, params?)`、inactive / unavailable 時の fail-closed semantics だけに限定する。

Amenity 固有の state shape、command、payload、version は各 Amenity の contract で定義する。registry、enable/disable、MCP tool handler、内部 singleton は Ambient UI に公開しない。

## 何を決めたか

### 1. 共通の public envelope

- `ctx.amenities.get(id)` は、active かつ明示的に service を公開した Amenity の facade を返す。
- inactive、未登録、service 非公開なら `null` を返す。
- facade は `getState(): Promise<unknown>` と `execute(command, params?): Promise<unknown>` だけを持つ。
- 取得済み facade は呼び出しごとに active service を再解決する。Amenity が disable / replace された後の呼び出しは reject し、古い handle を生かさない。
- unknown command は silent no-op にせず reject する。具体的な error / result shape は各 Amenity contract が定義する。

これは通常の public API として提供し、作者に preview / stable の選択を要求しない。ただし stable とするのは上記 envelope の意味だけである。

### 2. Amenity 固有 protocol は個別所有

次は共通 stable contract に含めない。

- `getState()` が返す object の field と意味
- command 名、parameter、result、error taxonomy
- subscribe / event stream / push update
- generated typed helper や schema discovery
- community / isolated Pack の permission model

必要なら各 Amenity が version 付き contract と validation を持つ。consumer は `unknown` を信頼せず、自分が対応する protocol として parse する。

Pomodoro v0.1.0 は reference implementation であり、state snapshot と `stop` command だけを service に公開する。`start`、`status` 等の MCP tool surfaceを自動的に UI serviceへ複製しない。

### 3. Host facade が registry と lifecycle を隠す

Ambient UI に Amenity registry 自体を渡さない。host facade は active handle の opt-in service だけを解決し、次を公開しない。

- Amenity の列挙、登録、enable / disable
- `AmenityHandle.tools` と MCP handler
- runtime registry / singleton / internal store
- 別 Amenity の private state

これにより UI が state ownership を奪わず、Amenity の lifetime と同時に capability を失効できる。

## なぜそう決めたか

Pomodoro UI は timer state の表示と停止だけが必要だったが、従来は host 内部 registry と MCP tool handler を直接参照していた。この形では bundled UI だけが動き、local Ambient UI が同じ連携を作れない。また、UI が registry の mutation capability や MCP 向けの広い操作面まで取得する。

一方、Pomodoro 専用 APIだけを host context に追加すると Amenity ごとに host ABI が増える。すべての Amenity protocol を一つの型へ統合すると、将来の state / command 設計まで早期に固定してしまう。

そこで、discovery と lifecycle を共通 envelope にし、業務 protocol は各 Amenity に残す。これなら user-created Amenity も同じ窓口を使える一方、共通 API は小さく保てる。

## 検討したが却下した代替案

- **内部 registry を public にする** — mutation、enumeration、stale handle、runtime coupling を Ambient UI へ漏らす。
- **MCP tool handler をそのまま UI に渡す** — external tool protocol と in-app UI protocol の権限・lifecycleを混同する。
- **Pomodoro 専用 host API にする** — user-created Amenity に再利用できず、機能追加ごとに host ABI が増える。
- **全 Amenity に共通の強い state / command schema を先に決める** — 実需要が一例しかない段階で過剰な抽象化と互換性負債になる。
- **preview API として作者に選択させる** — consumer が安定度を選ぶ問題ではない。host が最小 envelope を安定保証し、個別 protocol のversionを各 Amenity が管理する方が責務が明確。

## この決定の implication / 制約

- Amenity 作者は Ambient UI 連携が必要な場合だけ `service` を opt-in する。
- Consumer は state / result を runtime validation し、未知 field や command failure を扱う。
- subscribe が必要になっても、既存 polling contract を壊さず追加 API として設計する。
- service envelope は same-realm の supported contractであり、sandboxやpermission enforcementではない。
- community Amenityを有効化する条件は [`pack-execution-classes.md`](pack-execution-classes.md) と [`pack-sandbox-strategy.md`](pack-sandbox-strategy.md) が所有する。

## 関連 reference

- `src/sdk/amenity-service.d.ts`
- `src/sdk/amenity.d.ts`
- `src/sdk/ambient-ui-pack.d.ts`
- `src/runtime/amenity-services/amenity-services.ts`
- `bundled-packs/amenities/pomodoro/README.md`
- `bundled-packs/ambient-ui/pomodoro-ui/README.md`
- [`pack-authoring-capability-parity.md`](pack-authoring-capability-parity.md)
- [`pack-execution-classes.md`](pack-execution-classes.md)

## 改訂履歴

- 2026-08-12: 初版。Amenity service の minimum stable envelope、個別 protocol の ownership、lifecycle失効、registry / MCP surface 非公開を固定。
