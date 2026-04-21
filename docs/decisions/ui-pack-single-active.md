# UI Pack の single-active + layout spec 設計

> このファイルは「**UI pack がなぜ single-active か / layout と mount をなぜ分けたか / UiContext が unstable な理由**」を確認したい時に読む。対象：dev / AI / pack 作者。

**Status**: active（Plan 1 時点）
**Last updated**: 2026-04-21

## TL;DR

UI pack は single-active（scene pack と同じ）で config.json の `activeUi` で user が picks する。layout spec（固定要素の配置）と mount（container への自由描画）の二層構造で、衝突ゼロ + 最大自由度を両立。UiContext は Plan 3 完了まで **unstable**（three / claim / state が順次追加される）。

## 何を決めたか

1. **single-active**：同時に 1 UI pack だけ active。scene pack と同じ SingleActiveRegistry を extend
2. **layout spec + mount の二層**：layout spec で固定要素（terminal / sidebar / character）の配置を宣言、mount で container に自由描画
3. **UiLayoutAPI.update は full-replace semantics**：毎回 reset → apply。差分ではない
4. **UI pack container は `document.body` 直下**：React tree の外、zIndex 50
5. **pointer-events: none on container**：pack 作者は子要素に `pointer-events: auto` を明示
6. **zIndex 規約**：container=50、pack 内 panel=51-99、system notification=100+
7. **UiContext は Plan 3 まで unstable**：three / claim / state が順次追加、pack 作者は early adopter
8. **bundled-packs の directory 名は例外的に `ui/` （singular）**：既存の `personas/` / `scenes/` / `effects/` は kind の英語が可算なので plural、UI は uncountable なので singular。user-pack-layout.md の「kind_plural」規約の例外として許容

## なぜそう決めたか

- **single-active**: 全画面自由描画 + 複数 pack の共存は衝突管理が困難。`feedback_separate_conceptually_distinct_systems` + scene pack の成功パターンに準じる
- **二層構造**: 固定要素（terminal xterm / Three.js canvas）は singleton のため pack が消せない。layout spec で「どこに置くか」を宣言、残り空間は自由
- **full-replace**: 差分適用は前回の値が残って予測不能。runtime で layout を切り替える時の mental model をシンプルに
- **document.body 直下**: React tree 内に置くと StrictMode / HMR で React root 同士が干渉する。sibling として分離
- **pointer-events contract**: pack の panel が背景キャラへの click を遮らないため（overlay として非干渉）。継承されないので子要素側で明示的 auto
- **zIndex 規約**: 将来の system notification / modal の stacking を見越して予約

## 検討したが却下した代替案

- **複数同時 active**: slot / zone で分割する案。衝突管理が本質的に困難
- **差分 apply**: 前回の値が残って予測不能
- **React tree 内 mount**: StrictMode double-mount / HMR で React root 衝突
- **pointer-events: auto on container + selector で制御**: pack 作者が遮蔽を予想できない

## この決定の implication

- pack 作者は panel に `pointer-events: auto` を書く必要がある（docs で明示、minimal-badge が実例）
- runtime で layout を変える時は `ctx.layout.update({ /* 完全な layout */ })` を渡す
- Plan 2-3 で UiContext に field 追加は許容、breaking rename は避ける（追加だけ）
- **bundled-packs の directory 名は例外的に `ui/` （singular）**

## 関連 reference

- spec: `../Charminal-design-record/specs/2026-04-21-ui-pack-design.md`
- implementation: `src/runtime/ui-pack-registry/`、`src/core/ui-layout/`
- 関連 decision: [`single-active-config-picks.md`](single-active-config-picks.md)、[`separate-distinct-systems.md`](separate-distinct-systems.md)
