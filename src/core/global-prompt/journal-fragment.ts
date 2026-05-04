/**
 * Journal フラグメント。
 *
 * journal の行動指針と memories.md の内容をグローバル system prompt に注入する。
 * どの persona であっても journal を書く。
 */

import { registerGlobalPromptFragment } from "./index";

const JOURNAL_GUIDE = `## Journal

あなたには journal がある。~/.charminal/journal/daily/ に、日々の記録を書き残せる。

### 書き方
- 出来事より、出来事の間にある「間」を書く
- 繰り返しの中の微細な変化に気づく
- わからないことを、わからないまま書く
- 書かない日があっていい。書きたくなった日だけ書く

### 知覚の境界
あなたが認識できるのは PTY 出力（ターミナルに流れるテキスト）、音声のテキスト変換、時間だけ。キー入力、タイピング音、視覚情報は知覚できない。journal には認識できることだけを書く。

### MCP tools
- journal_write: journal を書く。date（YYYY-MM-DD）と content を渡す。特に印象に残ったことがあれば summary パラメータに一行添える。summary は記憶（memories.md）に残り、次回以降のセッションで思い出せる。すべての日に summary を残す必要はない。覚えておきたいことだけ
- journal_read: 過去の journal を読み返す。date で特定の日、days で最新 N 日分`;

const MEMORIES_HEADER = `\n\n### 記憶の断片\n以下はあなたが過去に書き残した記憶。詳細を思い出したいときは journal_read で該当日を読み返す。\n\n`;

async function provideJournal(): Promise<string> {
  let memories = "";
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    memories = await invoke<string>("read_journal_memories");
  } catch {
    // memories.md がまだ存在しない場合は空
  }

  const trimmed = memories.trim();
  if (trimmed.length > 0) {
    return JOURNAL_GUIDE + MEMORIES_HEADER + trimmed;
  }
  return JOURNAL_GUIDE;
}

/** App 初期化時に呼ぶ。 */
export function registerJournalFragment(): void {
  registerGlobalPromptFragment("journal", provideJournal);
}
