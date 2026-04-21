# camera-lighting-panel — Plan 2/3 reference UI pack

## 役割

UI pack の `ctx.three` 直接操作、`ctx.claim`、`ctx.state` 機構の reference implementation。slider / toggle / color picker で Three.js の camera と directional light を runtime で操作し、値を MCP から read/write できるようにする。

## layout

- terminal: panel の直下から画面下端まで
- sidebar / character: 変更なし

## widgets

- Camera: Tracking toggle、Look at character toggle、X / Y / Z slider、FOV slider
- Lighting: DirectionalLight intensity slider、color picker

## claim 挙動

- mount 時は tracking ON なので `claim.camera()` は未取得
- Tracking を OFF にすると `ctx.claim.camera()` を取得し、本体の head tracking が停止
- Tracking を ON に戻すと Disposable を dispose し、本体追従が再開
- pack deactivate 時は React cleanup と App.tsx の safety net で claim が release される

## state keys

MCP `get_ui_state` / `set_ui_state` から以下の key を読み書きできる。

- `camera.tracking`
- `camera.lookAtCharacter`
- `camera.x`
- `camera.y`
- `camera.z`
- `camera.fov`
- `lighting.intensity`
- `lighting.color`
