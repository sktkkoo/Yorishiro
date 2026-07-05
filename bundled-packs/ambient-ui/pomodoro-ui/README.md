# pomodoro-ui — ポモドーロの残り時間と操作を画面右下に表示（bundled ambient-ui pack）

Charminal 本体同梱の reference ambient-ui pack。`amenities/pomodoro` が持つタイマー state を
画面右下に表示し、user が直接停止できる操作 UI を提供する overlay。

## ambient-ui pack の制度

ambient-ui は primary UI（`activeUi`）を占有しない **multi-active** な overlay 層。
`ambient-ui-pack-registry` が `enable(id)` / `disable(id)` / `getActiveSet()` で
active 集合（0..n）を管理し、active な pack はそれぞれ独立した container に mount される。
同 id の bundled / user は user-over-bundled で override される。

## state と view の分離（twin-trigger co-emission の reference）

この pack は **view（残り時間バー・フェーズ表示・Stop ボタン）だけを持ち、state は持たない**。
state（phase / round / 残り時間）は `amenities/pomodoro` 側にあり、pomodoro が state を進めて
synthetic event を emit する。pomodoro-ui はその state を読んで描画する——という二段構えが、
amenity（state）と ui（view）を分離する **twin-trigger co-emission の正規構造の reference** に
なっている（`docs/decisions/critical-constraints.md`「Twin-trigger co-emission が
amenity → persona の正規 pattern」）。

## state 連携

- `getAmenityPackRegistry()` singleton から `getActiveHandle("pomodoro")` で pomodoro amenity の
  handle を取得する。
- 1 秒ごとに `handle.tools.pomodoro_status({})` を poll し、返ってきた `phase` / `round` /
  `totalRounds` / `remainingMs` を表示に反映する。
- `phase === "idle"` の間は何も描画しない（`null` を返す）。
- 表示は phase 色つきの dot、`WORK` / `BREAK` / `LONG BREAK` ラベル、`mm:ss` 形式の残り時間、
  `round/totalRounds` のカウンタ。
- **Stop ボタン**は `handle.tools.pomodoro_stop({})` を呼んでセッションを停止する。これは MCP tool
  （住人 AI 用）と対称に、user に同じ操作を開いた経路。

## 編集について

この pack は **Charminal 本体の一部** として扱われる。Charminal 内（AI / `/yori` /
file writer）からは編集不可、本体の version up でのみ更新される
（memory: `feedback_bundled_pack_immutability.md`）。

挙動を変えたい場合は、同 id で `~/.charminal/packs/pomodoro-ui/` に fork を置く
（bundled は dispose され、user 版が active になる。fork の保守は user の責任）。

## 関連

- state 側の pack: `bundled-packs/amenities/pomodoro/README.md`
- Twin-trigger co-emission: `docs/decisions/critical-constraints.md`
