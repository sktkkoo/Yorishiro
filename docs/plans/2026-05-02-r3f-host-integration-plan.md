# R3F Host Integration Implementation Plan

**Date:** 2026-05-02  
**Branch:** `feat/r3f-host-integration-plan`  
**Worktree:** `/Users/user/Charminal-r3f-host-integration-plan`

## Goal

React Three Fiber を Charminal に再導入する。ただし前回の Phase 1 のように
`ThreeRuntime` を廃止して `<Canvas>` へ全面移行しない。

今回の目標は、既存 `ThreeRuntime` が持っている安定した renderer / scene / camera /
RAF / pull-based resize / external API を維持したまま、その内側に R3F custom root を
差し込むこと。これにより、将来の room scene / GLB / postprocess / R3F scene pack を
既存 VRM と同じ `THREE.Scene` 上で扱えるようにする。

## Background

`specs/2026-05-01-r3f-migration-phase1.md` の追記では、`<Canvas>` 方式は見送りに
なっている。原因は sidebar width tween 中に `<Canvas>` の resize path が
`react-use-measure` 経由で連続 React update を起こし、メインスレッドが詰まって
描画が消えたこと。

現行 `ThreeRuntime` は以下を安定して担っている。

- WebGLRenderer / Scene / Camera の lifetime
- body 直下ではなく character slot への attach / detach
- RAF loop と `THREE.Clock`
- `clientWidth/clientHeight` による pull-based resize
- VRM load / dispose / rest pose
- `Body.update(delta, elapsed)` と head tracking
- `TweenManager.tick(performance.now())`
- UI pack / MCP handler / effect handler 向け imperative API

この安定化層を消すのではなく、R3F の host として使う。

## Non-Goals

- `src/runtime/three-runtime` を Phase 1 で削除しない
- `src/vrm-viewer.tsx` を Phase 1 で削除しない
- `App.tsx` の `getThreeRuntime()` 参照を大量に置き換えない
- VRM / Body lifecycle を最初から `useFrame` component に移さない
- `@react-three/drei`, `@react-three/postprocessing`, `@react-three/rapier` は host が安定するまで追加しない
- CSS layer scene pack を即座に廃止しない

## Design Principles

1. **No `<Canvas>` in the app tree.**  
   `<Canvas>` の resize observer path を避ける。R3F は `createRoot(existingCanvas)` で起動する。

2. **One renderer, one scene, one camera.**  
   現行 `ThreeRuntime` が作る `WebGLRenderer`, `THREE.Scene`, `PerspectiveCamera` を R3F root に渡す。

3. **One RAF owner.**  
   R3F は `frameloop: "never"` にし、既存 RAF loop から手動で進める。

4. **Pull-based resize stays.**  
   `handleResize()` は今のまま placeholder の `clientWidth/clientHeight` を読む。R3F state の size は寸法変化時だけ同期する。

5. **Public API stability first.**  
   `getCamera()`, `getScene()`, `getRenderer()`, `getVrm()`, `getBody()`, `getTweenManager()` はそのまま維持する。

6. **Prove the host before moving VRM.**  
   初回 milestone は R3F test object / light / empty scene root の安定稼働確認。VRM を R3F component に移すのは後段。

## Target Architecture

```text
ThreeRuntimeImpl
├── canvasContainer / canvas
├── WebGLRenderer
├── THREE.Scene              ← imperative VRM + R3F objects share this
├── PerspectiveCamera
├── TweenManager
├── VRM / Body lifecycle     ← Phase 1 remains imperative
├── R3fHost                  ← createRoot(canvas), frameloop="never"
└── RAF loop
    ├── handleResize()
    ├── tweenManager.tick(performance.now())
    ├── Body.update(delta, elapsed)
    ├── r3fHost.advance(now)  ← runs R3F useFrame + render
    └── fallback renderer.render(scene, camera) if R3F root is not ready
```

R3F root should be configured with the existing objects:

```ts
await root.configure({
  gl: renderer,
  scene,
  camera,
  frameloop: "never",
  // events are disabled in Phase 1 unless a concrete interaction needs them.
});
```

Exact type signatures must be verified against installed `@react-three/fiber` v9 types during implementation.
Official docs state that custom roots have the same options as `Canvas`, require an existing canvas, and leave resizing to the caller.

## Files

### New

| File | Purpose |
|---|---|
| `src/runtime/three-runtime/r3f-host.tsx` | Owns R3F custom root lifecycle and bridges size / advance / render content |
| `src/runtime/three-runtime/r3f-runtime-root.tsx` | Minimal R3F tree mounted by the host; exposes RootState and future scene slots |
| `src/runtime/three-runtime/r3f-host.test.ts` | Unit tests for host lifecycle where practical, using injected root factory or mocks |
| `docs/plans/2026-05-02-r3f-host-integration-plan.md` | This implementation plan |

### Modified

| File | Purpose |
|---|---|
| `package.json` / `package-lock.json` | Add `@react-three/fiber` only |
| `src/runtime/three-runtime/three-runtime.ts` | Initialize R3F host, sync resize, drive manual frame, keep public API stable |
| `src/runtime/three-runtime/types.ts` | Add internal-facing scene/R3F methods only if needed; avoid SDK-facing API churn |
| `src/README.md` / `src/core/scene/README.md` | Update architecture notes after implementation, not before host is verified |

## Task Plan

### Task 1: Add R3F dependency

- [ ] Run `npm install @react-three/fiber`
- [ ] Confirm React 19 pairs with R3F v9
- [ ] Run `npm run check`
- [ ] Commit: `feat: add react-three-fiber dependency`

Notes:
- Do not add drei/postprocessing/rapier yet.
- If dependency resolution changes `three` or React unexpectedly, stop and inspect before proceeding.

### Task 2: Build `R3fHost`

- [ ] Create `src/runtime/three-runtime/r3f-host.tsx`
- [ ] Use `createRoot(canvas)` from `@react-three/fiber`
- [ ] Configure root with existing `renderer`, `scene`, `camera`, `frameloop: "never"`
- [ ] Capture `RootState` from a small bridge component using `useThree()`
- [ ] Expose methods:
  - [ ] `initialize(): Promise<void>`
  - [ ] `render(element: React.ReactNode): void`
  - [ ] `advance(timestampMs: number): void`
  - [ ] `setSize(width: number, height: number, left?: number, top?: number): void`
  - [ ] `dispose(): void`
  - [ ] `isReady(): boolean`
- [ ] Keep events disabled initially unless required by R3F internals
- [ ] Ensure `dispose()` unmounts the root and does not dispose `renderer`, `scene`, or `camera`
- [ ] Commit: `feat: add R3F host for existing ThreeRuntime canvas`

Implementation notes:
- Prefer public R3F APIs. If root state access requires an internal field, instead capture `RootState` through a rendered bridge component.
- `setSize` must run only when dimensions change, matching current `handleResize()` cadence.
- Be explicit about render ownership. If `advance()` renders, do not also call `renderer.render()` in the same frame.

### Task 3: Integrate host into `ThreeRuntime`

- [ ] Add `private readonly r3fHost: R3fHost`
- [ ] Initialize it after renderer / scene / camera construction
- [ ] Render a minimal root component with no visible objects by default
- [ ] Change RAF loop ordering:
  - [ ] compute `delta` and `elapsed`
  - [ ] `handleResize()`
  - [ ] `tweenManager.tick(performance.now())`
  - [ ] update Body pointer reference
  - [ ] `currentBody.update(delta, elapsed)`
  - [ ] camera head tracking
  - [ ] if R3F host ready: `r3fHost.advance(now)`
  - [ ] else: `renderer.render(scene, camera)`
- [ ] Update `handleResize()` to also call `r3fHost.setSize(...)` when dimensions changed
- [ ] Confirm `getRenderer()`, `getScene()`, `getCamera()` still return the same objects
- [ ] Commit: `refactor: drive R3F host from ThreeRuntime render loop`

Critical detail:
- `Body.update()` already calls `vrm.update(delta)`, so no R3F component should call `vrm.update()` again.

### Task 4: Add a gated visual smoke component

- [ ] Add a tiny R3F component under `r3f-runtime-root.tsx`, gated by a runtime/dev flag
- [ ] The component should be non-invasive: e.g. a small hidden or offscreen mesh, or a temporary dev-only object
- [ ] Use `useFrame((state, delta) => ...)` to prove manual frame advance works
- [ ] Ensure it does not alter camera, lights, or VRM output in production
- [ ] Commit: `test: add gated R3F runtime smoke component`

Verification goal:
- Prove R3F `useFrame` runs from the existing RAF loop without introducing a second loop.

### Task 5: Resize stress verification

- [ ] Run app in dev mode
- [ ] Load a VRM
- [ ] Trigger sidebar width tween repeatedly through existing `ui.sidebar.set` MCP path
- [ ] Confirm no blank canvas, freeze, or severe stutter
- [ ] Confirm `handleResize()` remains the only continuous resize reader
- [ ] Inspect frame timing and `renderer.info.render.frame` if needed
- [ ] If `advance()` and manual `renderer.render()` double-render, remove the duplicate render path
- [ ] Commit fixes if needed

Manual acceptance:
- VRM remains visible while sidebar width changes
- blinking / breathing / eye movement remain smooth enough to match current runtime
- foreground/background CSS layers still compose correctly

### Task 6: Preserve external imperative behavior

- [ ] Verify `state.get` returns camera, scene, VRM, body, tween state
- [ ] Verify `scene.camera.set` still moves camera and respects camera tracking
- [ ] Verify `scene.lighting.set` still mutates scene lights
- [ ] Verify `body.expression.set` still works
- [ ] Verify camera-lighting-panel UI pack still reads/writes `ctx.three`
- [ ] Run `npm run test:run`
- [ ] Run `npm run check`
- [ ] Commit: `test: verify R3F host preserves runtime APIs`

### Task 7: Introduce first real R3F scene surface

Do this only after Tasks 1-6 are stable.

- [ ] Add an internal R3F scene slot, not exposed to user packs yet
- [ ] Render a simple room/light probe component into the shared scene
- [ ] Keep existing CSS `SceneCompositor` unchanged
- [ ] Ensure R3F scene objects do not fight existing ambient/directional lights unless intentionally replacing them
- [ ] Add a runtime switch or scene-id gate so this can be tested without changing all scenes
- [ ] Commit: `feat: add experimental R3F scene slot`

Possible implementation:

```tsx
function R3fRuntimeRoot({ experimentalScene }: Props) {
  useThreeStateBridge();
  return <>{experimentalScene ?? null}</>;
}
```

The first real target should be a minimal replacement/prototype for `simple-room`, not `misty-grasslands`.
`misty-grasslands` already has an independent renderer and should remain untouched in this pass.

### Task 8: Documentation and cleanup

- [ ] Update comments in `scene-compositor.tsx` that currently describe `ThreeRuntime` as purely external to the layer stack
- [ ] Update `src/README.md` boot sequence if R3F host is now part of runtime startup
- [ ] Document why `<Canvas>` is intentionally not used
- [ ] Document manual frame ownership and resize ownership in `r3f-host.tsx`
- [ ] Commit: `docs: document ThreeRuntime-hosted R3F architecture`

## Verification Matrix

| Area | Command / Action | Expected |
|---|---|---|
| Type/lint/Rust check | `npm run check` | Pass |
| TS/unit tests | `npm run test:run` | Pass |
| Dev app | `npm run tauri dev` | App launches; VRM visible |
| VRM Body | observe idle | blink, breathing, eyes, procedural motion work |
| Sidebar tween | MCP `ui.sidebar.set` | no render disappearance during width tween |
| Camera MCP | `scene.camera.set` | camera moves and tracking can toggle |
| Lighting MCP | `scene.lighting.set` | lights mutate existing scene |
| Scene switch | simple-room / misty-grasslands | existing CSS/procedural layers still work |
| Build | `npm run tauri build` | Pass before merge candidate |

## Risks and Mitigations

| Risk | Mitigation |
|---|---|
| R3F `advance()` renders and existing loop also renders | Make render ownership explicit; use R3F render when host is ready, fallback manual render only before readiness |
| R3F root size API changes | Use public `RootState.setSize` captured through `useThree()` instead of relying on root internals |
| Continuous `setSize` reintroduces resize churn | Call only on width/height change, exactly where current `handleResize()` already branches |
| R3F component mutates camera while MCP/camera tracking also mutates it | Require camera mutations to use `claimState` or explicit gated experiments |
| HMR keeps stale R3F content | Keep host lifetime in `ThreeRuntime`, but re-render root content from current module after HMR; document restart requirement if structural host changes |
| New dependency bloats bundle | Add only `@react-three/fiber` in Phase 1; add drei/postprocessing/rapier only with measured need |
| Scene object cleanup leaks GPU resources | Trust R3F for objects it creates; keep imperative VRM disposal path separate and unchanged |

## Exit Criteria

This branch is mergeable when:

1. R3F custom root is created from the existing ThreeRuntime canvas.
2. Existing `ThreeRuntime` public API remains compatible.
3. Existing VRM + Body behavior is unchanged.
4. Sidebar width tween no longer reproduces the previous `<Canvas>` disappearance issue.
5. `npm run check` and `npm run test:run` pass.
6. Manual `tauri dev` verification covers VRM, camera, lighting, expression, scene switching, and sidebar tween.

## References

- `../Charminal-design-record/specs/2026-05-01-r3f-migration-phase1.md`
- `../Charminal-design-record/2026-05-01-scene-rendering-pipeline-exploration.md`
- R3F Canvas / custom root docs: https://r3f.docs.pmnd.rs/api/canvas
- R3F hooks / RootState docs: https://r3f.docs.pmnd.rs/api/hooks
- R3F additional exports (`createRoot`, `advance`): https://r3f.docs.pmnd.rs/api/additional-exports
