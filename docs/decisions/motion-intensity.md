# Motion Intensity

**Status**: active
**Last updated**: 2026-06-16

## TL;DR

`motionIntensity` は idle procedural motion の大きさを変える global 1 ノブ。range は `0.0`–`3.0`、default は `1.0` で現状維持。user（settings / SDK）と住人 AI（MCP）に同時公開し、internal 専用経路は作らない。

## 何を決めたか

Charminal は Body built-in の idle procedural motion（呼吸 / sway / head drift / posture）を `motionIntensity` でスケールする。

- `~/.charminal/config.json` の field は `motionIntensity: number`
- parse は `0.0`–`3.0` に clamp し、不正値は default `1.0`
- serialize は default `1.0` を省略
- default `1.0` は既存の見え方と数値一致する
- settings UI / UI pack SDK `ctx.app.setMotionIntensity(value)` / MCP `motion_intensity_set` は同じ runtime setter に到達する

Phase 1 の実装では、軸別の gain を `effectiveAmp = baseAmp * intensity^axisExponent` として計算する。出発点は head `1.4`、sway `1.2`、posture `1.1`、breathing `0.6`。`motionGain(1.0, axis) === 1.0` が default 不変の契約。

## なぜそう決めたか

- **presence over spectacle**: default は従来の presence を維持し、大きい動きは user opt-in にする。
- **感触 parameter は帰納調整**: range と指数は実機観察で詰める出発点。Phase 1 は「触れるノブ」を小さく入れ、spring / 運動連鎖 / gesture は Phase 2 以降に分ける。
- **対称性原則**: 新しい primitive は user pack と住人 AI のどちらにも公開する。MCP 専用の internal 実装は作らず、SDK / settings と同じ config + runtime setter を使う。
- **automation principle**: intensity から軸別 gain への変換は毎回 AI に判断させず、純関数で固定して test する。

## 検討したが却下した代替案

### A. Phase 1 で spring / 連鎖まで同時実装

却下理由：大きい動きを「生きて」見せるには必要だが、まず設定 surface と default 不変を小さく検証できる状態にする方が commit 粒度とレビュー負荷に合う。Phase 2 で扱う。

### B. MCP 公開を後回しにする

却下理由：この設定は非破壊で、settings / SDK と同じ runtime setter を使えば trust tier 上の新しい危険を増やさない。対称性原則に従い Phase 1 で同時公開する。

## この決定の implication / 制約

- `motionIntensity` は idle procedural motion の振幅ノブであり、VRMA clip / persona reaction / lip-sync / startle・flinch は scale しない。
- 新しい idle procedural axis を追加する場合は `motionGain` の axis と default 不変 test を更新する。
- `1.0` の見え方を変える変更は regression として扱う。default 改善をしたい場合は別 decision で明示する。
- 上端の「オーバーアクション」感は、倍率 cap を無理に上げるのではなく Phase 2/3 の spring / 所作で作る。

## 関連 reference

- `src/core/body/motion-gain.ts` — 軸別 gain の pure function
- `src/core/body/breathing-system.ts` — 呼吸振幅への gain 適用
- `src/core/body/procedural-bones.ts` — sway / head drift / posture への gain 適用
- `src/runtime/user-pack-loader/config.ts` — `motionIntensity` parse / serialize
- `src/runtime/charminal-mcp/tool-handlers.ts` — `motion_intensity_set` の TS handler
- `src-tauri/src/mcp/tools.rs` — Rust MCP thin wrapper
- [configuration.md](../configuration.md) — user-facing config field
- [physiological-reflex-layer.md](physiological-reflex-layer.md) — Body built-in と persona reaction の境界
- [presence-over-spectacle.md](presence-over-spectacle.md) — default は presence、spectacle は opt-in

## 改訂履歴

- 2026-06-16 作成：motionIntensity Phase 1 の range / default / default 不変契約 / SDK+MCP 対称公開を topic-indexed decision として記録。
