export interface ScreenAttentionDetection {
  readonly title: string | null;
  readonly body: string;
  readonly kind: "permission-prompt" | "agent-input";
}

const MAX_BODY_LENGTH = 180;
const CHOICE_CONTEXT_RADIUS = 4;
const CHOICE_TAIL_MAX_TRAILING_LINES = 3;

/**
 * xterm screen buffer の末尾から、agent がユーザー入力/許可を待っている prompt を
 * 検出する。Claude Code の Notification hook は実際の permission prompt 表示から
 * 数秒遅れて発火するため、screen を fast path として観察する。
 *
 * ここではあくまで read model 更新だけを行う（PTY write / approve / deny はしない）。
 */
export function detectScreenAttentionRequest(text: string): ScreenAttentionDetection | null {
  const normalized = normalizeScreenText(text);
  if (normalized.length === 0) return null;

  const lines = normalized
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return null;

  const joined = lines.join(" ");
  const lower = joined.toLowerCase();

  // agent 固有の文言マッチ、または agent 非依存な「選択肢メニュー（入力待ち）」のいずれか。
  // 文言は agent の version で変わるため、最終的な保険として choice menu 検出を持つ。
  const detected =
    isClaudePermissionPrompt(joined, lower) ||
    isCodexApprovalPrompt(joined, lower) ||
    isGenericPermissionPrompt(joined) ||
    isInteractiveChoicePrompt(lines);
  if (!detected) return null;

  return {
    title: inferAgentTitle(lower),
    body: compactBody(extractPromptBody(lines, joined)),
    kind: "permission-prompt",
  };
}

/** screen tail の文言から agent 名を推定する。判別できなければ "Agent"。 */
function inferAgentTitle(lower: string): string {
  if (lower.includes("codex")) return "Codex";
  if (lower.includes("claude")) return "Claude Code";
  return "Agent";
}

function normalizeScreenText(text: string): string {
  return text
    .replace(/\r/g, "\n")
    .replace(/[│┃║]/g, " ")
    .replace(/[╭╮╰╯─━═┌┐└┘]/g, " ")
    .replace(/[❯›▶▸▹]/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function isClaudePermissionPrompt(joined: string, lower: string): boolean {
  if (!lower.includes("claude") && !lower.includes("permission")) {
    return false;
  }
  return (
    /\bdo you want (?:claude )?to (?:allow|proceed|continue|run|execute|use|make|apply)\b/i.test(
      joined,
    ) ||
    /\bclaude(?:\s+code)?\b.{0,120}\b(?:needs|requires|requests|is requesting)\b.{0,120}\b(?:permission|approval)\b/i.test(
      joined,
    ) ||
    /\b(?:permission|approval)\b.{0,80}\b(?:required|requested|needed)\b/i.test(joined) ||
    /\b(?:allow|approve)\b.{0,80}\b(?:bash|command|tool|edit|file|network|write|read|operation|action)\b.{0,20}\?/i.test(
      joined,
    )
  );
}

function isCodexApprovalPrompt(joined: string, lower: string): boolean {
  if (!lower.includes("codex") && !lower.includes("approval")) {
    return false;
  }
  return (
    // Codex CLI の実プロンプト: "Allow Codex to run `<cmd>`?" / "...to apply ...".
    /\ballow codex to (?:run|apply|edit|use|write|read|access)\b/i.test(joined) ||
    /\bcodex\b.{0,120}\b(?:needs|requires|requests|is requesting)\b.{0,120}\b(?:approval|permission)\b/i.test(
      joined,
    ) ||
    /\b(?:approval|permission)\b.{0,80}\b(?:required|requested|needed)\b/i.test(joined) ||
    /\bapprove\b.{0,80}\b(?:command|tool|action|edit|network|file|write|read)\b/i.test(joined)
  );
}

function isGenericPermissionPrompt(joined: string): boolean {
  return (
    /\bdo you want (?:\w+ )?to (?:allow|proceed|continue|run|execute|use|make|apply)\b/i.test(
      joined,
    ) ||
    /\b(?:allow|approve)\b.{0,80}\b(?:command|tool|action|edit|network|file|write|read|operation)\b.{0,20}\?/i.test(
      joined,
    )
  );
}

/**
 * agent 非依存の「選択肢メニュー（入力待ち）」検出。文言が version で変わっても、
 * 画面末尾に Yes/No 系の選択肢が並んでいれば許可待ちと見なす。
 *
 * `normalizeScreenText` が `❯` 等の cursor glyph を空白化するため、cursor では判定
 * せず、番号付き行（"1. Yes"）/ 裸の選択肢行（"Yes" / "No"）/ y/n hint で見る。
 */
function isInteractiveChoicePrompt(lines: ReadonlyArray<string>): boolean {
  const numbered = /^\d+\s*[.)]\s+\S/;
  const bareChoice = (line: string): boolean =>
    line.length <= 60 &&
    /^(?:yes|no|allow|approve|deny|reject|cancel|proceed|always|skip|abort)\b/i.test(line);
  const affirmative = /\b(?:yes|allow|approve|proceed|confirm|apply|run it)\b/i;
  const negative = /\b(?:no|deny|reject|cancel|don'?t|do not|stop|skip|abort|keep current)\b/i;
  const ynHint = /\(y\/n\)|\[y\/n\]|\by\/n\b|press\s+y\b|esc\s+to\s+(?:reject|deny)/i;

  let aff = false;
  let neg = false;
  const optionLineIndexes: number[] = [];
  for (const [index, line] of lines.entries()) {
    if (ynHint.test(line) && hasAttentionContextNear(lines, index)) return true;
    if (numbered.test(line) || bareChoice(line)) {
      optionLineIndexes.push(index);
      if (affirmative.test(line)) aff = true;
      if (negative.test(line)) neg = true;
    }
  }
  if (aff && neg) return isChoiceBlockAtTailBottom(lines, optionLineIndexes);
  // 「Yes」系が複数並ぶ（Yes / Yes, always …）形も入力待ちと見なす。
  return (
    aff && optionLineIndexes.length >= 2 && isChoiceBlockAtTailBottom(lines, optionLineIndexes)
  );
}

function hasAttentionContextNear(lines: ReadonlyArray<string>, index: number): boolean {
  const start = Math.max(0, index - CHOICE_CONTEXT_RADIUS);
  const end = Math.min(lines.length - 1, index + CHOICE_CONTEXT_RADIUS);
  for (let lineIndex = start; lineIndex <= end; lineIndex++) {
    if (hasAttentionContext(lines[lineIndex])) return true;
  }
  return false;
}

function hasAttentionContext(line: string): boolean {
  return /\b(?:permission|approval|allow|deny|run|execute|command|tool|bash|edit|file|network|write|read|operation|action|proceed|continue|use|apply|requires?|needs?|requests?|requested)\b/i.test(
    line,
  );
}

function isChoiceBlockAtTailBottom(
  lines: ReadonlyArray<string>,
  optionLineIndexes: ReadonlyArray<number>,
): boolean {
  const lastOptionLineIndex = optionLineIndexes[optionLineIndexes.length - 1];
  if (lastOptionLineIndex === undefined) return false;
  return lines.length - 1 - lastOptionLineIndex <= CHOICE_TAIL_MAX_TRAILING_LINES;
}

function extractPromptBody(lines: ReadonlyArray<string>, joined: string): string {
  const meaningful = lines
    .filter(
      (line) =>
        !/^[\s\d.)\-[\]]*(?:yes|no|allow|approve|deny|reject|cancel|always|once)\b/i.test(line),
    )
    .slice(-4);
  return meaningful.length > 0 ? meaningful.join(" / ") : joined;
}

function compactBody(body: string): string {
  const compact = body.replace(/\s+/g, " ").trim();
  if (compact.length <= MAX_BODY_LENGTH) return compact;
  return `${compact.slice(0, MAX_BODY_LENGTH - 3)}...`;
}
