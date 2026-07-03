/**
 * command run の出力テキストから「住人と人間に渡す価値のある」問題点を検出する純関数
 * （Terminal Problems, command-blocks-design.md §14 P2）。file:line / URL / port /
 * test failure を metadata として拾う。secret を含む生 output 全文は返さず、検出した
 * 断片だけを返し、検出数は上限で bound してログ洪水でも膨らまない。
 * URL は origin までに縮約し、秘匿のため path / query / fragment / userinfo は格納しない。
 */
export type TerminalProblemType = "file" | "url" | "port" | "test-fail";

export interface TerminalProblem {
  readonly type: TerminalProblemType;
  readonly value: string;
}

const MAX_PROBLEMS = 20;
// 拡張子（英字 1-8）+ :line(:col) を要求。localhost:3000 のような拡張子なしは拾わない。
const FILE_RE = /\b[\w./-]+\.[a-zA-Z]{1,8}:\d+(?::\d+)?\b/g;
const URL_RE = /\bhttps?:\/\/[^\s)>"'`]+/g;
const PORT_RE = /\b(?:localhost|127\.0\.0\.1):\d{2,5}\b/g;
const TEST_FAIL_RE = /(?:\bFAIL(?:ED)?\b|✗)/;

export function detectTerminalProblems(text: string): ReadonlyArray<TerminalProblem> {
  const problems: TerminalProblem[] = [];
  const seen = new Set<string>();
  const push = (type: TerminalProblemType, value: string): void => {
    if (problems.length >= MAX_PROBLEMS) return;
    const key = `${type}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    problems.push({ type, value });
  };
  for (const match of text.matchAll(URL_RE)) {
    const origin = toUrlOrigin(match[0]);
    if (origin !== null) push("url", origin);
  }
  for (const match of text.matchAll(PORT_RE)) push("port", match[0]);
  for (const match of text.matchAll(FILE_RE)) push("file", match[0]);
  if (TEST_FAIL_RE.test(text)) push("test-fail", "test failure");
  return problems;
}

function toUrlOrigin(raw: string): string | null {
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}
