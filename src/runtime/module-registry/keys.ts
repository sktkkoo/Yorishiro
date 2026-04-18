/**
 * Known hotData keys used by Charminal's runtime singletons.
 *
 * Convention: "<phase-or-domain>:<module>" — the prefix is for human grep,
 * not parsed at runtime. Each addition here is a one-line entry; do NOT
 * computed-construct keys at call sites.
 *
 * Why a const namespace instead of bare strings:
 * - Typo-safety at the call site (the only valid argument is `KEYS.X`).
 * - Single grep target when auditing what survives across HMR.
 * - Forces a deliberate add-step when a new singleton joins the runtime.
 */
export const KEYS = {
  /** App.tsx runtime singleton (Phase 0b): time / bus / registry / perception / logBridge. */
  APP_RUNTIME: "app:runtime",
  /** ModuleRegistry singleton (Phase 1). */
  MODULE_REGISTRY: "registry:module",
  /** ScenePackRegistry singleton (Phase 2 scene-pack-loader): 登録済み scene pack と active state。 */
  SCENE_PACK_REGISTRY: "scene-pack:registry",
  /** TerminalRuntime singleton (Phase 0b v2): xterm + PTY Channel の webview-lifetime 保持。 */
  TERMINAL_RUNTIME: "terminal:runtime",
  /** ThreeRuntime singleton (Phase 2): canvas + renderer + RAF + VRM + Body の webview-lifetime 保持。 */
  THREE_RUNTIME: "three:runtime",
  /** VrmCache singleton (Phase 2.5): URL → ArrayBuffer の LRU。 */
  VRM_CACHE: "vrm:cache",
} as const;

export type KnownKey = (typeof KEYS)[keyof typeof KEYS];
