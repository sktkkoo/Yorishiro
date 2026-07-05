# radiant-meadow — 光の草原

Three.js procedural renderer で描く bundled scene pack。外部画像や動画は使わず、
runtime 内蔵の `radiant-meadow` renderer が空、雲、山並み、草、光粒子を描く。
草は画面下端まで密度を持たせ、空は低空ほど白く霞む高度方向の空気遠近を入れる。

## 構成

- **radiant-meadow-three**: `procedural: { kind: "radiant-meadow" }`。Three.js canvas で背景全体を描画する。
- **vrm-slot**: character role。VRM 本体は blur なしで表示する。
- **warm-foreground-haze**: 前景の薄い haze / vignette。住人の輪郭を潰さず、画面端だけ少し落とす。

## 使い方

設定 UI から scene を `radiant-meadow` に切り替える。直接 config を触る場合は
`~/.yorishiro/config.json` の `activeScene` を `"radiant-meadow"` にする。

## 関連

- SDK: `src/sdk/scene.d.ts`
- Renderer: `src/core/scene/procedural-scene-layer.tsx`
