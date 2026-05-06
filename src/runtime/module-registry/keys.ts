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
  /** AttentionRuntime singleton: source ごとの AttentionTarget を集約し、resolver で 1 本に絞った snapshot を publish する。 */
  ATTENTION_RUNTIME: "attention:runtime",
  /** AmbientUiPackRegistry singleton: ambient-ui pack の登録と active 集合（multi-active）を管理する。 */
  AMBIENT_UI_PACK_REGISTRY: "ambient-ui-pack:registry",
  /** ModuleRegistry singleton (Phase 1). */
  MODULE_REGISTRY: "registry:module",
  /** PersonaRegistry singleton (persona single-active plan): 登録済み persona と active state。 */
  PERSONA_REGISTRY: "persona:registry",
  /** ScenePackRegistry singleton (Phase 2 scene-pack-loader): 登録済み scene pack と active state。 */
  SCENE_PACK_REGISTRY: "scene-pack:registry",
  /** TerminalRuntime singleton (Phase 0b v2): xterm + PTY Channel の webview-lifetime 保持。 */
  TERMINAL_RUNTIME: "terminal:runtime",
  /** ClaimState singleton (ui-pack plan 2): UI pack が本体自動処理を一時 suspend する状態。 */
  UI_CLAIM_STATE: "ui-claim:state",
  /** UiPackRegistry singleton (ui-pack plan): 登録済み UI pack と active state。 */
  UI_PACK_REGISTRY: "ui-pack:registry",
  /** UiStateStore singleton (ui-pack plan 3): UI pack と MCP が共有する key-value state。 */
  UI_STATE_STORE: "ui-state:store",
  /** ThreeRuntime singleton (Phase 2): canvas + renderer + RAF + VRM + Body の webview-lifetime 保持。 */
  THREE_RUNTIME: "three:runtime",
  /** VrmCache singleton (Phase 2.5): URL → ArrayBuffer の LRU。 */
  VRM_CACHE: "vrm:cache",
  /** PresenceIntensity singleton: 住人の存在強度（default / closed）を管理する。 */
  PRESENCE_INTENSITY: "presence-intensity:state",
  /** SessionRegistry singleton: 全 session の descriptor / lifecycle / activity と event dispatch。 */
  SESSION_REGISTRY: "session:registry",
  /** SessionTabManager singleton: session タブの状態管理 + auto-respawn。 */
  SESSION_TAB_MANAGER: "session-tabs:manager",
} as const;

export type KnownKey = (typeof KEYS)[keyof typeof KEYS];
