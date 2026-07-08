/**
 * Journal フラグメント。
 *
 * active persona の journal 行動指針と memories.md の内容を system prompt に注入する。
 */

import { invoke } from "@tauri-apps/api/core";
import type { ResolvedLanguage } from "../../runtime/language/language";
import { registerGlobalPromptFragment } from "./index";
import { getJournalGuide, getMemoriesHeader, getRecentJournalHeader } from "./prompts";

interface JournalEntry {
  date: string;
  content: string;
}

/** 常時注入する記憶の直近件数。全文注入はコンテキストを圧迫するだけなので選抜する。 */
const RECENT_MEMORY_COUNT = 5;
/** 直近分に加えて混ぜる古い記憶の件数。無作為に選び、記憶に濃淡を作る。 */
const OLDER_MEMORY_COUNT = 2;

/**
 * memories.md の行から常時注入分を選抜する。
 *
 * 直近 RECENT_MEMORY_COUNT 行 + それより古い行から無作為に OLDER_MEMORY_COUNT 行。
 * 古い記憶が入れ替わることで、全記憶を常時貼るのではなく「浮かんでいる記憶が
 * 違う」状態を作る。行内の書式は解釈しない（ユーザー手編集で壊れた行があっても
 * そのまま素通しし、落ちない）。
 *
 * 注意: collectGlobalPrompt は boot 時に一度だけ走るため（App.tsx の
 * userLayerReady は多重 spawn 回避のため一度しか resolve しない）、実際の
 * 入れ替わりはアプリ起動ごと。開きっぱなし運用での spawn ごと再収集は
 * journal callback P1（hook 基盤の再設計）と一緒に扱う。
 */
export function selectMemoryLines(lines: string[], random: () => number = Math.random): string[] {
  const valid = lines.map((line) => line.trim()).filter((line) => line.length > 0);
  if (valid.length <= RECENT_MEMORY_COUNT + OLDER_MEMORY_COUNT) {
    return valid;
  }
  const recent = valid.slice(-RECENT_MEMORY_COUNT);
  const olderPool = valid.slice(0, valid.length - RECENT_MEMORY_COUNT);
  // 部分 Fisher–Yates で重複なく OLDER_MEMORY_COUNT 件の index を選ぶ。
  const indices = olderPool.map((_, i) => i);
  for (let i = 0; i < OLDER_MEMORY_COUNT; i++) {
    const j = i + Math.min(indices.length - 1 - i, Math.floor(random() * (indices.length - i)));
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  const older = indices
    .slice(0, OLDER_MEMORY_COUNT)
    .sort((a, b) => a - b)
    .map((i) => olderPool[i]);
  return [...older, ...recent];
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
    recentEntries = await invoke<JournalEntry[]>("read_journal_recent", { days: 1 });
  } catch {
    // journal がまだない場合は空
  }

  let result = getJournalGuide(language);

  const selectedMemories = selectMemoryLines(memories.split("\n")).join("\n");
  if (selectedMemories.length > 0) {
    result += getMemoriesHeader(language) + selectedMemories;
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
