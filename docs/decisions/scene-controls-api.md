# Scene controls API

> このファイルは「**Scene Pack が lighting / post effect などの runtime 調整値をどう公開するか**」「**Leva を pack 作者向け API にしてよいか**」を判断する時に読む。対象：dev / AI。

**Status**: partial（API・runtime store・F2 二分割は実装済み。Leva renderer の置き換えは future）
**Last updated**: 2026-05-07

## TL;DR

Scene Pack 作者向けの正式 API は `@yorishiro/sdk/controls` に寄せる。Leva は当面 adapter / debug UI として使ってよいが、pack 公開 API にはしない。controls の source of truth は runtime の pack-scoped `ControlStore` に置き、F2 UI / MCP / bake（"焼き込み"）はその `ControlStore` を読む。F2 panel は **Common（runtime-wide）と Scene（pack-scoped）の 2 枚** に分け、ownership で書き分ける。

## 何を決めたか

- pack 作者に `useControls(..., { store })` を書かせない。
- `import { useControls } from "leva"` を公開 API として推奨しない。
- 正式口は Yorishiro SDK の controls API にする。
  - `@yorishiro/sdk/controls` の `useYorishiroControls` / `controlFolder`。
  - Leva の API shape をそのまま露出しない（runtime が wrapper で store 注入を吸収する）。
- runtime は active scene entry ごとに `ControlStore` を分離する。
- F2 controls は **Common panel と Scene panel の 2 枚** に分割する。
  - **Common panel** (`runtimeLevaStore`)：runtime-wide な debug control。現状は base camera（position / FOV / tracking / lookAt）のみ。
  - **Scene panel** (`activeSceneLevaStore`)：active scene pack の `ControlStore`。lighting / post effect / camera modulation params / DOM scene layer media など pack-scoped な control はすべてこちら。
- controls schema の登録源は **ownership** で決める（後述「ownership rule」）。
- MCP の `get_ui_state` / `set_ui_state` と bake は同じ `ControlStore` / schema を使う。
- UI pack は controls の表示 view を差し替えることはできるが、controls state の source of truth にはしない。

## Ownership rule — Common か Scene か

control を Common / Scene のどちらに置くかは「**その lifetime が runtime と一致するか、active scene と一致するか**」で決める。

| control | 置き場所 | 根拠 |
|---|---|---|
| base camera（position / FOV / tracking / lookAt） | **Common** | camera は ThreeRuntime singleton に 1 つ。scene を切り替えても camera は連続する。`runtimeLevaStore` で常時 mount。 |
| camera modulation parameters（例: `breath`, `cameraRig`） | **Scene** | scene pack 固有の motion pattern。pack の component が unmount したら modulation も消える。`useYorishiroControls("camera", ...)` で scene store に登録。 |
| lighting | **Scene** | scene pack が完全所有（`a9b5816` で ThreeRuntime の default light は削除済み）。scene 切り替えで lighting も消える。 |
| post effects | **Scene** | scene pack の演出 layer。pack ごとに完全に異なる effect chain を持つ。 |
| DOM scene layer media（background / foreground 画像差し替え、blur） | **Scene** | scene の layer 構成自体が pack 定義。media layer がない scene では panel に出さない。`SceneLayerControls` が `sceneLevaStore` を受け取って描画。 |

**判定ガイド**：「scene を切り替えたときにこの control の値・存在を維持すべきか」を問う。維持すべきなら Common、消えるべきなら Scene。

## なぜそう決めたか

Leva を導入した理由は、pack 作者が lighting / post effect などの調整値を簡単に登録できることだった。この価値は残す。ただし Leva をそのまま pack 公開 API にすると、Yorishiro が本来持つべき runtime 境界が Leva の仕様に引きずられる。

具体的な問題:

- `useControls` は positional overload が多く、`{ store }` の差し込みが脆い。
- Leva の Provider / context は `LevaPanel` 側には効くが、`useControls` 側の store 自動注入には使えない。
- `useControls` は初回 render で store を掴むため、panel 側だけ store を切り替えても hook 側は追従しない。
- 同じ folder path（例: `lights`, `post effects`）を複数 scene pack が使うと、global store では scene 境界を越えて state が混ざる。
- Leva の見た目を Yorishiro の settings / sidebar / scene theme に完全に合わせるのが難しい。
- MCP / bake / config persistence の仕様が Leva の内部 path と結合しやすい。

これは Leva が壊れているというより、Leva が「Yorishiro の pack runtime boundary」を表現するための正式 API ではないということ。Yorishiro 側で controls schema と controls UI を分離する必要がある。

## 目指す構造

Pack 作者は Yorishiro SDK の controls API だけを見る。

```typescript
const [controls, setControls] = useYorishiroControls("lights", () => ({
  directionalIntensity: {
    value: 0.8,
    min: 0,
    max: 3,
    step: 0.05,
    label: "light int.",
  },
  directionalColor: {
    value: "#ffffff",
    label: "light color",
  },
}));
```

runtime はこの schema を active scene pack の `ControlStore` に登録する。F2 panel（Common / Scene）は `ControlStore` を読むだけで、表示 renderer は差し替え可能にする。

```text
Scene Pack
  -> @yorishiro/sdk/controls (useYorishiroControls)
  -> ControlStoreContext (R3fRuntimeRoot が provide)
  -> Active Scene ControlStore (pack-scoped, useCreateStore + module-level singleton)
  -> Scene Panel (F2)              -- 表示 renderer
  -> MCP get_ui_state / set_ui_state -- packId 省略時は active scene fallback
  -> bake defaults                   -- /yori:update で source の value を書き換え

Yorishiro Runtime
  -> CameraControls / 他 runtime-wide controls
  -> Runtime ControlStore (singleton, lifetime = runtime)
  -> Common Panel (F2)               -- 表示 renderer
```

この図は依存先を示す。実際の値更新は MCP `set_ui_state` -> `ControlStore` -> scene pack render の逆方向 flow も発生する。Leva はこのうち `Common Panel` / `Scene Panel` の一実装、または dev/debug adapter として扱う。Yorishiro 独自 UI の暫定名は `ControlsPanel` とする。

## 検討したが却下した代替案

### A. Leva をそのまま公開 API にする

短期実装は一番楽だが、公開 API としては採らない。

却下理由:

- Leva の overload / folder path / store 仕様が pack 作者に漏れる。
- scene pack の実行境界と Leva store 境界が一致しない事故を runtime 側で毎回吸収する必要がある。
- F2 の見た目や interaction を Yorishiro 側で設計しにくい。
- 将来 Leva を外すと pack API 破壊になる。

### B. Pack 作者に `useControls(..., { store })` を書かせる

store 分離を pack 作者の責務にする案。却下。

理由は、これは runtime boundary の責務を pack 作者へ押し出しているだけだから。user pack は必ず落とし穴を踏む。store 分離は pack execution boundary の一部なので runtime が持つ。

### C. React context / Provider だけで Leva store を注入する

React tree の Provider で解決する案。却下。

Leva 0.10 系の `useControls` は Provider から store を自動取得しない。Provider で囲むだけでは `useControls` は global store を使う。Yorishiro 側で import 解決を握るか、SDK controls API を提供する必要がある。

### D. Scene controls を UI pack の責務にする

主軸としては却下。UI pack は表示 view の差し替えには向くが、controls state の source of truth にはしない。

scene が active になった瞬間に lighting / post effect が生まれ、scene 切り替えで消える。したがって controls schema の登録源は scene pack であるべき。UI pack を source of truth にすると、「scene は active だが UI pack が active ではない」「UI pack は active だが該当 scene が active ではない」という組み合わせが生まれる。その結果、active scene の pack-scoped `ControlStore` と UI pack 側 store の双方向同期、scene deactivate 時の cleanup、MCP state との整合を別途解く必要がある。

加えて、pack 作者が scene 実装に加えて UI 実装まで背負うことになる。これは lighting は scene pack の管轄、UI pack は表示 view という境界を曖昧にする。

UI pack は「runtime ControlStore を表示する別 UI」を提供する extension point としてならあり。

## この決定の implication / 制約

- `@yorishiro/sdk/controls` は Leva 非依存の schema を持つ。
- control type は最初から広げすぎない。
  - 初期候補: `number`, `color`, `boolean`, `select`, `button`, `folder`。
  - vector / image / monitor は必要になってから追加する。
- `ControlStore` は pack-scoped。
  - active scene entry 切り替えで `ControlStore` も切り替える。
  - 同じ path 名（`lights`, `post effects` 等）が別 pack 間で衝突しない。
- F2 panel は renderer で 2 枚（Common / Scene）。
  - 最初は Leva adapter でもよい。
  - 最終的には Yorishiro 独自 `ControlsPanel` に置き換えられる設計にする。
  - 2 枚の panel は同じ F2 toggle で同期表示／非表示。
- MCP / bake は UI renderer ではなく `ControlStore` / schema に依存する。
  - `get_ui_state` / `set_ui_state` の `packId` は active scene id（= scene `ControlStore` の所有 pack）。Common panel 側の control（base camera）は同じ MCP API では露出しない（必要になれば別 tool を生やす）。
- bundled scene pack は段階的に `import { useControls } from "leva"` から SDK controls へ移行する。
- user pack transpiler は公開時点で `leva` を直接使わせるより、SDK controls を許可 import に入れる。
- 互換目的で user pack transpiler / Vite alias の import 名 `leva` を残す場合も、正式 docs では SDK controls を案内する。
- 2026-05-07 時点で MCP `get_ui_state` / `set_ui_state` は `packId` 省略時に active scene へ fallback し、`state_get` は active scene の lighting 情報を返す。この fallback semantic は SDK controls 移行後も維持する。

## 移行方針

1. ✅ `@yorishiro/sdk/controls` の最小 schema と hook を作る（`useYorishiroControls` / `controlFolder` / `ControlStoreProvider`）。
2. ✅ runtime に pack-scoped `ControlStore` を作る（`scene-pack-leva-store.ts` の `activeSceneStore` singleton + `useCreateStore`）。
3. ✅ bundled scene pack の lighting / effects / post effects controls を SDK controls に移行する（`abandoned-factory` / `simple-room` / `misty-grasslands`）。
4. ✅ 移行中に F2 が schema を見失うのを防ぐため、`ControlStore` -> Leva adapter で継続表示する（`<LevaPanel store={activeSceneLevaStore}>`）。
5. ✅ MCP `get_ui_state` / `set_ui_state` を `ControlStore` に寄せる（active scene fallback 込み）。
6. ⏳ bake defaults は schema の default value 更新として扱う（現状 `/yori:update` の手順として doc 化、自動化は未実装）。
7. ⏳ Leva adapter を Yorishiro 独自 `ControlsPanel` に置き換える。
8. ⏳ Leva は dev-only fallback にするか削除する。

## 関連 reference

- source: `src/sdk/controls.ts` — `useYorishiroControls` / `controlFolder` / `ControlStoreProvider` 実装
- source: `src/runtime/leva.tsx` — Vite alias `leva` の差し替え先（store 注入 wrapper + leva 再 export）
- source: `src/runtime/three-runtime/scene-pack-leva-store.ts` — active scene `ControlStore` の module-level singleton
- source: `src/runtime/three-runtime/runtime-leva-store.ts` — Common panel 用 `ControlStore` の module-level singleton
- source: `src/runtime/three-runtime/r3f-runtime-root.tsx` — `<ControlStoreProvider>` の mount boundary
- source: `src/core/debug-controls/camera-controls.tsx` — Common panel 側の base camera control
- source: `src/core/debug-controls/scene-layer-controls.tsx` — Scene panel 側の DOM layer media control
- source: `src/runtime/ui-state-store/use-controls-bridge.ts` — Leva <-> UiStateStore bridge（MCP との往復）
- source: `bundled-packs/scenes/*` — `useYorishiroControls` 利用例（`abandoned-factory` が full reference）
- commits: `c9f9a2f` / `b93d7b3` / `6d7d4e5` — SDK controls 経由への移行と context 統一
- commits: `9001164` / `d7eec73` / `e79da2f` — pack-scoped store 分離 / SceneLayerControls の Scene 側移管 / 2 panel 並列配置
- commits: `7667fe7` / `dde468f` / `5c77cb5` — MCP active scene fallback と `state_get` lighting 情報追加
- related: [`single-active-config-picks.md`](single-active-config-picks.md) — active scene は config / runtime selection で決まる
- related: [`separate-distinct-systems.md`](separate-distinct-systems.md) — controls schema と controls UI を混ぜない判断軸
- related: [`user-pack-layout.md`](user-pack-layout.md) — user pack の公開面積を小さく保つ

## 改訂履歴

- 2026-05-07（初版）: Leva を scene pack 公開 API にするか、SDK controls を設けるかの設計議論を topic-indexed decision として追加。
- 2026-05-07（更新）: 実装が landed したため status を `partial` に。F2 panel の 2 枚分割（Common / Scene）と camera ownership rule を明示。実装済み source / 関連 commit を reference に追加。移行方針の進捗状況を ✅/⏳ で可視化。
