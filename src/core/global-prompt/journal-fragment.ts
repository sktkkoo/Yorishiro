/**
 * Journal フラグメント。
 *
 * journal の行動指針と memories.md の内容をグローバル system prompt に注入する。
 * どの persona であっても journal を書く。
 */

import type { ResolvedLanguage } from "../../runtime/language/language";
import { registerGlobalPromptFragment } from "./index";
import { getJournalGuide, getMemoriesHeader } from "./prompts";

async function provideJournal(language: ResolvedLanguage): Promise<string> {
  let memories = "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    memories = await invoke<string>("read_journal_memories");
  } catch {
    // memories.md がまだ存在しない場合は空
  }

  const trimmed = memories.trim();
  const guide = getJournalGuide(language);
  if (trimmed.length > 0) {
    return guide + getMemoriesHeader(language) + trimmed;
  }
  return guide;
}

/** App 初期化時に呼ぶ。 */
export function registerJournalFragment(): void {
  registerGlobalPromptFragment("journal", provideJournal);
}
