# src/runtime/ — Operational backbone

> このファイルは「**pack registry / event dispatch / singleton 周りで作業する**」時に読む。対象：dev / AI。
> 上位：[../README.md](../README.md)、思想：[docs/philosophy/PHILOSOPHY.md](../../docs/philosophy/PHILOSOPHY.md)
Pack 管理、event dispatch、module registry、singleton service。core primitive を **動かす** 層。

---

## Sub-module 一覧

| Module | 責務 | Entry | 備考 |
|---|---|---|---|
| `ambient-audio/` | Scene Pack の `ambient` 宣言を Howler.js で再生する engine と ScenePackRegistry への配線 | `index.ts` | [README](./ambient-audio/README.md) |
| `event-bus/` | Trigger dispatch engine — 環境 event → trigger match → reaction emit | `event-bus.ts` | Twin-trigger / Synthetic event の dispatch loop |
| `persona-registry/` | Persona の state 管理 — **single-active**（複数 register 可、外に出すのは 1 個） | `persona-registry-impl.ts` | [decisions/persona-multi-instance.md](../../docs/decisions/persona-multi-instance.md) |
| `persona-reflex/` | Active persona の reflex（customTriggers + responses）を EventBus に bridge | `persona-reflex-dispatcher.ts` | [decisions/motion-effect-trigger-axes.md](../../docs/decisions/motion-effect-trigger-axes.md) |
| `body-scheduler/` | 複数 persona の motion 衝突解決 | `index.ts` | **skeleton**, post-MVP |
| `hot-data/` | HMR-aware singleton store（Vite reload を生き残る） | `hot-data.ts` | foundational |
| `module-registry/` | Typed registry of swappable runtime modules（VRM loader / audio player ...） | `module-registry.ts` + `keys.ts` | foundational、HMR で hot-data 経由 survive |
| `terminal-runtime/` | Webview lifetime singleton — xterm + PTY channel + terminal agent params + command run memory + perception ref | `terminal-runtime.ts` | |
| `three-runtime/` | Webview lifetime singleton — Three.js canvas / RAF / VRM model | `three-runtime.ts` | |
| `vrm-cache/` | URL → ArrayBuffer LRU cache（VRM blob） | `vrm-cache.ts` | |
| `project-context/` | 起動時 cwd から current project root を解決する accessor。scene per project の差し替え点 | `project-context.ts` | design-record `2026-07-04-main-agent-autolaunch-rethink.md` §4.3 |
| `scene-pack-registry/` | Scene pack の manifest / asset resolution | `scene-pack-registry.ts` + `asset-resolver.ts` | single-active（config picks） |
| `ui-claim-state/` | UI pack が本体自動処理を一時 suspend するための token ベース state holder | `ui-claim-state.ts` | claim/release、three-runtime と body が毎フレーム参照 |
| `ui-pack-registry/` | UI pack の single-active 管理 + config.activeUi 反映 | `ui-pack-registry.ts` | SingleActiveRegistry extend |
| `ui-state-store/` | UI pack と MCP bridge が共有する pack-scoped key-value state | `ui-state-store.ts` | `ctx.state` と `get_ui_state` / `set_ui_state` が参照。packId ごとに分離 |
| `attention-runtime/` | source ごとの AttentionTarget を集約し、resolver で 1 本に絞った AttentionSnapshot を publish する | `attention-runtime.ts` | Phase 1a で新設 |
| `ambient-ui-pack-registry/` | ambient-ui pack の登録と active 集合（multi-active）を管理。enable / disable / getActiveSet | `ambient-ui-pack-registry.ts` | Phase 1a で新設 |
| `attention-producers/` | runtime event を AttentionTarget に変換する 7 module（terminal / mouse / input-cursor / mcp / tool / dev / focused-dom）。各 producer は `start*Producer` 関数が Disposable を返す。Phase 1d で App.tsx 配線、debug fix（commits 5ebfd0d〜c0ecb23）で v1 UX に揃え（各 producer の rect / priority / 駆動方式が v1 reference に整合） | `index.ts` | Phase 1b で新設 |
| `workspace-attention/` | command run など host producer 由来の attention item lifecycle と primary / aggregate projection、presence bridge | `index.ts` | [README](./workspace-attention/README.md) |
| `bundled-attention-aura/` | bundled `attention-aura` ambient-ui pack の register helper。Phase 1d で App.tsx boot path から呼ぶ | `index.ts` | Phase 1c で新設 |
| `user-pack-loader/` | `~/.charminal/` 下の pack discovery + config read/write | `index.ts` | `charminal-io.ts` (file I/O), `config.ts` (manifest parse) |
| `charminal-mcp/` | Rust MCP server ↔ TS dispatch logic（tool call routing） | `event-channel.ts` + `tool-handlers.ts` | |
| `surface-registry/` | host 所有の named surface → DOM HTMLElement 対応表（"shell" / "character" / "chrome"）。layout / MCP / presence の DOM 解決を querySelector 直依存から名前ベースへ（shell named-surfaces P1 / chrome は P3） | `index.ts` | |

---

## 依存関係

```
core/ ◄─── event-bus/, persona-registry/, body-scheduler/

persona-reflex/  ◄─── event-bus/, persona-registry/  （subscribeActive で active persona の trigger を bus に attach）

hot-data/  ◄─── module-registry/  ◄─── core/body/, three-runtime/, ...
(foundational)   (foundational)

user-pack-loader/  ◄─── persona-registry/, scene-pack-registry/

project-context/  ◄─── bindings/tauri-commands（cwd → 正規化 project root）

terminal-runtime/, three-runtime/, vrm-cache/  — 外部 lib (xterm, three) との singleton wrapper

workspace-attention/  ◄─── terminal-runtime/, attention-runtime/, core/body/
```

`terminalAgent` は `user-pack-loader/config.ts` で parse し、`App.tsx` の user-layer bootstrap 完了後に `terminal-runtime/` へ渡す。これにより primaryPersona の prompt overlay と agent 選択が同じ gate で確定し、null prompt race / 多重 spawn を避ける。

---

## Pack registry の semantic 違い

`runtime/` 配下の pack registry には **複数 pack 種別** があり、それぞれ semantic が違う。混同しない：

| Registry | Active 数 | Override 挙動 | 主な constraint |
|---|---|---|---|
| `persona-registry/` | single-active | user > bundled、user dispose で promotion 自動取消 | [persona-multi-instance.md](../../docs/decisions/persona-multi-instance.md) |
| `scene-pack-registry/` | single-active | user > bundled (dispose + 置換) | config の `activeScene` で user picks |
| `ui-pack-registry/` | single-active | user > bundled (dispose + 置換) | config の `activeUi` で user picks。設計詳細は internal design-record: `2026-04-21-ui-pack-single-active.md` |
| `ambient-ui-pack-registry/` | **multi-active**（集合） | enable / disable / getActiveSet で操作 | primary UI を奪わない overlay 系 pack（attention aura など）。複数 pack が重なる前提 |
| Effect (event-driven) | 複数並行 | bundled-over-user の挙動は未確定 | 整理されていない領域、care |

**設計原則**：「scene と effect はどちらも pack だが、動作 model が違うので別 concept として独立に扱う」。表面的類似で統合しない。

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
- User config：[docs/configuration.md](../../docs/configuration.md)
- 制約：[docs/decisions/critical-constraints.md](../../docs/decisions/critical-constraints.md) §3 Synthetic event、§4 Twin-trigger
- Terminal agent：[docs/decisions/codex-terminal-agent.md](../../docs/decisions/codex-terminal-agent.md)
- 内部設計記録：`../Charminal-design-record/2026-04-19-core-mcp-pack-layers.md` (core / pack / MCP の層構造)
