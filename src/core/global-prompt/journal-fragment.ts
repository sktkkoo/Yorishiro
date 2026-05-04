/**
 * Journal memories フラグメント。
 *
 * ~/.charminal/journal/memories.md を読み取り、
 * グローバル system prompt に注入する。
 */

import { registerGlobalPromptFragment } from "./index";

const JOURNAL_PREAMBLE = `## Journal — あなたの記憶

以下はあなたがこれまでに書き残した記憶の断片（~/.charminal/journal/memories.md）。
印象に残ったことだけが記録されている。詳細を思い出したいときは journal_read MCP tool で該当日の journal を読み返すことができる。
journal_write MCP tool で新しい journal を書くとき、特に印象に残ったことがあれば summary パラメータを渡すとこの記憶に追記される。すべての日を記録する必要はない。覚えておきたいことだけ。

`;

async function provideJournalMemories(): Promise<string> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const memories = await invoke<string>("read_journal_memories");
    if (!memories || memories.trim().length === 0) return "";
    return JOURNAL_PREAMBLE + memories.trim();
  } catch {
    return "";
  }
}

/** App 初期化時に呼ぶ。 */
export function registerJournalFragment(): void {
  registerGlobalPromptFragment("journal-memories", provideJournalMemories);
}
