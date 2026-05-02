/**
 * PersonaRegistryImpl — single-active persona の宣言を保管し、active persona を
 * 選択する primitive。
 *
 * 実体は `SingleActiveRegistry<PersonaEntry, PersonaDefinition>` で、本 class は
 * domain 固有の getter/setter alias（`getActivePersona` / `setPrimaryPersona`）を
 * 提供するだけ。共通 semantic（override pattern, promotion, reference fire,
 * collision warning 等）はすべて base の docstring を参照。
 *
 * Internal design-record: 2026-04-19-persona-single-active.md
 */

import type { PersonaDefinition } from "../../sdk/persona";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { SingleActiveRegistry } from "../single-active-registry";
import type { PersonaEntry, PersonaRegistry as PersonaRegistryInterface } from "./types";

export interface PersonaRegistryImplOptions {
  /** 診断ログ（bundled-over-user warning、bundled collision 等） */
  readonly warn?: (msg: string) => void;
}

export class PersonaRegistryImpl
  extends SingleActiveRegistry<PersonaEntry, PersonaDefinition>
  implements PersonaRegistryInterface
{
  constructor(opts: PersonaRegistryImplOptions = {}) {
    super({
      extractValue: (entry) => entry.persona,
      label: "PersonaRegistry",
      warn: opts.warn,
    });
  }

  /** Domain alias：base の `getActive()` を persona 名で expose。 */
  getActivePersona(): PersonaDefinition | null {
    return this.getActive();
  }

  /** Domain alias：base の `setActive()` を persona 名で expose。 */
  setPrimaryPersona(id: string | null): void {
    this.setActive(id);
  }

  /** Domain alias：base の `getActiveId()` を persona 名で expose。 */
  getActivePersonaId(): string | null {
    return this.getActiveId();
  }
}

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getPersonaRegistry(): PersonaRegistryInterface {
  return getOrInit(KEYS.PERSONA_REGISTRY, () => new PersonaRegistryImpl());
}
