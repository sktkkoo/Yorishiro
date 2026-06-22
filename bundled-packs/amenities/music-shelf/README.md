# music-shelf — Apple Music のリモコン（bundled amenity pack）

macOS の Music.app を `osascript`（AppleScript）経由でリモコン操作する bundled Amenity Pack。
再生・一時停止・スキップ・検索・キュー・音量フェード・スリープタイマーを MCP tool として
公開し、曲やプレイヤー状態の変化を synthetic event として persona に通知する。

`ctx.system.exec("osascript", ...)` で AppleScript を stdin から流し込むので shell injection しない。
polling は初回 tool 使用時に開始する（起動時から Music.app に触りに行かず、automation prompt を避ける）。

## 公開する MCP tool

| tool | 役割 |
|---|---|
| `music_play` | 再生開始。`playlist` 指定で playlist 再生、`shuffle` でシャッフル |
| `music_pause` | 一時停止 |
| `music_next` / `music_previous` | 次 / 前の曲へ |
| `music_now_playing` | 現在の曲（title / artist / album / 再生位置・長さ）を取得 |
| `music_playlists` | playlist 名一覧を取得 |
| `music_search` | 曲名・アーティスト・アルバムを検索して候補を返す（`area` で検索範囲指定） |
| `music_search_play` | 検索語に一致する最初の曲を再生 |
| `music_play_track` | `music_search` が返す track id（persistent ID）を指定して再生 |
| `music_volume` | 音量（0-100）の取得・設定 |
| `music_fade_volume` | 指定時間をかけて音量をフェード |
| `music_queue` | pack 内部キューに `add` / `list` / `clear` / `remove` |
| `music_shuffle` / `music_repeat` | シャッフル / リピート状態の取得・設定 |
| `music_library_summary` | ライブラリの曲数・アーティスト・代表候補を集計 |
| `music_stop_after` | 指定時間後 or 現在曲の終了付近で `pause` / `stop`（スリープタイマー） |

再生開始系の tool は環境音を一時的に下げる（ambient ducking）。`ambient: "keep"` で無効化、
`ambientDuckVolume`（0.0-1.0）で duck 後の音量を指定できる。再生が止まると元の音量に戻す。

## emit する event

trigger match 経由で persona reflex を発火させるための synthetic event。

- `music-shelf:track-changed` — `{ title, artist, album }`。曲が切り替わったとき
- `music-shelf:state-changed` — `{ state }`。playing / paused などの遷移

## 境界

- **macOS + Music.app 専用**。`osascript` 前提なので他 OS では動かない。
- **amenity は motion-free**。character / voice / space API は型レベルで持たない。
  曲の変化は event として announce するだけで、reaction（表情・voice）の決定は persona 側の責務
  （`docs/decisions/critical-constraints.md`「amenity → persona は twin-trigger co-emission」）。
- 環境音 ducking 以外で本体の音や映像を直接いじらない。ambient audio の制御は `ctx.ambientAudio` 経由。

## 編集について

この pack は **Charminal 本体の一部**。Charminal 内（AI / `/charm` / file writer）からは編集不可、
本体の version up でのみ更新される（memory: `feedback_bundled_pack_immutability.md`）。

自分用に挙動を変えたい場合は、同 id で `~/.charminal/packs/music-shelf/` に fork を置く
（bundled は dispose され、user 版が active になる。fork の保守は user の責任）。
