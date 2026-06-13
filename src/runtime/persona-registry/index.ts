/**
 * PersonaRegistry barrel — runtime persona subsystem の public API。
 *
 * persona の state 管理（active 選択 / subscribeActive / single-active override）の
 * primitive を export する。reflex dispatch（EventBus への trigger 配線）は
 * src/runtime/persona-reflex/ の PersonaReflexDispatcher に分離した
 * （internal design-record: 2026-04-19-persona-registry-unification.md）。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「多人格の住人」
 * SDK surface: src/sdk/persona.d.ts の PersonaDefinition + src/sdk/context.d.ts の PersonaContext
 */

export {
  getPersonaRegistry,
  PersonaRegistryImpl,
  type PersonaRegistryImplOptions,
} from "./persona-registry-impl";
export { createRealPersonaContextFactory, type RealContextDeps } from "./real-context";
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
