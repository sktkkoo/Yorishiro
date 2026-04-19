/**
 * persona.md の内容を PersonaDefinition に inject するユーティリティ。
 *
 * loader と watcher の両方から呼ばれる pure 関数として設計する。
 * Tauri / DOM 依存を持たず、vitest で直接テストできる。
 *
 * Internal design-record: 2026-04-19-persona-md-loader.md Task 6
 */

import type { PersonaDefinition } from "../../sdk/persona";

/**
 * `persona.md` から read した text を PersonaDefinition の
 * `thinking.systemPromptAddition` に inject する pure 関数。
 *
 * Priority:
 * - `.js` で明示的に thinking.systemPromptAddition が set されていればそれを優先（no-op）
 * - empty / undefined かつ md text が非空なら、trim した md text を set
 * - md text が empty / whitespace だけなら no-op
 *
 * Internal design-record: 2026-04-19-persona-md-loader.md Task 6
 */
export function injectPersonaPrompt(def: PersonaDefinition, mdText: string): PersonaDefinition {
  const existing = def.thinking?.systemPromptAddition;
  if (typeof existing === "string" && existing.trim().length > 0) {
    // .js で明示されている場合は no-op
    return def;
  }
  const trimmed = mdText.trim();
  if (trimmed.length === 0) {
    // md も空なら no-op
    return def;
  }
  return {
    ...def,
    thinking: {
      ...(def.thinking ?? {}),
      systemPromptAddition: trimmed,
    },
  };
}
