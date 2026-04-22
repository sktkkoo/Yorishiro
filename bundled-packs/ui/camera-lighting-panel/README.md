# camera-lighting-panel — Plan 2/3/5 reference UI pack

## 役割

UI pack の `ctx.three` 直接操作、`ctx.claim`、`ctx.state` 機構の reference implementation。slider / toggle / color picker で Three.js の camera と directional light を runtime で操作し、値を MCP から read/write できるようにする。

## 起動と切り替え

Charminal の default UI は UI pack なし。`~/.charminal/config.json` の `activeUi` が未指定、または `null` の場合は panel は表示されない。

`~/.charminal/init.js` で `F1` に `ctx.setActiveUi("camera-lighting-panel")` / `ctx.setActiveUi(null)` を割り当てると、panel の表示と UI pack なしを toggle できる。Mac の Touch Bar / キーボード設定によっては `Fn+F1` として入力するが、Charminal 側で見るキーは `F1`。

## layout

- terminal: panel の直下から画面下端まで。panel 非表示時は元の layout に戻る
- sidebar / character: 変更なし

## widgets

- Camera: Tracking toggle、Look at character toggle、X / Y / Z slider、FOV slider
- Lighting: DirectionalLight intensity slider、color picker

## claim 挙動

- mount 時は tracking ON なので `claim.camera()` は未取得
- Tracking を OFF にすると `ctx.claim.camera()` を取得し、本体の head tracking が停止
- Tracking を ON に戻すと Disposable を dispose し、本体追従が再開
- pack deactivate 時は React cleanup と App.tsx の safety net で claim が release される
- Look at character を OFF にすると、X / Y / Z slider 操作時に `camera.lookAt()` を呼ばない

## state keys

MCP `get_ui_state` / `set_ui_state` から以下の key を読み書きできる。state は UI pack ごとに scope されるため、packId 省略時は active UI pack（通常 `camera-lighting-panel`）の値を読む。

- `camera.tracking`
- `camera.lookAtCharacter`
- `camera.x`
- `camera.y`
- `camera.z`
- `camera.fov`
- `lighting.intensity`
- `lighting.color`
