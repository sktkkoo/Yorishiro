export type TerminalOutputAttentionReason = "recent-output" | "diagnostic" | "file-link";

/**
 * diagnostic 語彙。agent 出力の error 系に加え、shell / CLI の代表的なエラー定型句
 * （No such file or directory / fatal: / Operation not permitted / Connection refused /
 * segmentation fault / core dumped）を含む。語彙は fixture / dogfooding で帰納的に育てる。
 */
const DIAGNOSTIC_PATTERN =
  /\b(error|failed|failure|exception|panic|traceback|denied|permission denied|not found|diagnostic|fatal|no such file or directory|operation not permitted|connection refused|segmentation fault|core dumped)\b/i;
/** 「0 failed」等のゼロ件サマリ。エラーが無いことの報告なので diagnostic の根拠から除く。 */
const ZERO_COUNT_PATTERN = /\b0\s+(?:failed|failures?|errors?)\b/gi;
/** エラー語彙を名前に含むだけのファイル名 token（error.log / failed_test.py 等）。 */
const ERRORISH_FILENAME_PATTERN = /\b[\w-]*(?:error|fail(?:ed|ure)?)[\w-]*\.[a-z0-9]{1,8}\b/gi;
const FILE_LINK_PATTERN =
  /(?:^|[\s(["'])((?:\.{1,2}\/|\/|~\/)?[\w.-]+(?:\/[\w.-]+)+|\b[\w.-]+\.(?:ts|tsx|js|jsx|rs|py|json|md|toml|css|html|yml|yaml))(?:[:#]\d+)?/i;

export function classifyTerminalOutputAttentionReason(text: string): TerminalOutputAttentionReason {
  // ゼロ件サマリとエラー風ファイル名を取り除いた残りで diagnostic を判定する。
  // これらを含む行でも、他に実エラー語彙が残っていれば diagnostic のまま。
  const diagnosticSource = text
    .replace(ZERO_COUNT_PATTERN, " ")
    .replace(ERRORISH_FILENAME_PATTERN, " ");
  if (DIAGNOSTIC_PATTERN.test(diagnosticSource)) return "diagnostic";
  if (FILE_LINK_PATTERN.test(text)) return "file-link";
  return "recent-output";
}
