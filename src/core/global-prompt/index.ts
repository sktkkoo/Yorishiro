/**
 * グローバル system prompt フラグメントの収集・結合。
 *
 * persona の systemPromptAddition とは独立に、Charminal 本体が
 * 常に注入したい指示（journal 行動指針など）を管理する。
 * 複数のフラグメントを登録でき、結合した文字列を返す。
 */

type FragmentProvider = () => Promise<string>;

const providers: Map<string, FragmentProvider> = new Map();

/** フラグメントを登録する。同じ key で再登録すると上書き。 */
export function registerGlobalPromptFragment(key: string, provider: FragmentProvider): void {
  providers.set(key, provider);
}

/**
 * 登録済みの全フラグメントを収集し、結合した文字列を返す。
 * 各フラグメントは `---` で区切られる。空のフラグメントは除外される。
 */
export async function collectGlobalPrompt(): Promise<string | null> {
  const fragments: string[] = [];

  for (const [key, provider] of providers) {
    try {
      const text = await provider();
      const trimmed = text.trim();
      if (trimmed.length > 0) {
        fragments.push(trimmed);
      }
    } catch (err) {
      console.warn(`[global-prompt] fragment "${key}" の取得に失敗:`, err);
    }
  }

  if (fragments.length === 0) return null;
  return fragments.join("\n\n---\n\n");
}

/**
 * persona の systemPromptAddition とグローバルフラグメントを結合する。
 * どちらも null/空なら null を返す。
 */
export async function buildSystemPrompt(personaAddition: string | null): Promise<string | null> {
  const global = await collectGlobalPrompt();
  const persona = personaAddition?.trim() || null;

  if (!global && !persona) return null;
  if (!global) return persona;
  if (!persona) return global;
  return `${persona}\n\n---\n\n${global}`;
}
