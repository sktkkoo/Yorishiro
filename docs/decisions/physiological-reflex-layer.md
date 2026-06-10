# 生理反射層 — persona reaction とは別の core built-in

**Status**: active
**Last updated**: 2026-06-10

## TL;DR

瞬き・呼吸と同格の **生理反射**（startle / 注意切替 / ターン区切りの一息 / 認知瞬き / gaze-evoked blink）は **Body built-in** として core に置く。これは廃止済みの system reaction trigger（[motion-effect-trigger-axes.md](motion-effect-trigger-axes.md)）の復活ではない：persona の **個性の表現**（reaction）ではなく、どの persona でも起きる **身体の生理** だから。

---

## 何を決めたか

「キャラクターが生きて見える」ためのモーションを 2 層に分け、所属を固定する：

| 層 | 例 | 所属 | 発火経路 |
|---|---|---|---|
| **生理（physiology）** | 瞬き / 呼吸 / saccade / posture shift / startle（瞬き + chin tuck + 息止め）/ 注意切替（瞬き + 視線正面）/ ターン区切りの深呼吸 / 認知瞬き / gaze-evoked blink | Body built-in（`src/core/body/`） | App.tsx の **event → state mutation axis**（side-effect only inline trigger）から `Body.notifyStartle()` 等を呼ぶ |
| **演技（persona reaction）** | distressed の皺眉 / celebrate の花火 / idle fidget のモーション | persona pack の `customTriggers` + `responses` | EventBus → PersonaReflexDispatcher |

具体的に core に追加した生理反射：

- `Body.notifyStartle()` — `post-tool-failure` で発火。速い瞬き + 頭の微小な引き + 息止め 0.5s。**cooldown 10s**（エラー連発で痙攣しない）
- `Body.notifyAttentionShift()` — `user-prompt-submit` で発火。瞬き + 視線を正面（作業対象）へ
- `Body.notifySettle()` — `stop` で発火。深い一呼吸（ため息系）
- `BlinkSystem.setState()` の認知瞬き — body state 遷移時に確率 0.4 で瞬き
- `EyeSystem` の gaze-evoked blink — 大きい saccade が確率 0.3 で瞬きを誘発

## なぜそう決めたか

- **persona の個性が消えない**：生理反射は表情 preset・motion clip・effect を一切使わない。瞬き・呼吸・首の微小運動という「身体がそこにある」ことの表現だけで、どの persona でも同じに起きることが自然（人間でも驚けば誰でも瞬きする）
- **motion-effect-trigger-axes.md との整合**：同 doc は「side-effect only な inline trigger（event → state mutation）は対象外」と明記している。生理反射は reaction を emit せず Body の内部 state を mutate するだけなので、この axis に属する
- **即時性**：persona reaction 経路は cooldown / weighted 抽選を挟むため、「エラーの瞬間に息を呑む」ような即時反射に合わない（同 doc の却下案 C と同じ理由）
- **intrusive 教訓への対処**：過去に「ordinary Claude Code turn 中の motion firing が intrusive」として system trigger を空にした経緯があるため、生理反射は (1) 振幅を小さく（flinch は -0.045 rad の chin tuck のみ）、(2) cooldown を Body 側に持つ、の 2 つで抑制している

## 検討したが却下した代替案

### A. persona pack（CLAI）の reaction として実装

却下理由：persona を変えると瞬きや息継ぎの生理まで消える。生理は persona ではなく身体に属する。また dispatch 経路の抽選 / cooldown が即時性に合わない。

### B. SDK / MCP に reflex API として公開（symmetry principle）

現時点では却下（YAGNI）：`notifyStartle` 等は「環境イベント → 身体」の内部配線で、pack 開発者 / 住人 AI が呼びたい motivating case がまだ無い。必要になったら `ctx.character` / MCP tool への対称公開を検討する（その時は本 doc を改訂）。

## この決定の implication / 制約

- 新しい「どの persona でも起きる身体反応」は persona pack ではなく `src/core/body/` の subsystem + `Body.notifyX()` + App.tsx inline trigger の組で足す
- 逆に、表情 preset / motion clip / effect を使いたくなったらそれは演技であり persona reaction に置く（この線を越えたら本 doc の前提が崩れる）
- 感触 parameter（振幅 / cooldown / 確率）は spec ではなく帰納的に調整する（CLAUDE.md「感触 parameter は帰納的に決める」）

## 関連 reference

- `src/core/body/index.ts` — `notifyStartle` / `notifyAttentionShift` / `notifySettle`
- `src/core/body/breathing-system.ts` — 呼吸の生理（state 連動 / ため息 / hold）
- `src/core/body/organic-noise.ts` — 非周期揺らぎの基盤
- `src/App.tsx` `builtin:tool-activity-to-body-state` — event → state mutation axis の配線箇所
- [motion-effect-trigger-axes.md](motion-effect-trigger-axes.md) — 3 axes の整理（本 doc はその「対象外」条項の具体化）
- [autonomy-without-disruption.md](autonomy-without-disruption.md) — 自発的な動きは user の作業を邪魔しない

## 改訂履歴

- 2026-06-10 作成：procedural motion 改善（organic noise / breathing / blink 自然化 / eye-head coordination / posture shift / 生理反射）と同時に層の所属を明文化
