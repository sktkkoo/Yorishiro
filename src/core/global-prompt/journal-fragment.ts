/**
 * Journal フラグメント。
 *
 * journal の行動指針と memories.md の内容をグローバル system prompt に注入する。
 * どの persona であっても journal を書く。
 */

import { invoke } from "@tauri-apps/api/core";
import type { ResolvedLanguage } from "../../runtime/language/language";
import { registerGlobalPromptFragment } from "./index";
import { getJournalGuide, getMemoriesHeader, getRecentJournalHeader } from "./prompts";

interface JournalEntry {
  date: string;
  content: string;
}

async function provideJournal(language: ResolvedLanguage): Promise<string> {
  let memories = "";
  try {
    memories = await invoke<string>("read_journal_memories");
  } catch {
    // memories.md がまだ存在しない場合は空
  }

  let recentEntries: JournalEntry[] = [];
  try {
    recentEntries = await invoke<JournalEntry[]>("read_journal_recent", { days: 3 });
  } catch {
    // journal がまだない場合は空
  }

  let result = getJournalGuide(language);

  const trimmedMemories = memories.trim();
  if (trimmedMemories.length > 0) {
    result += getMemoriesHeader(language) + trimmedMemories;
  }

  if (recentEntries.length > 0) {
    const entries = recentEntries.map((e) => `${e.date}:\n${e.content.trim()}`).join("\n\n");
    result += getRecentJournalHeader(language) + entries;
  }

  return result;
}

/** App 初期化時に呼ぶ。 */
export function registerJournalFragment(): void {
  registerGlobalPromptFragment("journal", provideJournal);
}
