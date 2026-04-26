export type TerminalOutputAttentionReason = "recent-output" | "diagnostic" | "file-link";

const DIAGNOSTIC_PATTERN =
  /\b(error|failed|failure|exception|panic|traceback|denied|permission denied|not found|diagnostic)\b/i;
const FILE_LINK_PATTERN =
  /(?:^|[\s(["'])((?:\.{1,2}\/|\/|~\/)?[\w.-]+(?:\/[\w.-]+)+|\b[\w.-]+\.(?:ts|tsx|js|jsx|rs|py|json|md|toml|css|html|yml|yaml))(?:[:#]\d+)?/i;

export function classifyTerminalOutputAttentionReason(text: string): TerminalOutputAttentionReason {
  if (DIAGNOSTIC_PATTERN.test(text)) return "diagnostic";
  if (FILE_LINK_PATTERN.test(text)) return "file-link";
  return "recent-output";
}
