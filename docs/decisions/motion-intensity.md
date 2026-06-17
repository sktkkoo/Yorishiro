# Motion Intensity

**Status**: active
**Last updated**: 2026-06-17

## TL;DR

`motionIntensity` は idle procedural motion の大きさと弾性を変える global 1 ノブ。range は `0.0`–`3.0`、default は `1.0` で現状維持。user（settings / SDK）と住人 AI（MCP）に同時公開し、短い速い beat は Phase 3 の impulse event に分ける。**住人の状態（idle / thinking / reading / writing / running）の判別は、intensity とは別軸の「持続ポーズ（シルエット）＋テンポ」（Phase 4 StatePose）で行う**。

## 何を決めたか

Charminal は Body built-in の idle procedural motion（呼吸 / sway / head drift / posture）を `motionIntensity` でスケールする。

- `~/.charminal/config.json` の field は `motionIntensity: number`
- parse は `0.0`–`3.0` に clamp し、不正値は default `1.0`
- serialize は default `1.0` を省略
- default `1.0` は既存の見え方と数値一致する
- settings UI / UI pack SDK `ctx.app.setMotionIntensity(value)` / MCP `motion_intensity_set` は同じ runtime setter に到達する

Phase 1 の実装では、軸別の gain を `effectiveAmp = baseAmp * intensity^axisExponent` として計算する。出発点は head `1.4`、sway `1.2`、posture `1.1`、breathing `0.6`。`motionGain(1.0, axis) === 1.0` が default 不変の契約。

Phase 2 では Body 内部に `Spring1D` を追加し、sway / head drift / arm を spring 経由にする。

- spine sway は continuous noise を spring target として追従する
- head drift は既存の random target/timer を維持し、`lerpDelta` ではなく spring で追従する
- head tilt から pitch へ小さな arc coupling を入れる
- arm は独立 noise ではなく spine spring に遅れて追従する
- `springParams(intensity)` は高 intensity ほど omega を上げ、zeta と head timer scale を下げる

Phase 2 は **短い速い動きの頻度を増やす実装ではない**。snap / overshoot / settle を受ける弾性基盤を作り、quick glance / micro nod / posture pop のような discrete beat は Phase 3 の `IdleBeatScheduler` で impulse event として入れる。

Phase 3 では `IdleBeatScheduler` を Body 内の生理層に追加し、state ごとの discrete な pose beat を keyframe sequence で発火する。Disney / 学術研究（internal design-record: 2026-06-17-motion-aliveness-research.md、検証済み 61 件）を反映：

- **eye-lead**: 視線移動は `EyeSystem.triggerGlance` が override と同時に saccade event を発行し、頭は既存の eye-head coordination で遅れて追従する（`setOverride` 直叩きでは頭が追従しない）。
- **固視微動の維持**: 視線保持中も microsaccade を絶やさない（不在は「死に目」として知覚される）。
- **cognitive gaze aversion**: thinking 中は斜め上へ長めに視線を逸らして戻す（思考の身体記号）。
- beat の発火間隔は一様 jitter ではなく log-normal（生体的な右歪み）。
- spring の zeta 下限は `0.5`（下げすぎると bouncy = 玩具的）。誇張は振幅でなく timing で出す。
- 瞬き頻度は state 別の生理値（reading で大幅減）。

Phase 4（StatePose）では、**状態の判別を「持続ポーズ（シルエット）＋テンポ」で行う**。state ごとに held な spine/head offset（前傾 / うつむき / 見上げ）と連続スウェイ・head drift の倍率を持ち、`setActivityState` でクロスフェードする。これは **intensity と直交する別軸**：held pose は intensity 非依存、sway 倍率は intensity の後に掛ける相対倍率なので、motion size を上げても状態差が残る。

reading と writing は **body motion では当面区別しない**（「集中作業」として統合）。区別が必要なら視線ターゲット方向などの安価なチャンネルで匂わせ、腕のジェスチャー（後述）は必要性が実証されてから足す。

## なぜそう決めたか

- **presence over spectacle**: default は従来の presence を維持し、大きい動きは user opt-in にする。
- **感触 parameter は帰納調整**: range / 指数 / spring 係数は実機観察で詰める出発点。Phase 1 は「触れるノブ」、Phase 2 は「弾性基盤」、Phase 3 は「短い beat」と分ける。
- **対称性原則**: 新しい primitive は user pack と住人 AI のどちらにも公開する。MCP 専用の internal 実装は作らず、SDK / settings と同じ config + runtime setter を使う。
- **automation principle**: intensity から軸別 gain への変換は毎回 AI に判断させず、純関数で固定して test する。
- **速度コントラストの分離**: 突発的に速く動く頻度は continuous noise の周波数を上げて作らない。spring は追従力学、beat scheduler は discrete intent を担当する。
- **状態の判別はシルエットで出す**: state の違いは sparse な micro-beat や小さい視線では弱い。人間は持続ポーズ（うつむく / 見上げる / 前傾 / 静止）で活動を一目で読む（Staging）。よって state は held pose + テンポで表現する。
- **状態軸と元気さ軸の直交**: intensity が共通の地の揺れを増幅すると state signal を飲む（motion size を上げるほど状態が読めなくなる、を実機で確認）。state（姿勢・テンポ）を intensity と独立に駆動する。
- **eye-lead は装飾でなく必須**: 目だけ動いて頭が追従しないと uncanny を深める。視線 beat は必ず eye-head coordination を通す。

## 検討したが却下した代替案

### A. Phase 1 で spring / 連鎖まで同時実装

却下理由：大きい動きを「生きて」見せるには必要だが、まず設定 surface と default 不変を小さく検証できる状態にする方が commit 粒度とレビュー負荷に合う。Phase 2 で扱う。

### B. MCP 公開を後回しにする

却下理由：この設定は非破壊で、settings / SDK と同じ runtime setter を使えば trust tier 上の新しい危険を増やさない。対称性原則に従い Phase 1 で同時公開する。

### C. short fast motion を Phase 2 の continuous noise に混ぜる

却下理由：noise を速くすると常時落ち着かない揺れになりやすく、anticipation / action / follow-through の意図ある beat と混ざる。Phase 2 は spring で身体を弾性化し、短い速い所作は Phase 3 の discrete impulse event として扱う。

### D. reading / writing を頭・視線の rhythm だけで区別する

却下理由：reading も writing も「うつむいて没頭」で姿勢が酷似し、区別の情報は現実でも主に手にある（ページめくり vs 筆記）。アバターでは読書の視線スキャンは小さすぎて読めず、頭の rhythm だけでは両者を割れない（ゲーム / アニメは prop、パントマイムは腕のジェスチャーで区別している）。当面は「集中作業」に統合し、必要なら腕のジェスチャーで割る。

### E. reading / writing にリテラルな小道具（本 / ペン mesh）を持たせる

却下理由：mesh アセット + VRM ごとの手への装着 + IK 的アンカリングが必要で高コスト。さらに AI 住人が物理の本を持つのは skeuomorphic で「滲み出し」哲学（接触より環境への滲み出し）と逆方向。割るなら腕のジェスチャー（小道具なし・パントマイム）で代替する。

## この決定の implication / 制約

- `motionIntensity` は idle procedural motion の振幅ノブであり、VRMA clip / persona reaction / lip-sync / startle・flinch は scale しない。
- 新しい idle procedural axis を追加する場合は `motionGain` / `springParams` と default 不変 test を更新する。
- `1.0` の見え方を変える変更は regression として扱う。default 改善をしたい場合は別 decision で明示する。
- 上端の「オーバーアクション」感は、倍率 cap を無理に上げるのではなく Phase 2 の spring と Phase 3 の所作で作る。
- `Spring1D` は Phase 2 時点では core internal。SDK / MCP primitive として公開する場合は、対称性原則に従い user pack と住人 AI の両方に公開する。
- 状態表現（StatePose の held pose / テンポ）は intensity でスケールしない。新しい state や pose を足す場合も「held pose は intensity 非依存・sway 倍率は intensity の後に掛ける」直交を守る。
- 視線 beat（glance）は `EyeSystem.triggerGlance` を使い、`setOverride` 直叩きで頭追従を殺さない。
- reading / writing を体で割りたくなったら、リテラル小道具ではなく腕のジェスチャー（IK なしのパントマイム）を検討する。

## 関連 reference

- `src/core/body/motion-gain.ts` — 軸別 gain の pure function
- `src/core/body/spring.ts` — 1D damped spring primitive
- `src/core/body/breathing-system.ts` — 呼吸振幅への gain 適用
- `src/core/body/procedural-bones.ts` — sway / head drift / posture gain、spring passthrough、head arc、arm drag、StatePose 適用
- `src/core/body/beat-scheduler.ts` — IdleBeatScheduler（state profile / cooldown / log-normal interval）
- `src/core/body/beat-library.ts` — pose beat 定義と state 別 profile
- `src/core/body/state-pose.ts` — state 別の held pose + テンポ（Phase 4）
- internal design-record: 2026-06-17-motion-aliveness-research.md — 検証済みアニメーション科学の根拠
- `src/runtime/user-pack-loader/config.ts` — `motionIntensity` parse / serialize
- `src/runtime/charminal-mcp/tool-handlers.ts` — `motion_intensity_set` の TS handler
- `src-tauri/src/mcp/tools.rs` — Rust MCP thin wrapper
- [configuration.md](../configuration.md) — user-facing config field
- [physiological-reflex-layer.md](physiological-reflex-layer.md) — Body built-in と persona reaction の境界
- [presence-over-spectacle.md](presence-over-spectacle.md) — default は presence、spectacle は opt-in

## 改訂履歴

- 2026-06-16 作成：motionIntensity Phase 1 の range / default / default 不変契約 / SDK+MCP 対称公開を topic-indexed decision として記録。
- 2026-06-16 追記：Phase 2 の `Spring1D` / `springParams` / head arc / arm drag と、短い速い beat は Phase 3 の discrete impulse event に分離する方針を記録。
- 2026-06-17 追記：Phase 3（IdleBeatScheduler / eye-lead / 固視微動の維持 / cognitive gaze aversion / log-normal interval / spring zeta 下限 / 生理的 blink rate）を実装。Disney / 学術研究（検証済み 61 件）を反映。
- 2026-06-17 追記：実機 FB「状態の違いが分からない」を受け Phase 4（StatePose = 状態を持続ポーズ + テンポで判別、intensity と直交）を決定。reading / writing は当面「集中作業」に統合し、区別の本命チャンネルは頭の rhythm でなく腕のジェスチャーであること、リテラル小道具は却下することを記録。
