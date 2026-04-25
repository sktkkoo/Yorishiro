# src/core/ — Presence Harness の primitive 層

> このファイルは「**`src/core/` 配下の primitive をどこから触るか**」を把握したい時に読む。対象：dev / AI（pack 作者は [SDK README](../sdk/README.md) のほうが近い）。
> 思想層：[docs/philosophy/PRESENCE_HARNESS.md](../../docs/philosophy/PRESENCE_HARNESS.md)（六要素の整合）、[docs/philosophy/CHARMINAL.md](../../docs/philosophy/CHARMINAL.md)（二つの層 / ログという細い回路）

キャラの **存在感と反応** の基盤。ICI の「身体」と「観察の細い回路」を形にした 6 primitive + 2 coordinator + dev support。

---

## Sub-module 一覧

| Module | 責務 | 状態 | Entry |
|---|---|---|---|
| `time/` | Charminal 独立の時間軸（async sleep / scheduling / probability sampling） | impl | `time.ts` |
| `body/` | VRM character の actuator 層（expression / animation / gaze / blink） | impl | `index.ts` |
| `perception/` | 環境 event（PTY output / hook signal / idle / window event）の観察 → DispatchEvent | impl | `perception.ts` |
| `space/` | 画面 rendering 効果（particle / shake / color filter / canvas draw） | impl | `index.ts` |
| `scene/` | VRM が "居る場所" の layer 構成（background / character / foreground 3 役） | impl | `scene-compositor.tsx` |
| `expression/` | 反射 handler の出力を body / voice / space に route する層 | **skeleton** | `index.ts` |
| `interaction/` | user との cadence 制御、engagement rhythm、idle detection | **skeleton** | `index.ts` |
| `log-bridge/` | 思考層 (Claude Code) と反射層を「ログという細い回路」で繋ぐ | impl | `index.ts` |
| `dev-log/` | development 時のみ active な generation-time mirror log | impl | `index.ts` |
| `two-layer/` | 意識層と反射層を orchestrate する coordinator | **skeleton** | `index.ts` |
| `attention/` | 注目 source（mouse / terminal / gaze）ごとの AttentionTarget 定義と resolver（複数 source → 1 本の AttentionSnapshot に合成） | impl | `index.ts` |

skeleton 標記は **API 形は決まっているが本格実装は post-MVP** の意味。

---

## 依存関係

```
time/  (no deps, foundational)
   ▲
   ├─── perception/
   ├─── space/
   ├─── log-bridge/
   ├─── dev-log/
   └─── body/  ◄─── module-registry 経由で three-runtime
                ▲
                └─── expression/  (skeleton)
                          ▲
                          └─── two-layer/ (skeleton)

scene/  (no deps, pure data + CSS)
interaction/  (skeleton, deps undecided)
```

---

## 6 primitive と思想の対応

[PRESENCE_HARNESS.md](../../docs/philosophy/PRESENCE_HARNESS.md) の「六要素」との対応：

| 思想層の要素 | core primitive |
|---|---|
| 空間 (space) | `core/space/`, `core/scene/` |
| 身体 (body) | `core/body/` |
| 時間 (time) | `core/time/` |
| 知覚 (perception) | `core/perception/` |
| 表現 (expression) | `core/expression/`（skeleton） |
| 相互作用 (interaction) | `core/interaction/`（skeleton） |

これに加えて **「ログという細い回路」** が二層を繋ぐ：

| 回路 | core module |
|---|---|
| 反射層が起こったことを記録 | `log-bridge/` |
| 開発時の mirror log | `dev-log/` |
| 意識・反射の orchestration | `two-layer/`（skeleton） |

---

## 実装上の注意

- 各 primitive は **runtime 状態を持ちすぎない**。state は `runtime/hot-data/` の HMR-survive store に置く
- `body/` は VRM expression / animation の collision を持つため、複数 persona の motion 衝突解決は `runtime/body-scheduler/` に移譲（現状 skeleton）
- `space/effect-pack-runner.ts` は user-installed effect pack を runtime invoke するエントリ
- `time/` の `afterJitter()` 過剰使用は anti-pattern（[critical-constraints](../../docs/decisions/critical-constraints.md) 関連、design-record revelation 3.8）

---

## 関連 doc

- API（型定義）：[../sdk/README.md](../sdk/README.md) の Persona/Harness/Effect Context、および Scene Pack の宣言型（context は持たない）
- 上位 layer：[../runtime/README.md](../runtime/README.md)
- philosophy 全体：[docs/philosophy/](../../docs/philosophy/)
