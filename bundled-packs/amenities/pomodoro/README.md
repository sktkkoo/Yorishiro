# pomodoro — ポモドーロタイマー（bundled amenity pack）

work → break を繰り返すポモドーロタイマーの bundled Amenity Pack。フェーズ遷移を
state machine（`idle → work → short-break → work → ... → long-break → idle`）で管理し、
切替時に synthetic event を emit する。break 中は terminal の opacity を tween で落として
「休憩している」感を出す。

## 公開する MCP tool

| tool | 役割 |
|---|---|
| `pomodoro_start` | セッション開始。`workMs` / `shortBreakMs` / `longBreakMs` / `rounds` を ms 指定（省略で default） |
| `pomodoro_stop` | 進行中のセッションを停止 |
| `pomodoro_status` | 現在の `phase` / `round` / `totalRounds` / `remainingMs` / `config` を取得 |

default は work 25 分 / short break 5 分 / long break 15 分 / 4 rounds。
最終 round の break が long break になり、終了で `idle` に戻る。

## emit する event

フェーズ遷移ごとに synthetic event を emit する（trigger match 経由で persona reflex が反応する）。

- `pomodoro:started` — `{ workMs, shortBreakMs, longBreakMs, rounds }`
- `pomodoro:work-started` — `{ round, totalRounds }`
- `pomodoro:break-started` — `{ kind, round, durationMs }`（`kind` は `short` / `long`）
- `pomodoro:session-completed` — `{ rounds }`
- `pomodoro:cancelled` — `{ phase, round }`

## state と view の分離（twin-trigger co-emission）

この pack は **タイマーの state（phase / 残り時間）だけを持つ**。残り時間バーや
フェーズ表示などの **view は `ambient-ui/pomodoro-ui` pack が持つ**。pomodoro が state を
進めて event を emit し、それに反応して pomodoro-ui が描画する——という二段構えで、
両者が同じ event に co-emit する twin-trigger 構造になっている
（`docs/decisions/critical-constraints.md`「Twin-trigger co-emission が amenity → persona の正規 pattern」）。

terminal の dimming は activate 時に注入される `setTerminalOpacity` / `getTerminalOpacity` と
`ctx.tween` で直接制御する（bundled pack 固有の拡張 context。SDK の `AmenityContext` 型は汚さない）。

## 境界

- **amenity は motion-free**。character / voice / space API は型レベルで持たない。
  break の合図に対する表情・voice は persona 側が event を受けて決める。
- view を自前で描画しない。表示は pomodoro-ui に委ねる（state と view の分離）。

## 編集について

この pack は **Charminal 本体の一部**。Charminal 内（AI / `/charm` / file writer）からは編集不可、
本体の version up でのみ更新される（memory: `feedback_bundled_pack_immutability.md`）。

挙動を変えたい場合は、同 id で `~/.charminal/packs/pomodoro/` に fork を置く
（bundled は dispose され、user 版が active になる。fork の保守は user の責任）。
