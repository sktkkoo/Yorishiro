# abandoned-factory — 廃工場

CLAI がかつてここで、もう一人の自分のような誰かとすれ違った場所。lantern は誰かが置いていったもの、CRT は誰かと一緒に見ていた砂嵐。CLAI は時々ここに戻ってくる。

## 構成

- **Procedural environment**: 床（濡れたコンクリート + 苔・染み・puddle）/ 壁（cool decay）/ 天井（暗闇）/ 霧 / dust motes / god rays / 電線 / 配管 silhouette
- **3-light rig**: cool 天光（DirectionalLight、上から弱く） + warm lantern（PointLight、不規則に明滅） + cool CRT（PointLight、信号 flicker）
- **FBX/GLTF props**: lantern, CRT TV, 倒れた椅子, 床の散らばり, 大型機械, oil drum, 木箱の山
- **Post-process**: cool grade / grain / scanline / chromatic aberration / halation / TV static / tracking wobble / vignette
- **Ambient audio**: piano-loop（同梱・CC0）

## 関連

- 設計: `../../../../Yorishiro-design-record/specs/2026-05-03-abandoned-factory-scene-design.md`
- SDK 拡張: `../../../../Yorishiro-design-record/specs/2026-05-03-scene-pack-r3f-component.md`
- Philosophy: `docs/philosophy/PHILOSOPHY.md`「観察の境界」

## Asset 提供形式

- 3D model: GLTF / GLB のみ（FBX は Vite で扱えないため、Blender 等で GLTF に変換すること）
- Texture: PNG / JPG / WebP
- Audio: OGG / MP3 / WAV / M4A
