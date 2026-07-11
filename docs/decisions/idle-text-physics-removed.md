# idle 自動発火の shoot / TextPhysics（廃止 → 侵襲を下げて復活）

> このファイルは「**住人が idle 中にひとりでに shoot（銃撃 motion + TextPhysics）を始める挙動の有無と条件**」で設計判断する時に読む。対象：dev / AI / pack 作者。

**Status**: active（idle 自動発火は 2026-06-23 に復活。15 分 idle 到達時の **単発・低確率** 発火 + shortcut 明示発火。2026-05-17〜06-23 は廃止していた）
**Last updated**: 2026-06-23

## TL;DR（現行）

**yori persona は、idle が 15 分続いた「その到達時」に一度だけ低確率（<= 10%）で shoot timeline（gun_fire + TextPhysics + camera-move）を自動発火する**。外したら persona reload（≒アプリ再起動）まで再判定しない。加えて user が init.js のショートカットでいつでも明示発火できる。

2026-05-17 に一度この idle 自動発火を**廃止**した（当時：idle 90s + 5 秒ごと 30% 判定。侵襲が強すぎた）。2026-06-23 に、廃止理由に応える形でパラメータを変えて**復活**させた（下記「復活」節）。以下「何を決めたか／なぜ」は 2026-05-17 の廃止時の記録。

---

## 何を決めたか

- `yori-shared/persona-factory.ts` の trigger `yori:idle-shoot`（`idle` かつ `durationMs >= 90s` かつ `Math.random()` で 30%）を**削除**
- 旧 reaction `mischievous-shoot`（cooldown 1h の `[SHOOT_REACTION]` handler）を**削除**
- shoot timeline `runShootTimeline` 自体は残す。発火経路は `yori:shortcut-shoot` trigger（synthetic event `yori:shoot`）→ reaction `mischievous-shoot-shortcut` の**ショートカット明示発火のみ**
- 不要になった定数を除去：`SHOOT_IDLE_THRESHOLD_MS` / `SHOOT_IDLE_PROBABILITY` / `SHOOT_REACTION`
- `runShootTimeline` 内の `ctx.character.interrupt(...)` の reason 文字列は `SHOOT_SHORTCUT_REACTION` に更新（`interrupt` は reason ラベルを取るだけで挙動には影響しない）

---

## なぜそう決めたか

`yori:idle-shoot` は旧 Yorishiro の「住人が退屈すると勝手に撃ち始める」演出の移植だった。これは [autonomy-without-disruption.md](autonomy-without-disruption.md) の「住人の自発性は user の作業を邪魔しない範囲で」に照らすと境界線上にある：TextPhysics はターミナルの文字を物理落下させる視覚的に強い演出で、user が作業していない確証なしに（idle 90s は離席とは限らない）画面を占有する。自発性の表現としては侵襲が強すぎ、[presence-over-spectacle.md](presence-over-spectacle.md) の「実在感の増幅が第一、過剰演出は従」とも整合しない。

明示ショートカット発火に一本化することで、TextPhysics は「user が意図的に呼んだ時の演出」になり、自発性は別の侵襲の低い層（idle-fidget 等の反射層）に委ねる。

## 何を変えていないか

- `runShootTimeline` の timeline 構造（gun_fire → camera-move → 1500ms 後 TextPhysics → motion release）は不変
- ショートカット経路（init.js → `ctx.emitEvent("yori:shoot")` → `yori:shortcut-shoot`）は不変
- camera-move / text-physics の effect pack 自体は不変

## 復活（2026-06-23）

idle 自動発火を **復活**させた。廃止理由（侵襲の強さ）に応える形でパラメータを変えている：

- **閾値 90s → 15 分（900_000ms）**。idle 90s は離席の確証にならなかったが、15 分は「席を外している」確証が格段に高い。
- **判定は 15 分到達時の単発のみ**。旧実装は idle が続く限り idle check 間隔（5 秒）ごとに毎回ロールしていた。新実装は idle が 15 分を初めて超えた一度だけロールし、発火しても外しても `idleShootEvaluated`（`createYoriPersona` の per-instance closure flag）を立て、persona reload（≒アプリ再起動）まで再判定しない。つまり **1 run に最大 1 回**。
- **確率は <= 10%（現状 0.08）の単発**（`SHOOT_IDLE_PROBABILITY`、感触 param）。
- 結果、自発発火は「席を外して 15 分以上経った時に、稀に・1 回だけ起きる驚き」になり、[autonomy-without-disruption.md](autonomy-without-disruption.md) / [presence-over-spectacle.md](presence-over-spectacle.md) の侵襲懸念（離席確証・画面占有）に応える。

### cooldown について

発火後の 72h cooldown を検討したが、**判定が単発（1 run に最大 1 回）なので reaction の cooldownMs は意味を持たない**（再 dispatch が起きず決して発火しない dead config になる）。よって付けない。「外したら再起動まで再判定しない／発火は 1 run 1 回」が in-memory な実質クールダウンを兼ねる。再起動をまたぐ永続クールダウンは MemoryAPI が現状 in-memory（`real-context.ts`）のため見送り。

### 実装

- `yori-shared/persona-factory.ts`：trigger `yori:idle-shoot`（`event.kind === "idle"` かつ `durationMs >= SHOOT_IDLE_THRESHOLD_MS` かつ `idleShootEvaluated` 未消費 → 消費して `Math.random() < SHOOT_IDLE_PROBABILITY`）→ reaction `mischievous-shoot`（cooldown なし、handler = `runShootTimeline`）。timeline は shortcut 経路と共有。
- 関連 test：`bundled-packs/personas/yori-shared/persona-factory.test.ts`（trigger 登録 / 15 分閾値 / 確率ゲート / 単発性 / 非 idle event）。

## 改訂履歴

- 2026-05-17: 初版。idle 自動発火を廃止し shortcut 明示発火のみに。関連 test：`bundled-packs/personas/yori/persona.test.ts`（当時。現在は `yori-shared/persona-factory.test.ts` に再編）
- 2026-06-23: idle 自動発火を復活（15 分閾値 + 単発 + <= 10%、外したら再起動まで再判定なし）。判定が単発のため cooldownMs は付けない。Status を active に更新。
