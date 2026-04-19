/**
 * PersonaRegistry barrel — runtime persona subsystem の public API。
 *
 * Phase 3.3(g.4) の旧 EventBus-bridge PersonaRegistry と、
 * persona single-active plan の新 PersonaRegistryImpl の両方を export する。
 * App.tsx は Task 8 で新 registry を使うよう切り替える。
 *
 * Philosophy: docs/philosophy/INHABITED_INTERFACE_PHILOSOPHY.md「多人格の住人」
 * SDK surface: src/sdk/persona.d.ts の PersonaDefinition + src/sdk/context.d.ts の PersonaContext
 */

export { PersonaRegistry, type PersonaRegistryDeps } from "./persona-registry";
// single-active registry（persona single-active plan）
export {
  getPersonaRegistry,
  PersonaRegistryImpl,
  type PersonaRegistryImplOptions,
} from "./persona-registry-impl";
export { createRealPersonaContextFactory, type RealContextDeps } from "./real-context";
export { computeActivePersona } from "./select-active";
export {
  createStubPersonaContextFactory,
  type PersonaContextFactory,
  type PersonaContextInputs,
} from "./stub-context";
export type {
  Disposable,
  PackOrigin,
  PersonaEntry,
  PersonaRegistry as PersonaRegistryInterface,
} from "./types";
