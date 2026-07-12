# Active secondary response — motion と直交する外力補正

**Status**: active
**Last updated**: 2026-07-12

## TL;DR

外力によるよろめきは MotionScheduler を通さず、再生中 pose に加える独立 channel とする。汎用計算は Three.js / VRM 非依存の `packages/yoromeki`、normalized humanoid への合成は Body の薄い adapter が担う。

## 何を決めたか

- `packages/yoromeki` は plain vector / quaternion / skeleton / force event だけを公開し、Three.js・VRM・Yorishiro を runtime dependency に持たない。
- `Body.update` の frame 冒頭で前 frame の補正済み bone を保存済み target に戻す。mixer / procedural 後、`vrm.update()` 前に新 target を sample し、`target * correctionDelta` を normalized bone に一度だけ書く。
- animation claim 中は simulator を suspend / reset し、復帰時に古い補正を再生しない。
- `motionIntensity` は idle procedural 専用のまま維持する。よろめきの gain / stiffness / damping / propagation / recovery / max angle は別 parameter とする。
- 制御対象は hips / spine / chest / head / upper arms の normalized humanoid bone に限定する。髪・服など VRM spring bone には直接注入しない。
- ForceEvent の契約空間は model space。world-space producer は adapter の共通変換入口を使う。

## なぜそう決めたか

MotionScheduler は single-active stop model であり、critical-reflex clip としてよろめきを入れると現在の VRMA を停止する。「元の motion を続けたまま外力が身体に滲む」という目的には additive channel が必要になる。

二地点 hook は、前 frame の correction を次 frame の animation target と誤認して自己増幅することを防ぐ。`vrm.update()` 前に normalized bone へ一度だけ合成すれば、補正済み primary pose が raw bone に転送され、その親運動を既存 spring bone が自然に受け取れる。

感触値は仕様値ではない。Common Leva panel のデモで実 VRM を観察し、帰納的に調整する暫定値とする。

## 検討したが却下した代替案

### MotionScheduler の critical-reflex clip

active animation を preempt するため却下。外力反応は clip の所有権ではなく pose 差分である。

### ProceduralBones / motionIntensity への統合

idle motion の強度という既存契約を壊し、外界 event と自律 motion の調整軸が混ざるため却下。

### 髪・服 spring bone への直接 impulse

body 親運動に加えて同じ力を二重に受け、増幅するため却下。

## この決定の implication / 制約

- producer は demo / terminal / agent / user の由来を問わず同じ model-space `ForceEvent` を注入する。
- Body adapter に spring / collision の物理ロジックを追加しない。backend の変更は `packages/yoromeki` 内で閉じる。
- teleport / VRM 差し替えでは simulator reset と normalized bone mapping の再構築を行う。
- Leva の初期値・range は実機評価で変更可能であり、互換仕様として固定しない。

## 関連 reference

- `packages/yoromeki/src/` — VRM 非依存 simulator / collision helper
- `src/core/body/stagger-adapter.ts` — VRM mapping / 二地点 hook / world→model 変換
- `src/core/body/index.ts` — Body update への挿入位置
- `src/core/debug-controls/stagger-demo.tsx` — R3F 落下 producer / Common Leva controls
- [motion-intensity.md](motion-intensity.md) — idle procedural 専用ノブ
- internal design-record: 2026-07-12-yoromeki-active-secondary-response-design.md

## 改訂履歴

- 2026-07-12 作成：additive channel、二地点 hook、library / adapter 境界、spring bone と motionIntensity からの分離を記録。
