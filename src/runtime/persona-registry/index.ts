/**
 * PersonaRegistry barrel. Phase 3.3(g.4) real implementation.
 *
 * Philosophy: docs/INHABITED_INTERFACE_PHILOSOPHY.md「多人格の住人」+「自己生成 loop」
 * SDK surface: src/sdk/persona.d.ts の PersonaDefinition + src/sdk/context.d.ts の PersonaContext
 */

export { PersonaRegistry, type PersonaRegistryDeps } from "./persona-registry";
export { createRealPersonaContextFactory, type RealContextDeps } from "./real-context";
export {
  createStubPersonaContextFactory,
  type PersonaContextFactory,
  type PersonaContextInputs,
} from "./stub-context";
