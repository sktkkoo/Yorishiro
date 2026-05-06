# Scene controls API

> このファイルは「**Scene Pack が lighting / post effect などの runtime 調整値をどう公開するか**」「**Leva を pack 作者向け API にしてよいか**」を判断する時に読む。対象：dev / AI。

**Status**: proposed（公開前 API 方針。実装は段階移行中）
**Last updated**: 2026-05-07

## TL;DR

Scene Pack 作者向けの正式 API は `@charminal/sdk/controls` に寄せる。Leva は当面 adapter / debug UI として使ってよいが、pack 公開 API にはしない。controls の source of truth は runtime の pack-scoped `ControlStore` に置き、F2 UI / MCP / bake（"焼き込み"）はその `ControlStore` を読む。

## 何を決めたか

- pack 作者に `useControls(..., { store })` を書かせない。
- `import { useControls } from "leva"` を公開 API として推奨しない。
- 正式口は Charminal SDK の controls API にする。
  - 例: `@charminal/sdk/controls` の `useCharminalControls`。
  - exact naming は実装時に決めるが、Leva の API shape をそのまま露出しない。
- controls schema の登録は scene pack の責務。lighting / post effect は scene pack が `useCharminalControls(...)` で登録する。camera params は現行実装に合わせて scene pack 登録を許容するが、最終的な所有境界は別 decision で詰める。
- runtime は active scene entry ごとに `ControlStore` を分離する。
- F2 panel は active scene の `ControlStore` を表示する view にする。
- MCP の `get_ui_state` / `set_ui_state` と bake は同じ `ControlStore` / schema を使う。
- UI pack は controls の表示 view を差し替えることはできるが、controls state の source of truth にはしない。

## なぜそう決めたか

Leva を導入した理由は、pack 作者が lighting / post effect などの調整値を簡単に登録できることだった。この価値は残す。ただし Leva をそのまま pack 公開 API にすると、Charminal が本来持つべき runtime 境界が Leva の仕様に引きずられる。

具体的な問題:

- `useControls` は positional overload が多く、`{ store }` の差し込みが脆い。
- Leva の Provider / context は `LevaPanel` 側には効くが、`useControls` 側の store 自動注入には使えない。
- `useControls` は初回 render で store を掴むため、panel 側だけ store を切り替えても hook 側は追従しない。
- 同じ folder path（例: `lights`, `post effects`）を複数 scene pack が使うと、global store では scene 境界を越えて state が混ざる。
- Leva の見た目を Charminal の settings / sidebar / scene theme に完全に合わせるのが難しい。
- MCP / bake / config persistence の仕様が Leva の内部 path と結合しやすい。

これは Leva が壊れているというより、Leva が「Charminal の pack runtime boundary」を表現するための正式 API ではないということ。Charminal 側で controls schema と controls UI を分離する必要がある。

## 目指す構造

Pack 作者は Charminal SDK の controls API だけを見る。

```typescript
const controls = useCharminalControls("lighting", {
  directionalIntensity: {
    type: "number",
    value: 0.8,
    min: 0,
    max: 3,
    step: 0.05,
    label: "light int.",
  },
  directionalColor: {
    type: "color",
    value: "#ffffff",
    label: "light color",
  },
});
```

runtime はこの schema を active scene pack の `ControlStore` に登録する。F2 panel は `ControlStore` を読むだけで、表示 renderer は差し替え可能にする。

```text
Scene Pack
  -> @charminal/sdk/controls
  -> Runtime ControlStore (pack-scoped)
  -> F2 Controls UI
  -> MCP get_ui_state / set_ui_state
  -> bake defaults
```

この図は依存先を示す。実際の値更新は MCP `set_ui_state` -> `ControlStore` -> scene pack render の逆方向 flow も発生する。Leva はこのうち `F2 Controls UI` の一実装、または dev/debug adapter として扱う。Charminal 独自 UI の暫定名は `ControlsPanel` とする。

## 検討したが却下した代替案

### A. Leva をそのまま公開 API にする

短期実装は一番楽だが、公開 API としては採らない。

却下理由:

- Leva の overload / folder path / store 仕様が pack 作者に漏れる。
- scene pack の実行境界と Leva store 境界が一致しない事故を runtime 側で毎回吸収する必要がある。
- F2 の見た目や interaction を Charminal 側で設計しにくい。
- 将来 Leva を外すと pack API 破壊になる。

### B. Pack 作者に `useControls(..., { store })` を書かせる

store 分離を pack 作者の責務にする案。却下。

理由は、これは runtime boundary の責務を pack 作者へ押し出しているだけだから。user pack は必ず落とし穴を踏む。store 分離は pack execution boundary の一部なので runtime が持つ。

### C. React context / Provider だけで Leva store を注入する

React tree の Provider で解決する案。却下。

Leva 0.10 系の `useControls` は Provider から store を自動取得しない。Provider で囲むだけでは `useControls` は global store を使う。Charminal 側で import 解決を握るか、SDK controls API を提供する必要がある。

### D. Scene controls を UI pack の責務にする

主軸としては却下。UI pack は表示 view の差し替えには向くが、controls state の source of truth にはしない。

scene が active になった瞬間に lighting / post effect が生まれ、scene 切り替えで消える。したがって controls schema の登録源は scene pack であるべき。UI pack を source of truth にすると、「scene は active だが UI pack が active ではない」「UI pack は active だが該当 scene が active ではない」という組み合わせが生まれる。その結果、active scene の pack-scoped `ControlStore` と UI pack 側 store の双方向同期、scene deactivate 時の cleanup、MCP state との整合を別途解く必要がある。

加えて、pack 作者が scene 実装に加えて UI 実装まで背負うことになる。これは lighting は scene pack の管轄、UI pack は表示 view という境界を曖昧にする。

UI pack は「runtime ControlStore を表示する別 UI」を提供する extension point としてならあり。

## この決定の implication / 制約

- `@charminal/sdk/controls` は Leva 非依存の schema を持つ。
- control type は最初から広げすぎない。
  - 初期候補: `number`, `color`, `boolean`, `select`, `button`, `folder`。
  - vector / image / monitor は必要になってから追加する。
- `ControlStore` は pack-scoped。
  - active scene entry 切り替えで `ControlStore` も切り替える。
  - 同じ path 名（`lights`, `post effects` 等）が別 pack 間で衝突しない。
- F2 panel は renderer。
  - 最初は Leva adapter でもよい。
  - 最終的には Charminal 独自 `ControlsPanel` に置き換えられる設計にする。
- MCP / bake は UI renderer ではなく `ControlStore` / schema に依存する。
- bundled scene pack は段階的に `import { useControls } from "leva"` から SDK controls へ移行する。
- user pack transpiler は公開時点で `leva` を直接使わせるより、SDK controls を許可 import に入れる。
- 互換目的で user pack transpiler / Vite alias の import 名 `leva` を残す場合も、正式 docs では SDK controls を案内する。
- 2026-05-07 時点で MCP `get_ui_state` / `set_ui_state` は `packId` 省略時に active scene へ fallback し、`state_get` は active scene の lighting 情報を返す。この fallback semantic は SDK controls 移行後も維持する。

## 移行方針

1. `@charminal/sdk/controls` の最小 schema と hook を作る。
2. runtime に pack-scoped `ControlStore` を作る。
3. bundled scene pack の lighting / effects / post effects controls を SDK controls に移行する。
4. 移行中に F2 が schema を見失うのを防ぐため、`ControlStore` -> Leva adapter で継続表示する。
5. MCP `get_ui_state` / `set_ui_state` を `ControlStore` に寄せる。
6. bake defaults は schema の default value 更新として扱う。
7. Leva adapter を Charminal 独自 `ControlsPanel` に置き換える。
8. Leva は dev-only fallback にするか削除する。

## 関連 reference

- source: `src/runtime/ui-state-store/use-controls-bridge.ts` — 現行 Leva <-> UiStateStore bridge
- source: `src/runtime/three-runtime/r3f-runtime-root.tsx` — R3F scene pack component mount boundary
- source: `bundled-packs/scenes/*` — 現行 bundled scene pack の Leva controls
- commits: `7667fe7` / `dde468f` / `5c77cb5` — MCP active scene fallback と `state_get` lighting 情報追加
- related: [`single-active-config-picks.md`](single-active-config-picks.md) — active scene は config / runtime selection で決まる
- related: [`separate-distinct-systems.md`](separate-distinct-systems.md) — controls schema と controls UI を混ぜない判断軸
- related: [`user-pack-layout.md`](user-pack-layout.md) — user pack の公開面積を小さく保つ

## 改訂履歴

- 2026-05-07: 初版。Leva を scene pack 公開 API にするか、SDK controls を設けるかの設計議論を topic-indexed decision として追加。
