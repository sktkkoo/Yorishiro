# Motion / Effect 発火 trigger の 3 axes

**Status**: active
**Last updated**: 2026-04-19

## TL;DR

motion / effect の発火経路は **3 axes**（persona / effect / system inline）に整理する。**system reaction trigger の概念は廃止**（旧 `App.tsx` の `builtInTriggers`）— core が固定 mapping で `event → reaction` を強要すると persona の個性が消えるため。

---

## 何を決めたか

motion / effect の coupling は次の 3 axes に分類し、それぞれの主体の場所に置く：

| axis | 主体 | 配置 | 例 |
|---|---|---|---|
| **persona → motion + effect** | persona = agent | persona の `customTrigger` + `responses`（既存 API で完結） | 退屈 → イタズラ（`ctx.character.play(...)` + `ctx.space.injectEffect(...)`） |
| **effect → motion** | effect の機構 | effect pack が body API を持つ（**将来の SDK 拡張、本決定では deferred**） | TextPhysics → 文字が散る + character が屈む |
| **event → state mutation** | system 配線 | App.tsx inline trigger（既存 `builtin:tool-activity-to-body-state`） | `pre-tool-use` → body state を `thinking` に維持 |

**廃止された concept:**

- 旧 `App.tsx::builtInTriggers`（system reaction trigger）— commit `e0e987d` 以降 empty array で温存されていたが、本 plan で完全削除
- `App.tsx::augmented`（`[...builtInTriggers, ...persona.customTriggers]` の merge logic）も削除

該当 PersonaReflexDispatcher は active persona の `customTriggers` のみを bus に attach する。

---

## なぜそう決めたか

reaction の選択は本質的に「この persona がこの event をどう受け取るか」の判断。例えば `hook-signal "stop" → "pleased"` という mapping は flagship persona には合っても、別 persona（真面目な assistant、皮肉屋など）では別 reaction が筋。core が固定 mapping を強要すると：

- どの persona が active でも同じ reaction が起きる → persona の個性が消える
- 「stop で何もしない persona」が表現できない（trigger が core 側で強制されるため）
- persona pack 開発者が「どの reaction が core 由来でどれが自分由来か」を意識する必要が出る → mental model が複雑化

3 axes の分離は次の原則に基づく：

- **主体（agent / mechanic / system）が決めることは、それぞれの主体の場所に置く**
- **似て見えても、根本が違うなら統合しない**（memory: `feedback_separate_conceptually_distinct_systems`）

---

## 検討したが却下した代替案

### A. system reaction trigger を維持（旧 `builtInTriggers` を残す）

**却下理由:**
- 上記の通り persona 個性を阻害
- empty array で温存するという中途半端な状態が、概念の曖昧さを生んでいた
- Phase 3.5 の Phase 直後 (commit `e0e987d`, 2026-04-14) に「motion firing felt intrusive during ordinary Claude Code turns」として全 trigger を空にしたが、配列とコメントだけ残していた — 概念ごと外す方が筋が通る

### B. system reaction trigger を `PersonaReflexDispatcher` に固定 register（active 切替で消えない）

**却下理由:**
- A と同じく persona-agnostic な強制 mapping は持たないという結論
- API surface が広がる割に、現時点で fit する具体例が無い（YAGNI）
- 本物に必要になった時点で dispatcher に固定 register 機能を後付けで足せばよい

### C. effect-coupled motion（TextPhysics 級）を persona reaction で表現

**却下理由:**
- effect の発火と body の motion を atomic に揃える経路（`Effect → synthetic → persona handler → motion`）は cooldown / weighted 抽選を挟むため、文字が散ったその瞬間に屈むような即時性に合わない
- effect pack が「自分の演出として motion を持っている」と表明する方が概念的に素直
- 別 plan で EffectContext に body API を足す方針（**本決定では deferred**）

---

## この決定の implication / 制約

### 直接の影響

- `PersonaReflexDispatcher` は active persona の `customTriggers` のみを扱う（merge / augmented 不要）
- `App.tsx::builtInTriggers` 配列とコメントは削除済（commit 履歴で確認可能）
- bundled clai の reflex を発火させたい新規 motion は、persona の `customTriggers` に直接書く

### Future work の余地

- **EffectContext の body API 拡張**は別 plan として独立。TextPhysics 級の effect-coupled motion はこれが入るまで配線できない
- **system reaction trigger** が将来本物に必要になった場合は、dispatcher に固定 register 機能を後付け（YAGNI が崩れるまで触らない）

### 既存 system 配線への影響なし

`App.tsx` の `builtin:tool-activity-to-body-state` のような **side-effect only な inline trigger**（reaction を返さず `bodyRef.current?.setState(...)` で内部 state を mutate するだけ）は **本決定の対象外**。これは「event → state mutation」axis であり、persona reaction system とは別 concept として今後も inline で残す。

---

## 関連 reference

### Design records

- 内部 design-record: `2026-04-19-persona-registry-unification.md` — 本決定が固まった plan（reflex dispatcher 抽出と同時に concept 整理）
- 内部 design-record: `2026-04-11-design-exploration.md` revelation 3.19 — `ctx.emitEvent` 経由でしか reaction を発火させない原則。本 axis 整理と整合

### Source

- `src/runtime/persona-reflex/persona-reflex-dispatcher.ts` — active persona の customTriggers 専用 dispatcher
- `src/App.tsx` `builtin:tool-activity-to-body-state` — event → state mutation の既存例（残す）
- ~~`src/App.tsx::builtInTriggers`~~ — 削除済

### Philosophy

- [docs/philosophy/INHABITED_CHARACTER_INTERFACE.md](../philosophy/INHABITED_CHARACTER_INTERFACE.md)「多人格の住人」 — persona = agent の正当化
- [docs/philosophy/PRESENCE_HARNESS.md](../philosophy/PRESENCE_HARNESS.md)「Twin-trigger co-emission」 — 主体ごとに trigger を持つ idiom

### Memory

- `feedback_separate_conceptually_distinct_systems.md` — 表面的に似ていても根本が違うなら分離する原則
- `feedback_pack_override_pattern.md` — user pack > bundled override は dispatcher も継承

---

## 改訂履歴

- 2026-04-19 doc 化: 本ファイル作成。`builtInTriggers` concept 廃止と PersonaReflexDispatcher 切り出しの同 plan で固まった
