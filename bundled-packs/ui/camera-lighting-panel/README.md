# camera-lighting-panel — UI pack の reference implementation

## 位置づけ

**この UI pack は日常利用を想定していない参考実装。** camera / lighting / scene layer のリアルタイム調整は F2 で開く Common / Scene panel（Charminal 本体側）でやる方針なので、user 向けには推奨しない。

残しているのは以下の用途のため：

- UI pack SDK の `ctx.three` 直接操作、`ctx.claim`、`ctx.scene`、`ctx.state` の reference implementation
- 将来 Leva adapter を Charminal 独自 `ControlsPanel`（[`docs/decisions/scene-controls-api.md`](../../../docs/decisions/scene-controls-api.md)）に置き換えるときの参考コード
- UI pack 作者が同種の panel を作るときに参考にする例

slider / toggle / color picker / file picker で Three.js の camera、directional light、active scene layer を runtime で操作し、値を MCP から read/write する仕組み一式が一通り揃っている。

## 起動方法（参考）

Charminal の default UI は UI pack なし。`~/.charminal/config.json` の `activeUi` が未指定、または `null` の場合は panel は表示されない。

確認したいときは `~/.charminal/config.json` で `"activeUi": "camera-lighting-panel"` に一時的に設定するか、`~/.charminal/init.js` で `ctx.setActiveUi("camera-lighting-panel")` を任意の shortcut に割り当てる。**ただし F2 の Common / Scene panel と機能が重複するため、常用は想定していない。**

## layout

- terminal: panel の直下から画面下端まで。panel 非表示時は元の layout に戻る
- sidebar / character: 変更なし

## widgets

- Camera: Tracking toggle、Look at character toggle、X / Y / Z slider、FOV slider
- Lighting: DirectionalLight intensity slider、color picker
- Scene: background / foreground の media picker、blur slider

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
- `scene.background.blur`
- `scene.background.src`
- `scene.background.mediaType`
- `scene.background.name`
- `scene.foreground.blur`
- `scene.foreground.src`
- `scene.foreground.mediaType`
- `scene.foreground.name`
