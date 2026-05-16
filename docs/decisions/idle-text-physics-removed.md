# idle 自動発火の shoot / TextPhysics を廃止

> このファイルは「**住人が idle 中にひとりでに shoot（銃撃 motion + TextPhysics）を始める挙動の有無**」で設計判断する時に読む。対象：dev / AI / pack 作者。

**Status**: superseded（旧 shoot sequence の idle 自動発火を廃止） / active（現行：shortcut 明示発火のみ）
**Last updated**: 2026-05-17

## TL;DR

**clai persona が idle 継続中に低確率で shoot timeline（gun_fire + TextPhysics + camera-move）を自動発火する挙動を廃止した**。shoot は **user が init.js のショートカットで明示発火する時だけ** 走る。旧 Charminal の「ひとりでに撃ち始める」演出は presence として user 体験から外す判断。

---

## 何を決めたか

- `clai-shared/persona-factory.ts` の trigger `clai:idle-shoot`（`idle` かつ `durationMs >= 90s` かつ `Math.random()` で 30%）を**削除**
- 旧 reaction `mischievous-shoot`（cooldown 1h の `[SHOOT_REACTION]` handler）を**削除**
- shoot timeline `runShootTimeline` 自体は残す。発火経路は `clai:shortcut-shoot` trigger（synthetic event `clai:shoot`）→ reaction `mischievous-shoot-shortcut` の**ショートカット明示発火のみ**
- 不要になった定数を除去：`SHOOT_IDLE_THRESHOLD_MS` / `SHOOT_IDLE_PROBABILITY` / `SHOOT_REACTION`
- `runShootTimeline` 内の `ctx.character.interrupt(...)` の reason 文字列は `SHOOT_SHORTCUT_REACTION` に更新（`interrupt` は reason ラベルを取るだけで挙動には影響しない）

---

## なぜそう決めたか

`clai:idle-shoot` は旧 Charminal の「住人が退屈すると勝手に撃ち始める」演出の移植だった。これは [autonomy-without-disruption.md](autonomy-without-disruption.md) の「住人の自発性は user の作業を邪魔しない範囲で」に照らすと境界線上にある：TextPhysics はターミナルの文字を物理落下させる視覚的に強い演出で、user が作業していない確証なしに（idle 90s は離席とは限らない）画面を占有する。自発性の表現としては侵襲が強すぎ、[presence-over-spectacle.md](presence-over-spectacle.md) の「実在感の増幅が第一、過剰演出は従」とも整合しない。

明示ショートカット発火に一本化することで、TextPhysics は「user が意図的に呼んだ時の演出」になり、自発性は別の侵襲の低い層（idle-fidget 等の反射層）に委ねる。

## 何を変えていないか

- `runShootTimeline` の timeline 構造（gun_fire → camera-move → 1500ms 後 TextPhysics → motion release）は不変
- ショートカット経路（init.js → `ctx.emitEvent("clai:shoot")` → `clai:shortcut-shoot`）は不変
- camera-move / text-physics の effect pack 自体は不変

## 改訂履歴

- 2026-05-17: 初版。idle 自動発火を廃止し shortcut 明示発火のみに。関連 test：`bundled-packs/personas/clai/persona.test.ts`（idle trigger 削除の回帰 + shoot timeline は shortcut handler 経由で検証）
