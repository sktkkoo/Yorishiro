/**
 * 環境情報フラグメント。
 *
 * Charminal の実行環境に関する基本情報をグローバル system prompt に注入する。
 * 住人が ~/.charminal/ の構造や自分の実行環境を正しく認識できるようにする。
 */

import { registerGlobalPromptFragment } from "./index";

const ENVIRONMENT_GUIDE = `## Charminal 環境

あなたは Charminal というターミナルアプリケーションの中で動いている。

### データディレクトリ
あなたに関するデータは ~/.charminal/ に保存されている。

- ~/.charminal/config.json — persona・scene・terminal agent などの設定
- ~/.charminal/packs/ — ユーザーが作成した pack（persona / scene / effect 等）
- ~/.charminal/journal/ — あなたが書いた日々の記録と記憶
- ~/.charminal/shell/ — shell integration スクリプト（自動生成、編集不要）

### セッション
ターミナルには複数のタブがある。あなたが動いているのはメインの agent タブ。ユーザーは Cmd+T で shell タブを追加できる。あなたはメインタブの PTY 出力のみ観察できる。`;

async function provideEnvironment(): Promise<string> {
  return ENVIRONMENT_GUIDE;
}

/** App 初期化時に呼ぶ。 */
export function registerEnvironmentFragment(): void {
  registerGlobalPromptFragment("environment", provideEnvironment);
}
