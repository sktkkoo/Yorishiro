# bundled-packs/ — 同梱 pack と shared assets

> このファイルは「**同梱 pack に何があるか・どう扱うか**（layout / immutability / fork stance）」を確認したい時に読む。対象：dev / AI / pack 作者。
> Pack を書く方法は [../src/sdk/README.md](../src/sdk/README.md)。Pack 種別（persona / harness / effect / scene の 4 種）の整理は同 doc 冒頭。

Charminal に同梱される **standard pack** と **shared assets**。pack 作者向けの reference implementation でもある。

---

## Layout

bundled は **kind-first**（種類別に分類）：

```
bundled-packs/
├── personas/
│   └── charminal-default/   — flagship persona
├── scenes/
│   └── quiet-room/          — Phase 1 default scene (3 layer)
├── effects/
│   └── screen-shake/        — DOM shake on error
└── shared/                  — 共有 asset library
    ├── animations/          — VRMA
    ├── voices/              — voice category 別
    └── bodies/              — VRM
```

> User pack は対称的に **flat layout**（`~/.charminal/packs/<id>/<kind>.js`）。混同しない（[memory: feedback_user_pack_layout](../.claude/projects/-Users-user-Charminal/memory/feedback_user_pack_layout.md)）。

---

## 同梱 pack 一覧

### personas/charminal-default
- **Entry**: `persona.ts`
- **Files**: `manifest.json`, `README.md`, `persona.md`（design memo）
- **役割**: SDK の flagship reference。新規 persona pack を書く AI / user が **これを読んで pattern を掴む**
- **主要 reaction**: `startled`, `contemplative`, `pleased`, `distressed`, `curious` ほか
- 詳細：`bundled-packs/personas/charminal-default/README.md`

### scenes/quiet-room
- **Entry**: `scene.ts`
- **Files**: `manifest.json`, `README.md`
- **役割**: Phase 1 default scene。3 層 (background / character / foreground) layer composition の例
- 詳細：`bundled-packs/scenes/quiet-room/README.md`

### effects/screen-shake
- **Entry**: `effect.ts`
- **役割**: built-in DOM shake on error。`ctx.space.injectEffect({ kind: "screen-shake" })` で persona から呼ばれる
- 詳細：`bundled-packs/effects/screen-shake/`

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
- 制約（PTY / harness / synthetic event）：[../docs/decisions/critical-constraints.md](../docs/decisions/critical-constraints.md)
- design-record（pack 三軸 = persona / harness / effect の確定）：`../Charminal-design-record/2026-04-11-design-exploration.md` revelation 3.12, 3.15
- design-record（scene pack の追加 = declarative・single-active）：`../Charminal-design-record/specs/2026-04-18-scene-pack-registry.md`
