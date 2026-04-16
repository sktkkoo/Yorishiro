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
} as const;

export type KnownKey = (typeof KEYS)[keyof typeof KEYS];
