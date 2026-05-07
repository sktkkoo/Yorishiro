# Scene layer override の semantics — scene が握る、override は patch のみ

> このファイルは「**ctx.scene.updateLayer / controls_set MCP / leva debug controls** が
> どのように scene の layer 構造に作用するか」を決めるときに読む。対象：dev / AI / pack 作者。

**Status**: active
**Last updated**: 2026-05-07

## TL;DR

- **Scene が layer 構造を握る**。pack 作者が `SceneSpec.layers` に宣言した layer 集合が「真」。
- Override（`ctx.scene.updateLayer` / MCP controls API / leva debug controls）は**既存 layer に patch を当てるだけ**。target が match しなければ no-op + warn。**新 layer は作らない**。
- Scene を切り替えると `sceneLayerOverrides` は clear される（scene-scoped）。共通管理の Camera だけが scene を跨いで持ち越される。

## 何を決めたか

### Override = scene 既存 layer への patch のみ

`applySceneLayerOverride` は：

- `target` が scene の既存 layer に match → そこに `patch` を merge した新 layer を返す
- match しない → `console.warn` して scene 不変

**新規 layer 作成（auto-create）は廃止**。

### Scene 切替で override を clear

`activeSceneEntry?.id` の変化を trigger に `setSceneLayerOverrides([])` を呼ぶ。共通管理の Camera は跨いで持ち越されるが、scene-scoped な layer 表現（blur / opacity / media src）は scene と一緒に切り替わる。

### bg / fg media load も同じ扱い

leva の "load bg" は `updateLayer({role: "background"}, {src, mediaType})` を呼ぶ。
**bg layer を持つ scene** でしか効果を持たない（match なしなら warn + no-op）。
factory のような R3F-component で全描画する scene（`layers: []`）に対しては bg load は効かない（leva の panel 自体が `hasMediaLayers` 判定で表示されない）。

## なぜそう決めたか

### 元の auto-create が引き起こした事故

過去の `applySceneLayerOverride` は target が match しないとき `createSceneLayerForTarget` で新規 layer を生成して挿入していた。これが以下の連鎖を引き起こす：

1. `simple-room`（layer 持ち scene）で leva の SceneLayerControls が mount → leva の初回 `onChange` が `value=0` で発火 → `updateLayer({role: "background"}, {blur: 0})` 経由で override が `sceneLayerOverrides` に蓄積
2. `abandoned-factory`（`layers: []` で R3F-component が全描画）に切り替え
3. Scene 切替で override が clear されないので、上記 override が持ち越される
4. `applySceneLayerOverride` が auto-create で `ui-background` / `ui-foreground` を新規生成 → factory の `renderedScene.layers` が非空になる
5. `SceneRouter` は `entry.scene.layers.length > 0` で path 1 (`SceneCompositor`) を選ぶ
6. `SceneCompositor` は `layer.role === "character"` の中だけに children を render する設計だが、auto-create された layer は character role を持たない → VrmViewer の slot が消失
7. VrmViewer が unmount → `useEffect` cleanup で `detachContainer` → canvas が DOM から消える
8. User は `.charactor-container` の `radial-gradient` 背景（factory の灰色 glow）を見る

つまり「scene の layer 構造（character slot を含む 3 層）」と「override 由来の自動生成 layer（character なし）」が SceneCompositor の slot 設計と整合しなくなる事故。

### 設計の根原則：scene が表現を握る

memory `feedback_lighting_owned_by_scene_pack.md` で同じ原則を lighting で立てた：

> R3F-component scene では scene pack が lighting を完全所有

これと同じ精神で **scene の layer 構造も scene pack が完全所有**。Override は「pack が宣言した layer の中身を一時的に書き換える」だけで、構造そのものを変える権限は持たない。

### Scene-scoped vs. session-scoped

User の方針（2026-05-07 の対話）：

> scene 切替ではその scene の設定に切り替わる想定。たとえば、ある scene で背景にブラーをかけても scene 切り替えたら新しい scene にそのブラーは反映されない。

これは「override は scene と一緒に存在し、消えるもの」という意味付け。**唯一の例外は Camera**（共通管理）。Camera は scene を跨いで「同じ camera を観ている」という連続性を持つ。layer は scene の表現そのものなので scene と一緒。

## 検討したが却下した代替案

- **Auto-create を残し、SceneCompositor に character 不在時の fallback render を入れる**
  defensive にはなるが「scene が握る」原則を pack 作者に伝えにくい。layer 構造が override 経由で増殖する surface area が残る。Fix 1 で原則を強制し、Fix 2 で持ち越し問題を別途封じる方が clean。
- **Media patch（src/mediaType）だけ auto-create を残す**
  「style だけは既存 layer 必須」と「media は自動 layer 化」が **同じ API（`updateLayer`）の中で挙動分岐する**ので、API としての一貫性を欠く。bg load は scene が bg layer を宣言していなければ無効でよい（user の方針通り）。
- **Override を session 全体で persist**（現状）
  場面（scene）と表現（layer）は不可分なので、scene 切替で持ち越すのは概念的に違和感がある。Camera は「観る側の連続性」なので別物。

## この決定の implication / 制約

### Pack 作者向け

- bg image / fg image / blur control を runtime で受けたい scene は、最初から該当 role の layer を `SceneSpec.layers` に宣言する
- 「layer は無いが override で動的に生やす」設計はサポートしない
- factory のような R3F-component で全描画する scene は layer を持たないのが正しい（DOM layer 不要）。代わりに R3F の `useFrame` / `useCharminalControls` 経由で per-frame controls を組む

### UI pack 作者向け

- `ctx.scene.updateLayer({role, ...}, patch)` は **既存 layer 必須**。match しなければ warn + no-op
- bg image を user に差し替えさせたい UI なら、対象 scene が bg layer を持つことを前提にする（無ければ UI を出さない）
- Scene 切替で override が clear されることを念頭に置く（永続化したい設定は `ctx.state` 経由）

### MCP 経由（AI / controls API）

- AI が `controls_set({ scope: "scene", path, value })` や `controls_transition({ scope: "scene", values, durationMs })` で background blur を設定しても、scene が bg layer を持たなければ warn が出て効果は無い
- Scene を切り替えた瞬間に AI が設定した値は消える（共通管理 Camera は除く）

### Test fixture

- `init-script.test.ts` / `config.test.ts` / `tool-handlers.test.ts` の `"camera-lighting-panel"` literal は generic な pack id 文字列として残置（pack 実体に依存していない）
- 将来 cleanup したくなったら別 PR で

## 関連 reference

- memory: `feedback_lighting_owned_by_scene_pack.md`（同根の原則を lighting で）
- memory: `feedback_explicit_over_implicit_ugc.md`（explicit を優先する設計姿勢）
- 関連: [`single-active-config-picks.md`](single-active-config-picks.md), [`pack-override-pattern.md`](pack-override-pattern.md)
- 内部 design-record: `2026-05-07-scene-layer-override-orphan.md`（本決定の調査ログ・診断 log・修正経緯。非公開）
- 修正 commit: `fix/scene-layer-override-orphan` branch の 3 commits
  - `47fc02b` Fix 1: auto-create 廃止
  - `5758a95` Fix 2: scene 切替で override clear
  - `5e275f1` Fix 3: camera-lighting-panel 削除（dead code 化していた reference 実装）
