# src/runtime/ — Operational backbone

> このファイルは「**pack registry / event dispatch / singleton 周りで作業する**」時に読む。対象：dev / AI。
> 上位：[../README.md](../README.md)、思想：[docs/philosophy/PRESENCE_HARNESS.md](../../docs/philosophy/PRESENCE_HARNESS.md)（Twin-trigger / Synthetic event）

Pack 管理、event dispatch、module registry、singleton service。core primitive を **動かす** 層。

---

## Sub-module 一覧

| Module | 責務 | Entry | 備考 |
|---|---|---|---|
| `event-bus/` | Trigger dispatch engine — 環境 event → trigger match → reaction emit | `event-bus.ts` | Twin-trigger / Synthetic event の dispatch loop |
| `persona-registry/` | Persona の state 管理 — **single-active**（複数 register 可、外に出すのは 1 個） | `persona-registry-impl.ts` | [decisions/persona-multi-instance.md](../../docs/decisions/persona-multi-instance.md) |
| `persona-reflex/` | Active persona の reflex（customTriggers + responses）を EventBus に bridge | `persona-reflex-dispatcher.ts` | [decisions/motion-effect-trigger-axes.md](../../docs/decisions/motion-effect-trigger-axes.md) |
| `body-scheduler/` | 複数 persona の motion 衝突解決 | `index.ts` | **skeleton**, post-MVP |
| `hot-data/` | HMR-aware singleton store（Vite reload を生き残る） | `hot-data.ts` | foundational |
| `module-registry/` | Typed registry of swappable runtime modules（VRM loader / audio player ...） | `module-registry.ts` + `keys.ts` | foundational、HMR で hot-data 経由 survive |
| `terminal-runtime/` | Webview lifetime singleton — xterm + PTY channel + perception ref | `terminal-runtime.ts` | |
| `three-runtime/` | Webview lifetime singleton — Three.js canvas / RAF / VRM model | `three-runtime.ts` | |
| `vrm-cache/` | URL → ArrayBuffer LRU cache（VRM blob） | `vrm-cache.ts` | |
| `scene-pack-registry/` | Scene pack の manifest / asset resolution | `scene-pack-registry.ts` + `asset-resolver.ts` | single-active（config picks） |
| `ui-claim-state/` | UI pack が本体自動処理を一時 suspend するための token ベース state holder | `ui-claim-state.ts` | claim/release、three-runtime と body が毎フレーム参照 |
| `ui-pack-registry/` | UI pack の single-active 管理 + config.activeUi 反映 | `ui-pack-registry.ts` | SingleActiveRegistry extend |
| `ui-state-store/` | UI pack と MCP bridge が共有する pack-scoped key-value state | `ui-state-store.ts` | `ctx.state` と `get_ui_state` / `set_ui_state` が参照。packId ごとに分離 |
| `user-pack-loader/` | `~/.charminal/` 下の pack discovery + config read/write | `index.ts` | `charminal-io.ts` (file I/O), `config.ts` (manifest parse) |
| `charminal-mcp/` | Rust MCP server ↔ TS dispatch logic（tool call routing） | `event-channel.ts` + `tool-handlers.ts` | |

---

## 依存関係

```
core/ ◄─── event-bus/, persona-registry/, body-scheduler/

persona-reflex/  ◄─── event-bus/, persona-registry/  （subscribeActive で active persona の trigger を bus に attach）

hot-data/  ◄─── module-registry/  ◄─── core/body/, three-runtime/, ...
(foundational)   (foundational)

user-pack-loader/  ◄─── persona-registry/, scene-pack-registry/

terminal-runtime/, three-runtime/, vrm-cache/  — 外部 lib (xterm, three) との singleton wrapper
```

---

## Pack registry の semantic 違い

`runtime/` 配下の pack registry には **複数 pack 種別** があり、それぞれ semantic が違う。混同しない：

| Registry | Active 数 | Override 挙動 | 主な constraint |
|---|---|---|---|
| `persona-registry/` | single-active | user > bundled、user dispose で promotion 自動取消 | [persona-multi-instance.md](../../docs/decisions/persona-multi-instance.md) |
| `scene-pack-registry/` | single-active | user > bundled (dispose + 置換) | config の `activeScene` で user picks |
| `ui-pack-registry/` | single-active | user > bundled (dispose + 置換) | config の `activeUi` で user picks。設計詳細は internal design-record: `2026-04-21-ui-pack-single-active.md` |
| Effect (event-driven) | 複数並行 | bundled-over-user の挙動は未確定 | 整理されていない領域、care |

**設計原則**：「scene と effect はどちらも pack だが、動作 model が違うので別 concept として独立に扱う」。表面的類似で統合しない（[memory: feedback_separate_conceptually_distinct_systems](../../.claude/projects/-Users-user-Charminal/memory/feedback_separate_conceptually_distinct_systems.md)）。

---

## HMR と singleton

`hot-data` と `module-registry` が widely 使われる理由：Vite HMR で module が reload されても state を失わない singleton store。これがないと VRM model や Three.js scene が reload で消えて画面が落ちる。

`getOrInit(key, init)` pattern：

```typescript
const renderer = getOrInit(KEYS.threeRenderer, () => createRenderer());
```

詳細：design-record `2026-04-15-phase-0a-hot-data-wrapper.md`、`2026-04-17-implementation-log-v0.0.1.md` Arc G。

---

## Index export 方針

`runtime/index.ts` は **EventBus / PersonaRegistryImpl / PersonaReflexDispatcher / BodyScheduler のみ** export。`hot-data` / `module-registry` は **direct import 推奨**（barrel export しない）。foundational なものに引きずられて他がバンドルされるのを避ける。

---

## 関連 doc

- API（pack 作者向け）：[../sdk/README.md](../sdk/README.md)
- 制約：[docs/decisions/critical-constraints.md](../../docs/decisions/critical-constraints.md) §3 Synthetic event、§4 Twin-trigger
- 内部設計記録：`../Charminal-design-record/2026-04-19-core-mcp-pack-layers.md` (core / pack / MCP の層構造)
