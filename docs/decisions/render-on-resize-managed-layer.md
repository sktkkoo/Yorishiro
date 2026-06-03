# Render は resize と同 frame で — 自前 renderer の罠と managed render-layer primitive

> このファイルは「**canvas を resize したのに描画が一瞬消える**／**pack 作者が自前 renderer を持ち込むときの安全策**」を考える時に読む。対象：dev / AI / pack 作者。

**Status**: partial（不変条件は実装済み・enforced／managed primitive は proposed・未実装）
**Last updated**: 2026-06-02

## TL;DR

**不変条件（確定・実装済み）**：WebGLRenderer の `setSize()` は drawing buffer を clear するので、**resize した frame では必ず同 frame に render する**。resize と render を別経路（frame-rate throttle / 別 RAF）に分けると、clear-without-redraw で UI アニメ中に scene が消える。ThreeRuntime（メイン canvas）と procedural-scene-layer（独立 renderer）の 2 経路で enforce 済み。

**proposed（未実装）**：pack 作者も `addDomLayer` 等で自前 renderer を持ち込めば同じ罠を踏むため、**resize→render の結線を framework が所有する managed render-layer primitive** を SDK に出して、作者が罠を「書けない」ようにする。

## 何を決めたか（不変条件・実装済み）

- `setSize()` を呼ぶ全 renderer は、**その frame で render する**責務を持つ。
- ThreeRuntime: `handleResize()` が resize 有無を返し、tick が `shouldRenderScene() && (throttle || resized)` で resize 時は frame-rate throttle を無視する（commit a2d6e7a）。
- procedural-scene-layer: 描画 2 パスを `drawScene()` に抽出し、ResizeObserver 駆動の `resize()` 末尾で必ず呼ぶ（commit fa6d429）。
- canvas を持つ renderer は **複数ある**（VRM の共有 canvas と scene の独立 canvas）。修正時は `grep setSize` / `new THREE.WebGLRenderer` で全経路を洗う。pitfall: design-record `pitfalls/log.md` 2026-06-02。

## 作者が踏みうる経路（リスク面）

| 作者の描画経路 | 状態 |
|---|---|
| Scene pack（R3F component、共有 ThreeRuntime canvas） | safe（不変条件で保護） |
| UI pack（`ctx.three` の共有 scene に足す） | safe |
| Effect `drawOnCanvas`（framework 所有の 2D canvas） | safe |
| **`addDomLayer` で自前 `WebGLRenderer` + `ResizeObserver`** | **危険**（procedural-scene-layer がこの形。作者が render-on-resize を忘れると blank） |

危険は「自前 renderer を持ち込む escape hatch」一本に絞られる。

## proposed — managed render-layer primitive

framework が **resize→render の結線・canvas 生成・throttled RAF を所有**し、作者は `draw` の中身だけ書く primitive を出す。罠を構造的に書けなくする（Automation 原則：機械的結線はプログラムが所有）。2 つの形：

- **(1) 共有ループへ draw を登録**（`ctx.three.onDraw((renderer, {width,height,elapsed}) => …)` 的）。**別 WebGL context を作らない**ので、context 上限の罠（pitfall 2026-05-06: xterm WebglAddon × multi-tab）も同時に回避。多くの用途はこれで足りる。**推し。**
- **(2) 独立 pipeline 用の managed layer**（`addRenderLayer({ draw })`）。post-processing（別 render target、例：草原の ACES/grain/vignette）が要る時用に、別 renderer + 自動 resize→render を framework が管理。**procedural-scene-layer をこれに載せ替えて dogfood**（手書き resize ループの重複も消える）。

Symmetry（bundled も user も同一 primitive）+ cognitive-load（作者が追う layer が減る）に整合。

## 検討したが却下した代替案

- **docs / lint だけ**：作者の記憶に依存し、再発を防げない（最弱）。
- **何もしない（現状の生 `addDomLayer`）**：今回の再発を作者側で再生産する。

## この決定の implication / 制約

- (1) を入れると「作者が separate renderer を新規に作る」動機が減り、context 上限リスクも下がる。
- (2) は新規 SDK surface。executionClass（`pack-execution-classes.md`）と整合させる（declarative scene からも使えるか要検討）。
- 着手は未定。まず本不変条件で実害（scene blanking）は解消済み。primitive は authoring 体験の予防策。

## 関連 reference

- 実装: `src/runtime/three-runtime/three-runtime.ts`（`handleResize`/`tick`）、`src/core/scene/procedural-scene-layer.tsx`（`drawScene`/`resize`）
- 作者 surface: `src/sdk/context.d.ts`（`RendererAPI.addDomLayer`/`drawOnCanvas`）、`src/sdk/ui-pack.d.ts`（`UiThreeAPI`）、`src/sdk/scene-pack.d.ts`（R3F component）
- pitfall: 非公開 design-record `pitfalls/log.md` 2026-06-02、2026-05-06
- 原則: `cognitive-load-design-lens.md`、`docs/philosophy/SELF_REFERENTIAL_MCP.ja.md`（Symmetry）、CLAUDE.md（Automation 原則）

## 改訂履歴

- 2026-06-02: 新規。render-on-resize 不変条件の確定（2 renderer で enforce）と、作者向け managed render-layer primitive の proposed 設計を記録。
