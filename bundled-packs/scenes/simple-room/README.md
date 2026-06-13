# simple-room — シンプルな部屋（bundled reference scene）

Charminal 本体同梱の reference scene pack。`~/.charminal/config.json` の
`activeScene` が未設定なら、この pack が fallback default として選ばれる
（Design B: Registry の bundled alphabetical fallback で `simple-room` が
`radiant-meadow` より先に来るため）。

## 構成

- **backdrop**: 青灰色の radial + linear gradient。光の中心が画面中央上にあるので、
  そこに VRM が居ると自然に光の方を向いているように見える。
- **vrm-slot**: character role、blur 0。compositor が VRM を差し込む slot。
- **fg-vignette**: 四隅を暗く落とす vignette。「部屋の中」感を軽く暗示する。

動画素材や画像は同梱していない（rights の問題と、「gradient だけの落ち着き」が
reference の主張のため）。user が自分の素材で差し替えたい場合は、同 id で
`~/.charminal/packs/simple-room/` に pack を置けば override される。

## 編集について

この pack は **Charminal 本体の一部** として扱われる。Charminal 内（AI / `/charm` /
file writer）からは編集不可、Charminal 本体の version up でのみ更新される
（memory: `feedback_bundled_pack_immutability.md`）。

user が override したい場合は `~/.charminal/packs/simple-room/` に独自の
pack を置く（bundled は dispose され、user 版が active になる）。

## 関連

- Internal design-record: `specs/2026-04-18-scene-pack-compositor-design.md`、`specs/2026-04-18-scene-pack-registry.md`
- Philosophy: `docs/philosophy/PHILOSOPHY.md`「UI は環境である」「生きた系」
