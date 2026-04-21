# camera-lighting-panel — Plan 2 reference UI pack

## 役割

UI pack の `ctx.three` 直接操作と `ctx.claim` 機構の reference implementation。slider / toggle / color picker で Three.js の camera と directional light を runtime で操作する。

## layout

- terminal: `"bottom"` shortcut（下 40%）
- sidebar / character: 変更なし

## widgets

- Camera: Tracking toggle、X / Y / Z slider、FOV slider
- Lighting: DirectionalLight intensity slider、color picker

## claim 挙動

- mount 時は tracking ON なので `claim.camera()` は未取得
- Tracking を OFF にすると `ctx.claim.camera()` を取得し、本体の head tracking が停止
- Tracking を ON に戻すと Disposable を dispose し、本体追従が再開
- pack deactivate 時は React cleanup と App.tsx の safety net で claim が release される

Plan 3 で UiContext に `state` が追加されたら、tracking 状態や slider 値を state 経由で永続化 / MCP から読み書きできるようにする予定。
