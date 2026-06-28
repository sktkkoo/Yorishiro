export interface ScreenAttentionDetection {
  readonly title: string | null;
  readonly body: string;
  readonly kind: "permission-prompt" | "agent-input";
}

const MAX_BODY_LENGTH = 180;

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

  if (isClaudePermissionPrompt(joined, lower)) {
    return {
      title: "Claude Code",
      body: compactBody(extractPromptBody(lines, joined)),
      kind: "permission-prompt",
    };
  }

  if (isCodexApprovalPrompt(joined, lower)) {
    return {
      title: "Codex",
      body: compactBody(extractPromptBody(lines, joined)),
      kind: "permission-prompt",
    };
  }

  if (isGenericPermissionPrompt(joined)) {
    return {
      title: "Agent",
      body: compactBody(extractPromptBody(lines, joined)),
      kind: "permission-prompt",
    };
  }

  return null;
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
