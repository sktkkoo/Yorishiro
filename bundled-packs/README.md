# bundled-packs/ — 同梱 pack と shared assets

> このファイルは「**同梱 pack に何があるか・どう扱うか**（layout / immutability / fork stance）」を確認したい時に読む。対象：dev / AI / pack 作者。
> Pack を書く方法は [../src/sdk/README.md](../src/sdk/README.md)。Pack 種別（persona / amenity / effect / scene / ui / ambient-ui の 6 種）の整理は同 doc 冒頭。

Charminal に同梱される **standard pack** と **shared assets**。pack 作者向けの reference implementation でもある。

---

## Layout

bundled は **kind-first**（種類別に分類）：

```
bundled-packs/
├── personas/
│   └── clai/   — flagship persona
├── scenes/
│   ├── simple-room/         — default scene (3 layer)
│   └── radiant-meadow/      — Three.js procedural meadow scene
├── effects/
│   └── screen-shake/        — DOM shake on error
├── ui/
│   └── charminal-settings/    — 設定画面（F1 で開く）
├── ambient-ui/              — overlay 系 pack（Phase 1c で同梱済み）
│   └── attention-aura/      — 視線追跡を overlay で可視化（multi-active 対応 ambient-ui pack）
└── shared/                  — 共有 asset library
    ├── animations/          — VRMA
    ├── voices/              — voice category 別
    ├── bodies/              — VRM
    └── sounds/              — ambient sound library（Scene Pack の ambient 宣言で参照）
```

> User pack は対称的に **flat layout**（`~/.charminal/packs/<id>/<kind>.js`）。混同しない（[memory: feedback_user_pack_layout](../.claude/projects/-Users-user-Charminal/memory/feedback_user_pack_layout.md)）。

---

## 同梱 pack 一覧

### personas/clai
- **Entry**: `persona.ts`
- **Files**: `manifest.json`, `README.md`, `persona.md`（design memo）
- **役割**: SDK の flagship reference。新規 persona pack を書く AI / user が **これを読んで pattern を掴む**
- **主要 reaction**: `startled`, `contemplative`, `pleased`, `distressed`, `curious` ほか
- 詳細：`bundled-packs/personas/clai/README.md`

### scenes/simple-room
- **Entry**: `scene.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: Phase 1 default scene。3 層 (background / character / foreground) layer composition の例
- 詳細：`bundled-packs/scenes/simple-room/README.md`

### scenes/radiant-meadow
- **Entry**: `scene.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: runtime 内蔵 Three.js procedural renderer `radiant-meadow` を使う high-fidelity scene。外部画像 / 動画 asset なしで、空・山並み・風になびく草・光粒子を描く
- 詳細：`bundled-packs/scenes/radiant-meadow/README.md`

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

### effects/fireworks
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: 1 burst の花火を overlay canvas に打ち上げる。`ctx.space.injectEffect({ kind: "fireworks", origin, count, durationMs })` で persona / init.js から呼ばれる。連発は `fireworks-volley` か呼び出し側で時差 dispatch
- 詳細：`bundled-packs/effects/fireworks/README.md`

### effects/desaturate
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: 画面全体を grayscale 化する CSS filter effect。`ctx.space.injectEffect({ kind: "desaturate", durationMs, intensity? })` で persona / init.js から呼ばれる。idle 時やエラー時の「沈黙」「停滞」表現
- 詳細：`bundled-packs/effects/desaturate/README.md`

### effects/text-physics
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: ターミナルの文字が重力で崩壊し、元の位置に復元するエフェクト。`addDomLayer` + `queryTerminalCells` で DOM ベース描画。4 phase: hold → cascade → rest → restore
- 詳細：`bundled-packs/effects/text-physics/README.md`

### effects/abandoned-monitor
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`, `effect.test.ts`
- **役割**: 放置された監視端末風の全画面 ARG overlay。`addDomLayer` で背景 / スキャンライン / タイプライター + グリッチ文字を描画し、`lines` option で任意テキストを流せる
- 詳細：`bundled-packs/effects/abandoned-monitor/README.md`

### effects/fireworks-volley
- **Entry**: `effect.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: 連発花火。`fireworks` pack を内部で n 回呼び、各発の位置を random 範囲内で散らし + 発射間隔に jitter を入れる。`ctx.dispatchEffect({ kind: "fireworks-volley" })` だけで default の 3 連発が走るので、init.js の雛形はこの 1 行で済む
- 詳細：`bundled-packs/effects/fireworks-volley/README.md`

## ui/

UI pack（5 つ目の pack kind）。single-active で Charminal の UI を丸ごと定義する。詳細は内部 design-record: `2026-04-21-ui-pack-single-active.md`（Plan 3 完了まで unstable のため公開 docs/decisions/ には未 promote）。

- **charminal-settings** — Charminal の設定画面（avatar / persona / scene / agent / shortcut の入口）。F1（init.js seed の binding）またはサイドバーから開く

## ambient-ui/（Phase 1c 同梱済み）

Ambient UI pack（6 つ目の pack kind）。primary UI を占有せず、複数 pack が重なる **multi-active** overlay 層。`ambient-ui-pack-registry` が enable / disable / getActiveSet を管理する。SDK と registry は Phase 1a で実装済み（`src/runtime/ambient-ui-pack-registry/`）。

- **attention-aura** v0.1.0（同梱済み）— `AttentionSnapshot` を subscribe し、注目対象の rect 上に light band を canvas overlay で描画する。Phase 1d で App.tsx 側のルーティングが配線され完全に動作する（pack 側実装は本 Phase で完了）。

---

## shared/ — 共有 asset

複数 pack から参照可能な asset library。VRM / VRMA / voice files。

### animations/
- VRMA animation files（一部は権利確認中で .gitignore 対象、詳細は `.gitignore`）

### voices/
- Category 別：thinking / error / done / acknowledge / working / longwork
- 一部 .gitignore 対象

### bodies/
- VRM character files

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

詳細：[memory: feedback_bundled_pack_immutability](../.claude/projects/-Users-user-Charminal/memory/feedback_bundled_pack_immutability.md)

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
