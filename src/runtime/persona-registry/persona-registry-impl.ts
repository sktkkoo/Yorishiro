/**
 * PersonaRegistryImpl — single-active persona の宣言を保管し、active persona を選択する primitive。
 *
 * Scene pack registry と対称な single-active semantics で retrofit
 * （memory: feedback_pack_override_pattern.md）。
 *
 * override 挙動：user が bundled を dispose + 置換。
 * reference 比較で listener fire — 同 id でも persona object が変われば fire する。
 *
 * Internal design-record: 2026-04-19-persona-single-active.md
 */

import type { PersonaDefinition } from "../../sdk/persona";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { computeActivePersona } from "./select-active";
import type {
  Disposable,
  PersonaEntry,
  PersonaRegistry as PersonaRegistryInterface,
} from "./types";

export interface PersonaRegistryImplOptions {
  /** 診断ログ（bundled-over-user warning、bundled collision 等） */
  readonly warn?: (msg: string) => void;
}

export class PersonaRegistryImpl implements PersonaRegistryInterface {
  private readonly entries = new Map<string, PersonaEntry>();
  private readonly listeners = new Set<(persona: PersonaDefinition | null) => void>();
  private primaryPersonaId: string | null = null;
  /**
   * primaryPersonaId が register 内の override 促進（"bundled を user が同 id で上書きした時に
   * active を user 側に引き継ぐ"）経由で set されたか。`setPrimaryPersona` 経由で set された
   * 場合は false。これにより user entry が後で dispose された時、promotion 由来の id を
   * 掃除して「別の user pack が同 id で来たら Design B に反して auto-select される」を防ぐ。
   */
  private primaryPersonaIdIsPromoted = false;
  /**
   * 最後に fire した persona の reference。id ではなく reference 比較する。
   * 同 id で user が bundled を override した場合、id は同じでも persona object
   * が変わる — この時 listener は fire すべき（React state 更新が必要）。
   * id 比較だと miss する（scene-pack-registry Phase 1 review で修正された gotcha と同じ）。
   */
  private lastActivePersona: PersonaDefinition | null = null;
  private readonly warn: (msg: string) => void;

  constructor(opts: PersonaRegistryImplOptions = {}) {
    this.warn = opts.warn ?? ((msg) => console.warn(`[PersonaRegistry] ${msg}`));
  }

  register(entry: PersonaEntry): Disposable {
    const existing = this.entries.get(entry.id);
    if (existing === undefined) {
      this.entries.set(entry.id, entry);
    } else {
      if (entry.origin === "user") {
        // user が来たら existing を dispose + 置換。
        // bundled を override した場合は primaryPersonaId をこの id に昇格する：
        // computeActivePersona は bundled 以外を auto-select しないため、置換後に
        // primaryPersonaId が null だと user entry が選ばれなくなる。
        this.entries.set(entry.id, entry);
        if (existing.origin === "bundled" && this.primaryPersonaId === null) {
          this.primaryPersonaId = entry.id;
          this.primaryPersonaIdIsPromoted = true;
        }
      } else {
        // incoming が bundled
        if (existing.origin === "user") {
          // 起こるはず無い（load 順序は bundled → user）。起きたら warning、incoming を ignore
          this.warn(`bundled "${entry.id}" arrived after user registration — ignored (user wins)`);
        } else {
          // bundled 同士 — 開発ミス相当。後勝ち + warning
          this.warn(`bundled id collision for "${entry.id}" — overwriting`);
          this.entries.set(entry.id, entry);
        }
      }
    }

    this.reselect();

    return {
      dispose: () => {
        if (this.entries.get(entry.id) === entry) {
          this.entries.delete(entry.id);
          // promotion 由来で active に昇格した id が、その同じ entry の dispose で消えるなら
          // primaryPersonaId を null に戻す（Design B の "user は auto-select されない" を守る）
          if (this.primaryPersonaIdIsPromoted && this.primaryPersonaId === entry.id) {
            this.primaryPersonaId = null;
            this.primaryPersonaIdIsPromoted = false;
          }
          this.reselect();
        }
      },
    };
  }

  getActivePersona(): PersonaDefinition | null {
    const entry = computeActivePersona(Array.from(this.entries.values()), this.primaryPersonaId);
    return entry?.persona ?? null;
  }

  subscribeActive(listener: (persona: PersonaDefinition | null) => void): Disposable {
    this.listeners.add(listener);
    listener(this.getActivePersona());
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  setPrimaryPersona(id: string | null): void {
    this.primaryPersonaId = id;
    this.primaryPersonaIdIsPromoted = false;
    this.reselect();
  }

  listEntries(): ReadonlyArray<PersonaEntry> {
    return Array.from(this.entries.values());
  }

  private reselect(): void {
    const active = computeActivePersona(Array.from(this.entries.values()), this.primaryPersonaId);
    const persona = active?.persona ?? null;
    // reference 比較：同 id でも persona object が違えば fire する
    if (persona === this.lastActivePersona) return;
    this.lastActivePersona = persona;
    for (const listener of Array.from(this.listeners)) {
      listener(persona);
    }
  }
}

/** singleton accessor。HMR をまたいで 1 instance のみ。 */
export function getPersonaRegistry(): PersonaRegistryInterface {
  return getOrInit(KEYS.PERSONA_REGISTRY, () => new PersonaRegistryImpl());
}
