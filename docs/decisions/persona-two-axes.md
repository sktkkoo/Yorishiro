# Persona の範囲 — 思考と反射の二軸

**Status**: active
**Last updated**: 2026-07-18
**Related**: `src/sdk/persona.d.ts`, `src/runtime/user-pack-loader/persona-defaults.ts`, [trigger-reaction-architecture.md](trigger-reaction-architecture.md), [separate-distinct-systems.md](separate-distinct-systems.md)

## TL;DR

`PersonaDefinition` の軸は **思考（thinking）と反射（reflex）の二つ**。かつて存在した world / logReading 軸は 2026-07-18 に削除した（宣言のみで runtime に消費者がいなかった）。「トリガーによる反応を persona から切り出して別 pack 種にする」案は却下——どの出来事に体がどう反応するかは口調と同格の人格である。

## 何を決めたか

- `PersonaDefinition` は `id` / `name` / `thinking` / `reflex` のみ。**persona = キャラ表現（喋り方 + 体の癖）**という直観と宣言面を一致させる。
- **world 軸（body / voice / space）を削除**。空間（scene）は workspace に紐づくため persona は選ばない。VRM の persona 連動切替は実装したい機能だが「world（住人が世界を選ぶ）」という抽象は実態（persona に紐づく見た目・声のアセット）に対して過剰で、宣言面は別の形で設計する。voice 切替も同様に将来対応。
- **logReading 軸（LogReadingPolicy）を削除**。「反射層ログをいつどう読むかで人格を分岐させる」機構は以前配線して実機で差が知覚できず撤去済みだった。想起・内省の niche は inner-life の journal が担う。LogBridge / `ctx.log` の器（write / tail / read）は反射の trace 基盤として存続する。
- **trigger pack という新 pack 種は作らない**。検知（event → ReactionType）と身体表現（reflex.responses）の分離は `ReactionType` contract + amenity の `customTriggers` + synthetic event として SDK に既に存在する。
- 旧 world / logReading field を書いた既存 user pack は余剰プロパティとして無視される（validator は後方互換）。

## なぜそう決めたか

- **反応は人格である**（philosophy「意識に先立つ反応」）。push 成功に花火で喜ぶのは Yori であって、寡黙な persona なら小さく頷くだけのはず。反応を persona 非依存の pack に出すと、どの persona も同じ反応をする＝キャラが「口調スキン」に格下げされる。
- **身体・注意チャネルには単一の調停者が要る**。反応拡張の中止（複数系統の同時積み増しは合算でうるさい）の教訓。独立した trigger pack が各々体を動かすと、合算ノイズと motion slot / camera singleton の取り合いが pack 間で再発する。
- **宣言と実効の一致**。宣言だけで効かない軸が型に残ると、pack 作者に「書いたのに効かない」混乱を生む。範囲の再定義より先に、死んだ宣言を消す。

## 検討したが却下した代替案

- **trigger pack 新設（反応の全面切り出し）**: 上記の理由で却下。既存概念（amenity trigger）と重複する新概念を作らない（[separate-distinct-systems.md](separate-distinct-systems.md) の裏面）。
- **logReading の改善再配線**: 差を出すには periodic / continuous 注入という侵襲的な方向しかなく、[autonomy-without-disruption.md](autonomy-without-disruption.md) と衝突。将来「尋ねられたら体の行動を語る」が欲しくなったら、policy 型の復活ではなく MCP tool 一本（on-query で reflex log の tail を返す）で足りる。
- **world 軸を残して VRM 切替の宣言に使う**: 「世界の選択」という抽象が過剰。宣言面は pack manifest 等の別の家で設計する。

## この決定の implication / 制約

- **境界線は二本**。①自発反応（世界イベント → 反射）は persona 専有。②**user の明示呼び出し**（init.js shortcut 等）は persona 中立の契約にすべき——`yori:shoot` が persona 切替で silent no-op になる問題はこの欠落が原因（修正方針は design-record 2026-07-18-persona-scope-review.md §4。event 語彙中立化 / named performance 化 / 拒否可・無反応禁止 / fallback 中立化）。
- キャラ中立な検知（git push 成功の parse 等）は persona でなく core の DerivedEvent に降ろしていく。
- world / logReading の再導入はしない。VRM / voice の persona 連動宣言を設計するときは、この entry を更新する。

## 関連 reference

- 経緯の全体: design-record 2026-07-18-persona-scope-review.md（非公開、date-indexed）
- `docs/philosophy/PHILOSOPHY.md`「意識に先立つ反応」
