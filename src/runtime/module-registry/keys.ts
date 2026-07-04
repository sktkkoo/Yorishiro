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
  /** Attention light notification setting singleton: config-backed on/off state for runtime red flash light. */
  ATTENTION_LIGHT_SETTINGS: "attention-light:settings",
  /** AttentionLightCueStore singleton: attention light の cue（一度きりの光の合図）を dedup / toggle / cooldown 込みで一元管理する。 */
  ATTENTION_LIGHT_CUE: "attention-light:cue",
  /** AmbientUiPackRegistry singleton: ambient-ui pack の登録と active 集合（multi-active）を管理する。 */
  AMBIENT_UI_PACK_REGISTRY: "ambient-ui-pack:registry",
  /** AmenityPackRegistry singleton: amenity pack の登録と active 集合（multi-active）を管理する。 */
  AMENITY_PACK_REGISTRY: "amenity-pack:registry",
  /** ModuleRegistry singleton (Phase 1). */
  MODULE_REGISTRY: "registry:module",
  /** PersonaRegistry singleton (persona single-active plan): 登録済み persona と active state。 */
  PERSONA_REGISTRY: "persona:registry",
  /** ScenePackRegistry singleton (Phase 2 scene-pack-loader): 登録済み scene pack と active state。 */
  SCENE_PACK_REGISTRY: "scene-pack:registry",
  /** TerminalRuntime singleton (Phase 0b v2): xterm + PTY Channel の webview-lifetime 保持。 */
  TERMINAL_RUNTIME: "terminal:runtime",
  /** Terminal scene theme state: HMR 後の新規 Terminal も現在 scene の theme を参照する。 */
  TERMINAL_THEME_STATE: "terminal-theme:state",
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
  /** SurfaceRegistry singleton (shell named-surfaces P1): named surface → DOM mount node の対応表。 */
  SURFACE_REGISTRY: "surface:registry",
  /** SessionRegistry singleton: 全 session の descriptor / lifecycle / activity と event dispatch。 */
  SESSION_REGISTRY: "session:registry",
  /** SessionStatusStore singleton: session ごとの観察状態（lifecycle/activity/unread/exit）を UI 向けに集約する read model。 */
  SESSION_STATUS_STORE: "session-status:store",
  /** SessionTabManager singleton: session タブの状態管理 + auto-respawn。 */
  SESSION_TAB_MANAGER: "session-tabs:manager",
  /** WorkspaceAttentionStore singleton: host-owned attention item lifecycle + aggregate。 */
  WORKSPACE_ATTENTION_STORE: "workspace-attention:store",
} as const;

export type KnownKey = (typeof KEYS)[keyof typeof KEYS];
