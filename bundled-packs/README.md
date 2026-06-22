# bundled-packs/ — 同梱 pack と shared assets

> このファイルは「**同梱 pack に何があるか・どう扱うか**（layout / immutability / fork stance）」を確認したい時に読む。対象：dev / AI / pack 作者。
> Pack を書く方法は [../src/sdk/README.md](../src/sdk/README.md)。Pack 種別（persona / amenity / effect / scene / ui / ambient-ui の 6 種）の整理は同 doc 冒頭。
>
> English version: [README.en.md](README.en.md)

Charminal に同梱される **standard pack** と **shared assets**。pack 作者向けの reference implementation でもある。

---

## Layout

bundled は **kind-first**（種類別に分類）：

```
bundled-packs/
├── personas/
│   ├── clai-en/             — flagship persona (English)
│   ├── clai-ja/             — flagship persona (Japanese)
│   └── clai-shared/         — 両 persona が import する共通 factory
├── amenities/
│   ├── music-shelf/         — Apple Music 制御 (MCP tools)
│   └── pomodoro/            — pomodoro timer
├── scenes/
│   ├── simple-room/         — default scene (R3F component scene)
│   ├── misty-grasslands/    — Three.js procedural meadow scene
│   └── abandoned-factory/   — R3F-component 廃工場 scene
├── effects/
│   ├── screen-shake/        — DOM shake on error
│   ├── screen-flash/        — 白フラッシュ
│   ├── camera-move/         — カメラ位置 / 注視点の一時シフト
│   ├── fireworks/           — 1 発の花火
│   ├── fireworks-volley/    — 連発花火
│   ├── desaturate/          — 画面 grayscale
│   ├── text-physics/        — ターミナル文字の崩落 / 復元
│   └── abandoned-monitor/   — 放置監視端末風 ARG overlay
├── ui/
│   ├── charminal-settings/  — 設定画面（F1 で開く）
│   ├── immersive/           — 透過ターミナル UI
│   └── theater/             — フルスクリーン character view
├── ambient-ui/              — overlay 系 pack（multi-active）
│   ├── attention-aura/      — 視線追跡を overlay で可視化
│   └── pomodoro-ui/         — pomodoro timer の右下表示
└── shared/                  — 共有 asset library
    ├── animations/          — VRMA (gitignored、外部 store から fetch)
    ├── voices/              — voice 用 placeholder（現状は空、配下 .gitignore）
    ├── bodies/              — VRM (placeholder、user import)
    └── sounds/              — ambient sound library（Scene Pack の ambient 宣言で参照）
```

> User pack は対称的に **flat layout**（`~/.charminal/packs/<id>/<kind>.js`）。混同しない。

---

## 同梱 pack 一覧

### personas/clai-en, clai-ja
- **Entry**: `persona.ts`
- **Files**: `manifest.json`, `README.md`, `persona.md`（design memo）
- **役割**: SDK の flagship reference。新規 persona pack を書く AI / user が **これを読んで pattern を掴む**
- **言語別 split**: `clai-en` は英語 default、`clai-ja` は日本語 default。reaction 定義など共通部分は `personas/clai-shared/persona-factory.ts` を両方が import する
- **主要 reaction**: `startled`, `contemplative`, `pleased`, `distressed`, `curious` ほか
- 詳細：各 pack の `README.md`

### personas/clai-shared
- **Entry**: 無し（pack ではなく shared module）
- **Files**: `persona-factory.ts`
- **役割**: `clai-en` / `clai-ja` から import される persona 構築 factory。reaction / handler の共通骨格を提供し、言語固有の voice / 文言を引数で受け取る

### amenities/music-shelf
- **Entry**: `amenity.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: macOS Apple Music の remote control を MCP tool として住人に公開（play / pause / skip / search / queue / volume fade / sleep timer）。住人が「BGM を流す」「曲を変える」等を自律的に行うための capability
- 詳細：`bundled-packs/amenities/music-shelf/README.md`

### amenities/pomodoro
- **Entry**: `amenity.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: pomodoro timer の state を amenity として保持。break 中はターミナルを dim させるなど、`pomodoro-ui` ambient-ui pack と twin-trigger co-emission する（amenity が state、ui が view を持つ正規構造）

### scenes/simple-room
- **Entry**: `scene.tsx`（R3F component scene）
- **Files**: `manifest.json`, `README.md`, `lib/backdrop.tsx`, `lib/lights.tsx`, `tsconfig.json`
- **役割**: Phase 1 default scene。R3F component で背景 + 前景 + 照明を組む最小の reference。backdrop / lights を `lib/` に分割した最小構成
- 詳細：`bundled-packs/scenes/simple-room/README.md`

### scenes/misty-grasslands
- **Entry**: `scene.tsx`
- **Files**: `manifest.json`, `README.md`, `lib/lights.tsx`, `tsconfig.json`
- **役割**: runtime 内蔵 Three.js procedural renderer を使う high-fidelity scene。朝の光・遠景の山並み・風になびく草・光粒子を外部画像 / 動画 asset なしで描く
- 詳細：`bundled-packs/scenes/misty-grasslands/README.md`

### scenes/abandoned-factory
- **Entry**: `scene.tsx`
- **Files**: `manifest.json`, `README.md`, `lib/`（procedural shader / lights / props / post-process / camera rig 一式）, `assets/`（user 提供 GLTF）
- **役割**: 廃工場 R3F-component scene. CLAI がかつて、もう一人の自分のような誰かとすれ違った場所
- 詳細：`bundled-packs/scenes/abandoned-factory/README.md`
- 内部設計：`../Charminal-design-record/specs/2026-05-03-abandoned-factory-scene-design.md`

### effects/screen-shake
- **Entry**: `effect.ts`
- **役割**: built-in DOM shake on error。`ctx.space.injectEffect({ kind: "screen-shake" })` で persona から呼ばれる
- 詳細：`bundled-packs/effects/screen-shake/`

### effects/screen-flash
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: 画面全体を一瞬白くフラッシュさせる。発見・閃き・強い反応の表現

### effects/camera-move
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: scene の camera 位置 / look target を一時的にシフトする。R3F scene pack と組み合わせて視点移動 / カットイン的演出を作る

### effects/fireworks
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: 1 burst の花火を overlay canvas に打ち上げる。`ctx.space.injectEffect({ kind: "fireworks", origin, count, durationMs })` で persona / init.js から呼ばれる。連発は `fireworks-volley` か呼び出し側で時差 dispatch

### effects/fireworks-volley
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: 連発花火。`fireworks` pack を内部で n 回呼び、各発の位置を random 範囲内で散らし + 発射間隔に jitter を入れる。`ctx.dispatchEffect({ kind: "fireworks-volley" })` だけで default の 3 連発が走るので、init.js の雛形はこの 1 行で済む

### effects/desaturate
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: 画面全体を grayscale 化する CSS filter effect。`ctx.space.injectEffect({ kind: "desaturate", durationMs, intensity? })` で persona / init.js から呼ばれる。idle 時やエラー時の「沈黙」「停滞」表現

### effects/text-physics
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: ターミナルの文字が重力で崩壊し、元の位置に復元するエフェクト。`addDomLayer` + `queryTerminalCells` で DOM ベース描画。4 phase: hold → cascade → rest → restore

### effects/abandoned-monitor
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`, `effect.test.ts`
- **役割**: 放置された監視端末風の全画面 ARG overlay。`addDomLayer` で背景 / スキャンライン / タイプライター + グリッチ文字を描画し、`lines` option で任意テキストを流せる

## ui/

UI pack（5 つ目の pack kind）。single-active で Charminal の UI を丸ごと定義する。詳細は内部 design-record: `2026-04-21-ui-pack-single-active.md`（Plan 3 完了まで unstable のため公開 docs/decisions/ には未 promote）。

- **charminal-settings** — Charminal の設定画面（avatar / persona / scene / agent / shortcut の入口）。F1（init.js seed の binding）またはサイドバーから開く
- **immersive** — ターミナル背景を透過させ、character と scene を前面に通す UI
- **theater** — フルスクリーン character view。ターミナル / chrome を隠し character と scene だけ残す

## ambient-ui/

Ambient UI pack（6 つ目の pack kind）。primary UI を占有せず、複数 pack が重なる **multi-active** overlay 層。`ambient-ui-pack-registry` が enable / disable / getActiveSet を管理する。

- **attention-aura** — `AttentionSnapshot` を subscribe し、注目対象の rect 上に light band を canvas overlay で描画する
- **pomodoro-ui** — `amenities/pomodoro` の state を画面右下に timer / controls として可視化する（amenity と twin-trigger co-emission する正規構造の reference）

---

## shared/ — 共有 asset

複数 pack から参照可能な asset library。VRM / VRMA / voice files。

### animations/
- VRMA animation files
- ファイル本体は `.gitignore` 対象（`bundled-packs/shared/animations/*.vrma`）。dev 時は `npm run fetch-assets` で外部 store からコピーされる

### voices/
- 現在は空の placeholder（`.gitkeep` + 空の `manifest.json` のみ）。配下全体が `.gitignore` 対象
- 将来 voice 配信が決まった時点で、category 別（`acknowledge` / `thinking` / `working` / `done` / `error` / `longwork` 等）に WAV を配置し、`manifest.json` で各 voice の `group` を宣言する想定

### bodies/
- VRM character files。現状は `.gitkeep` のみの placeholder（user が runtime import する想定）

### sounds/
- 共有 ambient sound library。Scene Pack の `ambient` 宣言から `'sound:<name>'` で参照
- Layout: flat root (汎用) + 一段 namespace (pack-specific)。詳細は `shared/sounds/README.md`
- 拡張子: `mp3` / `wav` / `ogg` / `m4a`

---

## 「bundled は本体の一部、編集不可」原則

bundled-packs は Charminal 本体の一部として扱う：

- Charminal から **write 不可**（AI 経由 / `/charm` 経由 / file writer 経由のすべて）
- バージョンアップで上書きされる
- user が改変したい場合は `~/.charminal/packs/<id>/` に **fork して** 改変する（ELPA stance）
- user fork は user 責任（壊れても Charminal は責任を負わない）

---

## Asset の供給経路

開発時の VRMA / voice asset は **外部 store**（`../Charminal-assets/`、parent dir 想定）から `npm run fetch-assets` で copy される。`predev` / `prebuild` hook で自動実行。

外部 store の path は環境変数 `CHARMINAL_ASSETS_DIR` で override 可能。

---

## 関連 doc

- pack 作者向け：[../src/sdk/README.md](../src/sdk/README.md)
- 制約（PTY / amenity / synthetic event）：[../docs/decisions/critical-constraints.md](../docs/decisions/critical-constraints.md)
- design-record（pack 三軸 = persona / amenity / effect の確定。utility は amenity に supersede）：`../Charminal-design-record/2026-04-11-design-exploration.md` revelation 3.12, 3.15
- design-record（scene pack の追加 = declarative・single-active）：`../Charminal-design-record/specs/2026-04-18-scene-pack-registry.md`
