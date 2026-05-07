# 概念が違うものは分離する、統合しない

> このファイルは「**似たように見える 2 つの仕組みを共通化する誘惑がある**」時に読む。対象：dev / AI。

**Status**: active（design discipline）
**Last updated**: 2026-04-19

## TL;DR

表面的な類似（「どれも pack」「どれも registry」「どれも layer」）で統合しない。**動き方の根本が違えば別 concept として独立** に持つ。Effect pack（event-driven）と Scene pack（declarative）は別、user / bundled は別 layout、persona / scene / effect は別 axis。

## 何を決めたか

- 「これも X っぽいから X として共通化」と感じた時は **動作モデルが本当に同じか** を確認してから統合する
- 同じ「pack」でも：
  - **persona / utility**: runtime-active、event 駆動
  - **effect**: runtime-active、persona から呼ばれる短命 rendering
  - **scene**: declarative、registry に居続ける宣言
- 各々の lifecycle / context / 制約が違う → **別 concept として実装、別 type で表現**

## なぜそう決めたか

- 過剰共通化は abstraction leak の温床。後で「実は違った」が必ず来る
- Charminal の SDK は AI が読んで pack を書く前提 → **概念ごとに type / API が分かれている方が AI の判断が安定**（PersonaContext と UtilityContext を別型にすることで「utility で character を呼ぶ」という mistake が型 error になる）
- 統合してから分離するコストは、最初から分けるコストよりはるかに高い

## 適用例

- ✅ Scene と Effect は両方 pack だが registry / lifecycle / API を別にした
- ✅ user pack layout（flat）と bundled pack layout（kind-first）は意図的に非対称
- ✅ PersonaContext / UtilityContext / EffectContext は別型（共通基底クラスを作っていない）
- ❌ NG: 「scene も effect も injectable interface に統一すれば綺麗」← 動作モデルが違う
- ❌ NG: 「user / bundled の layout を対称にすれば綺麗」← 配備先と toolchain が違う

## 関連 reference

- 適用例: [`user-pack-layout.md`](user-pack-layout.md)、[`pack-override-pattern.md`](pack-override-pattern.md)
- 関連: [`critical-constraints.md`](critical-constraints.md) §2 Utility motion-free（型レベル境界の例）
