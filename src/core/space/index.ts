/**
 * Space primitives barrel.
 *
 * Philosophy: docs/philosophy/PRESENCE_HARNESS.md「六要素 > 空間」
 * SDK surface: src/sdk/context.d.ts の SpaceAPI（399–443）
 *
 * 本 skeleton は Phase 3.3(g.1) で配置。real 実装は Phase 3.5+ で TDD 予定。
 */

export { EffectDispatcher, type EffectListener } from "./effect-dispatcher";
export { EffectPackRunner, type EffectPackRunnerDeps } from "./effect-pack-runner";
export { Renderer, type RendererDeps } from "./renderer";
export { computeShakeOffset, type ShakeOffset } from "./shake";

export class Space {}
