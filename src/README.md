# src/ — TypeScript layer overview

> このファイルは「**TS 側のどこに何があるか**」を 1 画面で把握したい時に読む。対象：dev / AI。
> 上位 navigation は [docs/README.md](../docs/README.md)。

Charminal の **canonical runtime**。意識層 (Claude Code / Codex) との接続、反射層 (primitives)、UI、pack 管理、SDK 公開を担う。Rust 側は IO のみ、設計判断はすべてこちら。

---

## Top-level

| Directory | 責務 | 詳細 README |
|---|---|---|
| `core/` | Presence Harness の primitive 層（身体 / 時間 / 知覚 / 表現 / 場 / scene / 相互作用 / log 回路） | [core/README.md](core/README.md) |
| `runtime/` | Pack 管理 / event dispatch / module registry / singleton services | [runtime/README.md](runtime/README.md) |
| `sdk/` | Pack 作者向け型定義と API contract（公開 surface、TypeDoc 対象） | [sdk/README.md](sdk/README.md) |
| `bindings/` | Tauri command bridge（TS ↔ Rust） | — |
| `App.tsx` | React tree + 全 runtime stack の初期化 | — |
| `main.tsx` | React DOM mount | — |

その他直下の UI component（`sidebar.tsx`（chrome only）, `character-surface.tsx`（VRM/scene viewport）, `terminal.tsx`, `vrm-viewer.tsx`）は App.tsx から直接 import。

### core/ 主要 sub-module（抜粋）

| Sub-module | 責務 |
|---|---|
| `core/ui-layout/` | UI pack の layout spec を HTMLElement style に適用する engine |
| （他 sub-module は [core/README.md](core/README.md) 参照） | — |

### runtime/ 主要 sub-module（抜粋）

| Sub-module | 責務 |
|---|---|
| `runtime/ui-pack-registry/` | single-active な UI pack の registry（config.activeUi 反映） |
| `runtime/session-tabs/` | Session タブの状態管理（open/close/switch）・capture phase keybindings・agent auto-respawn |
| `runtime/surface-registry/` | host 所有の named surface → DOM mount 対応表（"shell" / "character" / "chrome"）。layout / MCP / presence の DOM 解決を querySelector 直依存から名前ベースへ（shell named-surfaces P1 / chrome は P3） |
| （他 sub-module は [runtime/README.md](runtime/README.md) 参照） | — |

---

## 依存関係（高水位）

```
              App.tsx
              │
   ┌──────────┼──────────┬──────────┐
   ▼          ▼          ▼          ▼
 core/    runtime/    sdk/      bindings/
   │          │       (型のみ)   (Tauri)
   │          │
   │   ┌──────┴──────┐
   │   │             │
   ▼   ▼             ▼
hot-data       module-registry
(foundational)  (foundational)
```

- `core/` と `runtime/` は密に依存、`sdk/` は型のみで runtime 依存なし
- `runtime/hot-data/` と `runtime/module-registry/` は他から widely 参照される foundational layer
- `bindings/` は Tauri との thin wrapper

---

## 初期化順序（App.tsx）

1. **Time** — 基底時刻エンジン（最初に立てる、他全部が依存）
2. **DevLog** → EventBus に attach（development logging）
3. **Perception** → EventBus に subscribe（環境観察開始）
4. **PersonaRegistry** → EventBus に subscribe（active persona の reaction dispatch）
5. **TerminalRuntime** mount → xterm instance + terminal agent params + PTY 接続
6. **ThreeRuntime** mount → Three.js canvas + VRM loader
7. **EffectDispatcher** + **EffectPackRunner** → screen-shake などの effect register
8. **BodyScheduler** — skeleton のまま（post-MVP）

順序を変える場合は影響を慎重に確認（特に Time → 他 / EventBus → subscribers の依存）。

---

## 命名

- **Directory**: kebab-case（`log-bridge/`, `two-layer/`）
- **File**: camelCase（`logBridge.ts`）または kebab-case（`log-bridge.ts`）混在可
- **Type / Class**: PascalCase
- **Function / variable**: camelCase
- **Constant**: SCREAMING_SNAKE_CASE

詳細・rationale は project root [CLAUDE.md](../CLAUDE.md) §Coding conventions。

---

## 自動生成 doc

```bash
npm run doc           # typedoc で src/sdk/ を docs/api/typescript/ に出力
open docs/api/typescript/index.html
```

API surface（pack 作者向け）の正本は **typedoc 出力 + sdk/README.md**。手書き doc を増やさない。

---

## 関連 doc

- 思想：[docs/philosophy/CHARMINAL.md](../docs/philosophy/CHARMINAL.md), [docs/philosophy/PRESENCE_HARNESS.md](../docs/philosophy/PRESENCE_HARNESS.md)
- 制約：[docs/decisions/critical-constraints.md](../docs/decisions/critical-constraints.md)
- 内部設計記録（別 repo）：`../Charminal-design-record/`
