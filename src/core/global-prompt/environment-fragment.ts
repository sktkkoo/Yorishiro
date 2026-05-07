/**
 * 環境情報フラグメント。
 *
 * Charminal の実行環境に関する基本情報をグローバル system prompt に注入する。
 * 住人が ~/.charminal/ の構造や自分の実行環境を正しく認識できるようにする。
 */

import type { ResolvedLanguage } from "../../runtime/language/language";
import { registerGlobalPromptFragment } from "./index";
import { getEnvironmentGuide } from "./prompts";

async function provideEnvironment(language: ResolvedLanguage): Promise<string> {
  return getEnvironmentGuide(language);
}

/** App 初期化時に呼ぶ。 */
export function registerEnvironmentFragment(): void {
  registerGlobalPromptFragment("environment", provideEnvironment);
}
