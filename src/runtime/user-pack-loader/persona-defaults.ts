import type { PersonaDefinition } from "@yorishiro/sdk";

/**
 * Fill optional persona axes from the bundled default persona.
 *
 * A user persona can be intentionally small: id/name + persona.md. In that case
 * the user's thinking layer should stay theirs, while a missing reflex falls
 * back to Yorishiro's baseline body reactions.
 */
export function applyPersonaDefaults(
  persona: PersonaDefinition,
  defaults?: PersonaDefinition,
): PersonaDefinition {
  if (defaults === undefined) return persona;

  return {
    ...persona,
    reflex: persona.reflex ?? defaults.reflex,
  };
}
